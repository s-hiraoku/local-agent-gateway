import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Type } from "typebox";
import type { GatewayConfig } from "../../infrastructure/config.js";
import { SecretBox } from "../../infrastructure/crypto.js";
import { GatewayError } from "../../domain/errors.js";
import { isTerminal, type PublicJob } from "../../domain/jobs.js";
import { canonicalJson } from "../../domain/structured-output.js";
import { GatewayStore } from "../../application/store.js";
import { JobProcessor } from "../../application/job-processor.js";
import {
  compatibilityIds,
  OPENAI_COMPATIBILITY_MODEL,
  responseObject,
  toInferencePrompt,
  type OpenAIResponseRequest
} from "./responses.js";

type OpenAIRouteDependencies = {
  config: GatewayConfig;
  store: GatewayStore;
  processor: JobProcessor;
};

export async function registerOpenAIResponsesRoutes(
  app: FastifyInstance,
  dependencies: OpenAIRouteDependencies
): Promise<void> {
  const { config, store, processor } = dependencies;
  const secrets = new SecretBox(config.encryptionKey);

  app.get("/v1/models", {
    schema: {
      summary: "List Local Agent Gateway compatibility models",
      response: {
        200: Type.Object({
          object: Type.Literal("list"),
          data: Type.Array(Type.Object({
            id: Type.Literal(OPENAI_COMPATIBILITY_MODEL),
            object: Type.Literal("model"),
            created: Type.Literal(0),
            owned_by: Type.Literal("local-agent-gateway")
          }))
        })
      }
    }
  }, async () => ({
    object: "list" as const,
    data: [{
      id: OPENAI_COMPATIBILITY_MODEL,
      object: "model" as const,
      created: 0 as const,
      owned_by: "local-agent-gateway" as const
    }]
  }));

  app.post("/v1/responses", {
    preValidation: async (request) => {
      const body = request.body && typeof request.body === "object"
        ? request.body as Record<string, unknown>
        : {};
      const allowed = new Set(["model", "input", "instructions", "stream"]);
      if (Object.keys(body).some((key) => !allowed.has(key))) {
        throw new GatewayError("INVALID_REQUEST", "Request contains unsupported fields", 400);
      }
    },
    schema: {
      summary: "Create a text response through the local Codex subscription",
      body: Type.Object({
        model: Type.Literal(OPENAI_COMPATIBILITY_MODEL),
        input: Type.String({ minLength: 1 }),
        instructions: Type.Optional(Type.String({ minLength: 1 })),
        stream: Type.Optional(Type.Boolean())
      }, { additionalProperties: false })
    }
  }, async (request, reply) => {
    const body = request.body as OpenAIResponseRequest;
    const prompt = toInferencePrompt(body);
    if (Buffer.byteLength(prompt) > config.maxPromptBytes) {
      throw new GatewayError("INVALID_REQUEST", "Input exceeds the configured byte limit", 400);
    }

    const idempotencyHeader = request.headers["idempotency-key"];
    if (idempotencyHeader !== undefined && typeof idempotencyHeader !== "string") {
      throw new GatewayError("INVALID_REQUEST", "Idempotency-Key must be a string", 400);
    }
    const idempotencyKey = idempotencyHeader ?? `openai-${randomUUID()}`;
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new GatewayError("INVALID_REQUEST", "Idempotency-Key must contain 8 to 128 characters", 400);
    }

    const submitted = await store.submitInference({
      ownerId: request.principalId,
      prompt,
      idempotencyKey,
      requestHash: secrets.digest(canonicalJson({
        version: 1,
        capability: "openai.responses",
        model: body.model,
        input: body.input,
        instructions: body.instructions ?? null
      })),
      maxQueuedJobs: config.maxQueuedJobs
    });
    processor.wake();

    if (body.stream) {
      await streamResponse(request.principalId, submitted.job, body, dependencies, secrets, reply);
      return;
    }

    let disconnected = false;
    const cancelOnClose = () => {
      disconnected = true;
      if (!reply.raw.writableEnded) void processor.cancel(request.principalId, submitted.job.id).catch(() => undefined);
    };
    reply.raw.once("close", cancelOnClose);
    try {
      const job = await waitForTerminalJob(
        request.principalId,
        submitted.job.id,
        store,
        processor,
        config.turnTimeoutMs + config.rpcTimeoutMs,
        () => disconnected
      );
      if (job.status === "completed") return responseObject(job, body, "completed", secrets);
      throw jobError(job);
    } finally {
      reply.raw.removeListener("close", cancelOnClose);
    }
  });
}

