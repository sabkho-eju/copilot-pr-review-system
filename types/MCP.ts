/**
 * MCP (Model Context Protocol) types: the communication layer exposing tools
 * and resources to any compatible client.
 */
import type { Tool, ToolResult, ToolSchema } from "./Tool.js";

export type MCPTransportType = "stdio" | "http" | "websocket";

export interface MCPStdioTransport {
  type: "stdio";
}

export interface MCPHttpTransport {
  type: "http";
  port: number;
  host?: string;
}

export interface MCPWebSocketTransport {
  type: "websocket";
  url: string;
}

export type MCPTransport = MCPStdioTransport | MCPHttpTransport | MCPWebSocketTransport;

export interface MCPTransportConfig {
  /** Transport selected at runtime. */
  default: MCPTransportType;
  transports: MCPTransport[];
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
  /** Resolved textual contents, filled in when the resource is read. */
  contents?: string;
}

export interface MCPResourceDescriptor extends Omit<MCPResource, "contents"> {
  /** Path on disk backing the resource, when the resource is file based. */
  path?: string;
}

export interface MCPRequest {
  id: string | number;
  method: "tools/list" | "tools/call" | "resources/list" | "resources/read";
  params?: Record<string, unknown>;
}

export interface MCPResponse<TResult = unknown> {
  id: string | number;
  result?: TResult;
  error?: { code: number; message: string };
}

export interface MCPServer {
  readonly name: string;
  readonly version: string;
  readonly transport: MCPTransport;
  listTools(): ToolSchema[];
  callTool(name: string, params: Record<string, unknown>): Promise<ToolResult<unknown>>;
  listResources(): MCPResourceDescriptor[];
  readResource(uri: string): Promise<MCPResource>;
  registerTool(tool: Tool<Record<string, unknown>, unknown>): void;
  registerResource(resource: MCPResourceDescriptor): void;
}

export interface MCPClientConfig {
  serverName: string;
  transportType: MCPTransportType;
  serverPath: string;
  autoConnect: boolean;
  requestTimeoutMs: number;
}
