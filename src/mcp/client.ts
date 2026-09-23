import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isTerminal, type JobStatus } from "../domain/jobs.js";
import { gatewayHostname, type McpAdapterConfig } from "./config.js";

export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  })
};

export class InferenceTimeout extends Error {
  readonly code = "INFERENCE_TIMEOUT";

  constructor(
    readonly jobId: string,
    readonly status: JobStatus
  ) {
    super("Inference run did not finish before the MCP timeout");
    this.name = "InferenceTimeout";
  }
}

export type InferenceJobView = {
  id: string;
  conversationId: string;
  repositoryId: null;
  kind: "inference.turn";
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: string | null;
  structuredOutput: unknown;
  error: { code: string; message: string; retryable: boolean } | null;
};

export type RunInferenceInput = {
  prompt: string;
  outputSchema?: Record<string, unknown>;
  idempotencyKey: string;
};

const jobStatuses = {
  queued: true,
  running: true,
  completed: true,
  failed: true,
  cancelled: true
} as const satisfies Record<JobStatus, true>;

const jobIdPattern = /^job_[0-9a-f]{32}$/;
const conversationIdPattern = /^cnv_[0-9a-f]{32}$/;
const maxResponseBytes = 2_000_000;

export class GatewayInferenceClient {
  constructor(
    private readonly config: McpAdapterConfig,
    private readonly clock: Clock = systemClock
  ) {}

  async runInference(input: RunInferenceInput): Promise<InferenceJobView> {
    const accepted = await this.submit(input);
    const started = this.clock.now();
    let job = await this.getInferenceJob(accepted.jobId);
    while (!isTerminal(job.status)) {
      if (this.clock.now() - started >= this.config.timeoutMs) {
        throw new InferenceTimeout(job.id, job.status);
      }
      await this.clock.sleep(this.config.pollIntervalMs);
      job = await this.getInferenceJob(accepted.jobId);
    }
    return job;
  }

  async getInferenceJob(jobId: string): Promise<InferenceJobView> {
    if (!jobIdPattern.test(jobId)) {
      throw new Error("jobId must be a Gateway inference job id");
    }
    const response = await this.request("GET", `/v2/jobs/${jobId}`);
    if (response.status !== 200) {
      throw gatewayFailure(response.status, response.body, this.config.token);
    }
    return parseInferenceJob(response.body);
  }

  private async submit(input: RunInferenceInput): Promise<{ jobId: string }> {
    const body: { prompt: string; outputSchema?: Record<string, unknown> } = {
      prompt: input.prompt
    };
    if (input.outputSchema !== undefined) {
      body.outputSchema = input.outputSchema;
    }
    const response = await this.request("POST", "/v2/inference/runs", {
      idempotencyKey: input.idempotencyKey,
      json: JSON.stringify(body)
    });
    if (response.status !== 202) {
      throw gatewayFailure(response.status, response.body, this.config.token);
    }
    let accepted: unknown;
    try {
      accepted = JSON.parse(response.body);
    } catch {
      throw new Error("Gateway accept response was not JSON");
    }
    if (!isRecord(accepted) || typeof accepted.jobId !== "string" || !jobIdPattern.test(accepted.jobId)) {
      throw new Error("Gateway accept response job id was invalid");
    }
    return { jobId: accepted.jobId };
  }

  private request(
    method: "GET" | "POST",
    path: string,
    body?: { idempotencyKey: string; json: string }
  ): Promise<{ status: number; body: string }> {
    if (!isAllowedPath(path)) {
      throw new Error("MCP adapter refused a non-inference Gateway path");
    }
    const payload = body === undefined ? undefined : Buffer.from(body.json, "utf8");
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.config.token}`
    };
    if (payload && body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.byteLength);
      headers["Idempotency-Key"] = body.idempotencyKey;
    }
    const options: RequestOptions = {
      protocol: this.config.origin.protocol,
      hostname: gatewayHostname(this.config.origin),
      path,
      method,
      headers,
      timeout: 30_000
    };
    if (this.config.origin.port !== "") {
      options.port = Number(this.config.origin.port);
    }
    const send = this.config.origin.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = send(options, (res) => {
        readLimited(res, maxResponseBytes).then((raw) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            reject(new Error("Gateway redirect was refused"));
            return;
          }
          resolve({ status, body: raw });
        }).catch(reject);
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Gateway request timed out"));
      });
      req.on("error", () => {
        reject(new Error("Gateway request failed"));
      });
      req.end(payload);
    });
  }
}

function isAllowedPath(path: string): boolean {
  if (path === "/v2/inference/runs") return true;
  const prefix = "/v2/jobs/";
  return path.startsWith(prefix) && jobIdPattern.test(path.slice(prefix.length));
}

function readLimited(res: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        res.destroy();
        reject(new Error("Gateway response exceeded 2000000 bytes"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    res.on("error", () => {
      reject(new Error("Gateway request failed"));
    });
  });
}

function gatewayFailure(status: number, raw: string, token: string): Error {
  let text = `Gateway request failed with HTTP ${status}`;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      isRecord(parsed)
      && isRecord(parsed.error)
      && typeof parsed.error.code === "string"
      && typeof parsed.error.message === "string"
    ) {
      text = `${parsed.error.code}: ${parsed.error.message}`;
    }
  } catch {
    text = `Gateway request failed with HTTP ${status}`;
  }
  if (text.includes(token)) {
    return new Error(`Gateway request failed with HTTP ${status}`);
  }
  return new Error(text);
}

function parseInferenceJob(raw: string): InferenceJobView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Gateway job response was not JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("Gateway job response was not an object");
  }
  if (parsed.kind !== "inference.turn" || parsed.repositoryId !== null) {
    throw new Error("Gateway returned a non-inference job");
  }
  if (typeof parsed.id !== "string" || !jobIdPattern.test(parsed.id)) {
    throw new Error("Gateway job id was invalid");
  }
  if (typeof parsed.conversationId !== "string" || !conversationIdPattern.test(parsed.conversationId)) {
    throw new Error("Gateway conversation id was invalid");
  }
  if (typeof parsed.status !== "string" || !isJobStatus(parsed.status)) {
    throw new Error("Gateway job status was not recognized");
  }
  return {
    id: parsed.id,
    conversationId: parsed.conversationId,
    repositoryId: null,
    kind: "inference.turn",
    status: parsed.status,
    createdAt: requiredString(parsed.createdAt, "createdAt"),
    startedAt: nullableString(parsed.startedAt, "startedAt"),
    completedAt: nullableString(parsed.completedAt, "completedAt"),
    result: nullableString(parsed.result, "result"),
    structuredOutput: parsed.structuredOutput ?? null,
    error: parseJobError(parsed.error)
  };
}

function isJobStatus(value: string): value is JobStatus {
  return Object.hasOwn(jobStatuses, value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Gateway job ${field} was invalid`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function parseJobError(value: unknown): InferenceJobView["error"] {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string" || typeof value.retryable !== "boolean") {
    throw new Error("Gateway job error was invalid");
  }
  return { code: value.code, message: value.message, retryable: value.retryable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