async function waitForTerminalJob(
  ownerId: string,
  jobId: string,
  store: GatewayStore,
  processor: JobProcessor,
  timeoutMs: number,
  disconnected: () => boolean
): Promise<PublicJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (disconnected()) {
      throw new GatewayError("CODEX_EXECUTION_FAILED", "The response client disconnected", 409);
    }
    const job = await store.getJob(ownerId, jobId);
    if (isTerminal(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await processor.cancel(ownerId, jobId).catch(() => undefined);
  throw new GatewayError("CODEX_TIMEOUT", "The Codex-backed response timed out", 504, true);
}

async function streamResponse(
  ownerId: string,
  initialJob: PublicJob,
  request: OpenAIResponseRequest,
  dependencies: OpenAIRouteDependencies,
  secrets: SecretBox,
  reply: FastifyReply
): Promise<void> {
  const { config, store, processor } = dependencies;
  let disconnected = false;
  let finished = false;
  const cancelOnClose = () => {
    disconnected = true;
    if (!finished) void processor.cancel(ownerId, initialJob.id).catch(() => undefined);
  };
  reply.raw.once("close", cancelOnClose);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });

  const { messageId } = compatibilityIds(initialJob.id, secrets);
  const response = responseObject(initialJob, request, "in_progress", secrets);
  const item = {
    id: messageId,
    type: "message",
    status: "in_progress",
    role: "assistant",
    content: []
  };
  await writeEvent(reply.raw, "response.created", { type: "response.created", response });
  await writeEvent(reply.raw, "response.in_progress", { type: "response.in_progress", response });
  await writeEvent(reply.raw, "response.output_item.added", {
    type: "response.output_item.added", output_index: 0, item
  });
  await writeEvent(reply.raw, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] }
  });

  const deadline = Date.now() + config.turnTimeoutMs + config.rpcTimeoutMs;
  const cancellationGraceMs = Math.min(config.rpcTimeoutMs, 5_000);
  let cursor = 0;
  let cancellationDeadline: number | undefined;
  while (!disconnected) {
    cursor = await drainAvailableDeltas(store, ownerId, initialJob.id, cursor, messageId, reply.raw);

    const job = await store.getJob(ownerId, initialJob.id);
    if (!isTerminal(job.status)) {
      const now = Date.now();
      if (cancellationDeadline === undefined && now >= deadline) {
        cancellationDeadline = now + cancellationGraceMs;
        await processor.cancel(ownerId, initialJob.id).catch(() => undefined);
      }
      if (cancellationDeadline !== undefined && now >= cancellationDeadline) {
        await writeEvent(reply.raw, "response.failed", {
          type: "response.failed", response: responseObject(asTimeoutJob(job), request, "failed", secrets)
        });
        finished = true;
        reply.raw.end();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }

    // The producer persists its final delta before the terminal job update.
    // Drain once more after observing that update so the stream cannot omit
    // text committed between the preceding event poll and this status read.
    cursor = await drainAvailableDeltas(store, ownerId, initialJob.id, cursor, messageId, reply.raw);

    if (cancellationDeadline !== undefined) {
      await writeEvent(reply.raw, "response.failed", {
        type: "response.failed", response: responseObject(asTimeoutJob(job), request, "failed", secrets)
      });
      finished = true;
      reply.raw.end();
      return;
    }

    if (job.status === "completed") {
      const text = job.result ?? "";
      const content = { type: "output_text", text, annotations: [] };
      const completedItem = { ...item, status: "completed", content: [content] };
      await writeEvent(reply.raw, "response.output_text.done", {
        type: "response.output_text.done",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text
      });
      await writeEvent(reply.raw, "response.content_part.done", {
        type: "response.content_part.done",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: content
      });
      await writeEvent(reply.raw, "response.output_item.done", {
        type: "response.output_item.done", output_index: 0, item: completedItem
      });
      await writeEvent(reply.raw, "response.completed", {
        type: "response.completed", response: responseObject(job, request, "completed", secrets)
      });
    } else {
      await writeEvent(reply.raw, "response.failed", {
        type: "response.failed", response: responseObject(job, request, "failed", secrets)
      });
    }
    finished = true;
    reply.raw.end();
    return;
  }
}

async function drainAvailableDeltas(
  store: GatewayStore,
  ownerId: string,
  jobId: string,
  cursor: number,
  messageId: string,
  target: ServerResponse
): Promise<number> {
  while (true) {
    const events = await store.events(ownerId, jobId, cursor);
    if (events.length === 0) return cursor;
    for (const event of events) {
      cursor = event.sequence;
      if (event.type !== "agent.message.delta") continue;
      const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
      if (typeof data.delta !== "string") continue;
      await writeEvent(target, "response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        delta: data.delta
      });
    }
  }
}

function asTimeoutJob(job: PublicJob): PublicJob {
  return {
    ...job,
    status: "failed",
    completedAt: new Date().toISOString(),
    error: {
      code: "CODEX_TIMEOUT",
      message: "The Codex-backed response timed out",
      retryable: true
    }
  };
}

async function writeEvent(
  target: ServerResponse,
  event: string,
  data: Record<string, unknown>
): Promise<void> {
  if (!target.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
    await once(target, "drain");
  }
}

function jobError(job: PublicJob): GatewayError {
  if (job.status === "cancelled") {
    return new GatewayError("CODEX_EXECUTION_FAILED", "The Codex-backed response was cancelled", 409);
  }
  const code = job.error?.code;
  const message = job.error?.message ?? "The Codex-backed response failed";
  const retryable = job.error?.retryable ?? false;
  switch (code) {
    case "CODEX_RATE_LIMITED":
      return new GatewayError("CODEX_RATE_LIMITED", message, 429, retryable);
    case "CODEX_UNAUTHORIZED":
      return new GatewayError("CODEX_UNAUTHORIZED", message, 503, retryable);
    case "CODEX_OVERLOADED":
      return new GatewayError("CODEX_OVERLOADED", message, 503, retryable);
    case "CODEX_TIMEOUT":
      return new GatewayError("CODEX_TIMEOUT", message, 504, retryable);
    default:
      return new GatewayError("CODEX_EXECUTION_FAILED", message, 502, retryable);
  }
}
