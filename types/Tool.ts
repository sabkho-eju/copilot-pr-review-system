/**
 * Tool types: a tool is a callable function performing one concrete action.
 */

export type ToolParameterType = "string" | "number" | "boolean" | "object" | "array";

export interface ToolParameter {
  name: string;
  type: ToolParameterType;
  required: boolean;
  description: string;
}

export interface ToolResultMetadata {
  /** Duration of the call in milliseconds. */
  durationMs?: number;
  /** Whether the payload came from a cache instead of a live call. */
  cached?: boolean;
  /** Remaining GitHub API rate-limit budget, when known. */
  rateLimitRemaining?: number;
  source?: string;
}

export interface ToolResult<TData = unknown> {
  success: boolean;
  data: TData | null;
  error?: string;
  metadata: ToolResultMetadata;
}

export interface Tool<TInput extends Record<string, unknown> = Record<string, unknown>, TData = unknown> {
  name: string;
  description: string;
  parameters: ToolParameter[];
  execute(input: TInput): Promise<ToolResult<TData>>;
}

/** JSON-schema style description of a tool, as exposed over MCP. */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: ToolParameterType; description?: string }>;
    required: string[];
  };
}

export function toolSchemaFrom(tool: Pick<Tool, "name" | "description" | "parameters">): ToolSchema {
  const properties: ToolSchema["inputSchema"]["properties"] = {};
  const required: string[] = [];

  for (const parameter of tool.parameters) {
    properties[parameter.name] = { type: parameter.type, description: parameter.description };
    if (parameter.required) {
      required.push(parameter.name);
    }
  }

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { type: "object", properties, required }
  };
}

export function ok<TData>(data: TData, metadata: ToolResultMetadata = {}): ToolResult<TData> {
  return { success: true, data, metadata };
}

export function fail<TData = never>(error: string, metadata: ToolResultMetadata = {}): ToolResult<TData> {
  return { success: false, data: null, error, metadata };
}
