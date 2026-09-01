/**
 * MCP server: exposes the PR review tools and the markdown skills/instructions
 * as MCP resources, over a transport selected in `mcp/transport-config.json`.
 *
 * The JSON-RPC framing is intentionally minimal (newline delimited JSON) so the
 * scaffold stays dependency free; swap `bootstrapTransport` for the official
 * MCP SDK transport when wiring a real client.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { fail, toolSchemaFrom, type Tool, type ToolResult, type ToolSchema } from "../types/Tool.js";
import type {
  MCPRequest,
  MCPResource,
  MCPResourceDescriptor,
  MCPResponse,
  MCPServer,
  MCPTransport,
  MCPTransportConfig
} from "../types/MCP.js";
import { fromProjectRoot, projectRoot } from "../tools/paths.js";
import { githubTools } from "../tools/github-tools.js";
import { fileTools } from "../tools/file-tools.js";
import { analysisTools } from "../tools/analysis-tools.js";

const repoRoot = projectRoot;

/** Every tool exposed by this server, grouped by domain. */
export const toolRegistry: Array<Tool<Record<string, unknown>, unknown>> = [
  ...githubTools,
  ...fileTools,
  ...analysisTools
];

interface ResourcesFile {
  resources: MCPResourceDescriptor[];
}

export async function loadResourceRegistry(): Promise<MCPResourceDescriptor[]> {
  const raw = await readFile(fromProjectRoot("mcp", "resources-mcp.json"), "utf8");
  return (JSON.parse(raw) as ResourcesFile).resources;
}

export async function loadTransportConfig(): Promise<MCPTransportConfig> {
  const raw = await readFile(fromProjectRoot("mcp", "transport-config.json"), "utf8");
  return JSON.parse(raw) as MCPTransportConfig;
}

export class PullRequestReviewMCPServer implements MCPServer {
  readonly name: string;
  readonly version: string;
  readonly transport: MCPTransport;

  private readonly tools = new Map<string, Tool<Record<string, unknown>, unknown>>();
  private readonly resources = new Map<string, MCPResourceDescriptor>();

  constructor(options: {
    name?: string;
    version?: string;
    transport: MCPTransport;
    tools?: Array<Tool<Record<string, unknown>, unknown>>;
    resources?: MCPResourceDescriptor[];
  }) {
    this.name = options.name ?? "copilot-pr-review";
    this.version = options.version ?? "0.1.0";
    this.transport = options.transport;
    for (const tool of options.tools ?? []) {
      this.registerTool(tool);
    }
    for (const resource of options.resources ?? []) {
      this.registerResource(resource);
    }
  }

  registerTool(tool: Tool<Record<string, unknown>, unknown>): void {
    this.tools.set(tool.name, tool);
  }

  registerResource(resource: MCPResourceDescriptor): void {
    this.resources.set(resource.uri, resource);
  }

  listTools(): ToolSchema[] {
    return [...this.tools.values()].map((tool) => toolSchemaFrom(tool));
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<ToolResult<unknown>> {
    const tool = this.tools.get(name);
    if (!tool) {
      return fail(`unknown tool: ${name}`);
    }

    const missing = tool.parameters
      .filter((parameter) => parameter.required && params[parameter.name] === undefined)
      .map((parameter) => parameter.name);
    if (missing.length > 0) {
      return fail(`missing required parameter(s) for ${name}: ${missing.join(", ")}`);
    }

    try {
      return await tool.execute(params);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  listResources(): MCPResourceDescriptor[] {
    return [...this.resources.values()];
  }

  async readResource(uri: string): Promise<MCPResource> {
    const descriptor = this.resources.get(uri);
    if (!descriptor) {
      throw new Error(`unknown resource: ${uri}`);
    }
    if (!descriptor.path) {
      throw new Error(`resource ${uri} has no backing file`);
    }

    // Guard against path traversal coming from the resource registry.
    const resolved = path.resolve(repoRoot, descriptor.path);
    if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) {
      throw new Error(`resource ${uri} points outside of the repository`);
    }

    return { ...descriptor, contents: await readFile(resolved, "utf8") };
  }

  /** Routes a single MCP request to the matching handler. */
  async handleRequest(request: MCPRequest): Promise<MCPResponse> {
    try {
      switch (request.method) {
        case "tools/list":
          return { id: request.id, result: { tools: this.listTools() } };
        case "tools/call": {
          const params = request.params ?? {};
          const result = await this.callTool(
            String(params["name"]),
            (params["arguments"] as Record<string, unknown> | undefined) ?? {}
          );
          return { id: request.id, result };
        }
        case "resources/list":
          return { id: request.id, result: { resources: this.listResources() } };
        case "resources/read": {
          const uri = String((request.params ?? {})["uri"]);
          return { id: request.id, result: await this.readResource(uri) };
        }
        default:
          return { id: request.id, error: { code: -32601, message: `unknown method: ${String(request.method)}` } };
      }
    } catch (error) {
      return {
        id: request.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) }
      };
    }
  }
}

/** Starts the server on the configured transport. Returns a stop function. */
export async function bootstrapTransport(server: PullRequestReviewMCPServer): Promise<() => void> {
  switch (server.transport.type) {
    case "stdio": {
      const readline = createInterface({ input: process.stdin });
      readline.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          return;
        }
        void (async () => {
          let response: MCPResponse;
          try {
            response = await server.handleRequest(JSON.parse(trimmed) as MCPRequest);
          } catch (error) {
            response = {
              id: 0,
              error: { code: -32700, message: error instanceof Error ? error.message : "parse error" }
            };
          }
          process.stdout.write(`${JSON.stringify(response)}\n`);
        })();
      });
      return () => readline.close();
    }

    case "http": {
      const httpServer = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          void (async () => {
            let payload: MCPResponse;
            try {
              payload = await server.handleRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")) as MCPRequest);
            } catch (error) {
              payload = {
                id: 0,
                error: { code: -32700, message: error instanceof Error ? error.message : "parse error" }
              };
            }
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(payload));
          })();
        });
      });
      httpServer.listen(server.transport.port, server.transport.host ?? "127.0.0.1");
      return () => httpServer.close();
    }

    case "websocket":
      // TODO: plug a WebSocket implementation (e.g. the `ws` package) here.
      throw new Error("the websocket transport is not implemented in this scaffold");
  }
}

/** Builds a server instance from the JSON registries shipped in `mcp/`. */
export async function createPullRequestReviewMCPServer(): Promise<PullRequestReviewMCPServer> {
  const [transportConfig, resources] = await Promise.all([loadTransportConfig(), loadResourceRegistry()]);
  const transport =
    transportConfig.transports.find((candidate) => candidate.type === transportConfig.default) ??
    ({ type: "stdio" } as MCPTransport);

  return new PullRequestReviewMCPServer({ transport, tools: toolRegistry, resources });
}

/** Small helper used by the agent to call a tool without a transport round-trip. */
export async function callToolLocally(
  name: string,
  params: Record<string, unknown>
): Promise<ToolResult<unknown>> {
  const tool = toolRegistry.find((candidate) => candidate.name === name);
  if (!tool) {
    return fail(`unknown tool: ${name}`);
  }
  return tool.execute(params);
}

const isEntryPoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const server = await createPullRequestReviewMCPServer();
  await bootstrapTransport(server);
  process.stderr.write(`[mcp] ${server.name} ready on ${server.transport.type}\n`);
}
