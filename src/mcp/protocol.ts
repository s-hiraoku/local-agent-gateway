import { randomBytes } from "node:crypto";
import { InferenceTimeout, type GatewayInferenceClient, type InferenceJobView } from "./client.js";

export const mcpProtocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

const serverInfo = { name: "local-agent-gateway", version: "2.0.0" };

const runInferenceTool = {
  name: "run_inference",
  description: "Submit a repository-free inference run to the local Gateway and wait until the job finishes. The Gateway process selects the backend with CODEXGW_INFERENCE_PROVIDER. Set that variable to claude before starting the Gateway to run Claude Code. This tool does not accept a working directory, a provider, an upstream API key, or a coding turn.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      prompt: { type: "string", minLength: 1 },
      outputSchema: { type: "object" },
      idempotencyKey: { type: "string", minLength: 8, maxLength: 128 }
    },
    required: ["prompt"]
  }
} as const;

const getInferenceJobTool = {
  name: "get_inference_job",
  description: "Read one inference job from the local Gateway by job id. Use this after run_inference reports INFERENCE_TIMEOUT.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      jobId: { type: "string", pattern: "^job_[0-9a-f]{32}$" }
    },
    required: ["jobId"]
  }
} as const;

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

export type RpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export async function dispatchMcpMessage(message: unknown, client: GatewayInferenceClient): Promise<RpcResponse | null> {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return {
      jsonrpc: "2.0",
      id: idOf(message),
      error: { code: -32600, message: "Invalid Request" }
    };
  }
  const id = message.id;
  const isRequest = typeof id === "string" || typeof id === "number";
  if (!isRequest) {
    if (id !== undefined) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" }
      };
    }
    return null;
  }
  try {
    const result = await dispatchRequest(message.method, message.params, client);
    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    if (error instanceof ToolFailure) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: error.message }],
          isError: true
        }
      };
    }
    if (error instanceof RpcMethodError) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" }
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: "Internal error" }
    };
  }
}

async function dispatchRequest(method: string, params: unknown, client: GatewayInferenceClient): Promise<unknown> {
  if (method === "initialize") {
    return initializeResult(params);
  }
  if (method === "ping") {
    return {};
  }
  if (method === "tools/list") {
    return { tools: [runInferenceTool, getInferenceJobTool] };
  }
  if (method === "tools/call") {
    return callTool(params, client);
  }
  throw new RpcMethodError();
}

function initializeResult(params: unknown): unknown {
  const requested = isRecord(params) && typeof params.protocolVersion === "string"
    ? params.protocolVersion
    : undefined;
  const protocolVersion = mcpProtocolVersions.find((version) => version === requested) ?? mcpProtocolVersions[0];
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo,
    instructions: "Calls the local Gateway inference API only. Coding turns stay on Codex inside the Gateway and are not available here. To run Claude Code, start the Gateway with CODEXGW_INFERENCE_PROVIDER=claude."
  };
}

async function callTool(params: unknown, client: GatewayInferenceClient): Promise<unknown> {
  if (!isRecord(params) || typeof params.name !== "string") {
    throw new ToolFailure("Tool name is required");
  }
  const args = params.arguments === undefined ? {} : params.arguments;
  if (!isRecord(args)) {
    throw new ToolFailure("Tool arguments must be an object");
  }
  try {
    if (params.name === "run_inference") {
      const job = await client.runInference({
        prompt: requiredPrompt(args.prompt),
        ...optionalOutputSchema(args.outputSchema),
        idempotencyKey: optionalIdempotencyKey(args.idempotencyKey)
      });
      return toolResult(job);
    }
    if (params.name === "get_inference_job") {
      if (typeof args.jobId !== "string") {
        throw new ToolFailure("jobId is required");
      }
      const job = await client.getInferenceJob(args.jobId);
      return toolResult(job);
    }
    throw new ToolFailure("Unknown tool");
  } catch (error) {
    if (error instanceof ToolFailure) throw error;
    if (error instanceof InferenceTimeout) {
      throw new ToolFailure(JSON.stringify({
        code: error.code,
        message: error.message,
        jobId: error.jobId,
        status: error.status
      }));
    }
    throw new ToolFailure(error instanceof Error ? error.message : "Internal error");
  }
}

function toolResult(job: InferenceJobView): unknown {
  const text = JSON.stringify(job);
  if (job.status === "completed") {
    return { content: [{ type: "text", text }] };
  }
  return { content: [{ type: "text", text }], isError: true };
}

function requiredPrompt(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolFailure("prompt is required");
  }
  return value;
}

function optionalOutputSchema(value: unknown): { outputSchema?: Record<string, unknown> } {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new ToolFailure("outputSchema must be an object");
  }
  return { outputSchema: value };
}

function optionalIdempotencyKey(value: unknown): string {
  if (value === undefined) return randomBytes(16).toString("hex");
  if (typeof value !== "string" || !idempotencyKeyPattern.test(value)) {
    throw new ToolFailure("idempotencyKey must be 8 to 128 characters from [A-Za-z0-9._:-]");
  }
  return value;
}

class ToolFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolFailure";
  }
}

class RpcMethodError extends Error {
  constructor() {
    super("Method not found");
    this.name = "RpcMethodError";
  }
}

function idOf(message: unknown): string | number | null {
  if (isRecord(message) && (typeof message.id === "string" || typeof message.id === "number")) {
    return message.id;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeMcpMessage(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${json.byteLength}\r\n\r\n`, "utf8"),
    json
  ]);
}

export type DecodedFrame = { ok: true; message: unknown } | { ok: false };

export class McpFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: DecodedFrame[] = [];
    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (this.buffer.byteLength > 65_536) {
          throw new Error("MCP header is too large");
        }
        return frames;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const length = contentLength(header);
      const start = headerEnd + 4;
      if (this.buffer.byteLength < start + length) return frames;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = Buffer.from(this.buffer.subarray(start + length));
      try {
        frames.push({ ok: true, message: JSON.parse(body) as unknown });
      } catch {
        frames.push({ ok: false });
      }
    }
    return frames;
  }
}

function contentLength(header: string): number {
  let length: number | undefined;
  for (const line of header.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    if (name !== "content-length") continue;
    length = Number(line.slice(separator + 1).trim());
  }
  if (length === undefined || !Number.isSafeInteger(length) || length < 2 || length > 2_000_000) {
    throw new Error("MCP Content-Length is invalid");
  }
  return length;
}
