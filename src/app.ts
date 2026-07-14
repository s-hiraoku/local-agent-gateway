import { once } from "node:events";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { Type } from "typebox";
import { GatewayError, normalizeError } from "./domain/errors.js";
import { isTerminal } from "./domain/jobs.js";
import type { GatewayConfig } from "./infrastructure/config.js";
import { secureTokenEqual, SecretBox } from "./infrastructure/crypto.js";
import { GatewayStore } from "./application/store.js";
import { JobProcessor, requireRepository } from "./application/job-processor.js";

declare module "fastify" {
  interface FastifyRequest {
    principalId: string;
  }
}

export type AppDependencies = {
  config: GatewayConfig;
  store: GatewayStore;
  processor: JobProcessor;
  closeDatabase: () => Promise<void>;
  startProcessor?: boolean;
};

const ErrorSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    retryable: Type.Boolean()
  })
});

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, store, processor } = dependencies;
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie"],
        censor: "[REDACTED]"
      }
    },
    bodyLimit: config.maxPromptBytes + 16 * 1024,
    requestIdHeader: "x-request-id",
    logController: new LogController({ disableRequestLogging: true })
  });
  app.decorateRequest("principalId", "");

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Local Agent Gateway", version: "2.0.0" },
      servers: [{ url: `http://${config.host}:${config.port}` }]
    }
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/v2/")) return;
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new GatewayError("AUTH_REQUIRED", "Bearer authentication is required", 401);
    }
    if (!secureTokenEqual(authorization.slice(7), config.apiToken)) {
      throw new GatewayError("AUTH_REQUIRED", "Bearer token is invalid", 401);
    }
    request.principalId = "owner";
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
    const normalized = error instanceof GatewayError
      ? error
      : error && typeof error === "object" && "validation" in error
        ? new GatewayError("INVALID_REQUEST", "Request validation failed", 400)
        : statusCode && statusCode >= 400 && statusCode < 500
          ? new GatewayError(
              statusCode === 404 ? "NOT_FOUND" : "INVALID_REQUEST",
              statusCode === 404 ? "Resource not found" : "Request could not be accepted",
              statusCode
            )
          : normalizeError(error);
    if (normalized.code === "INTERNAL_ERROR") {
      request.log.error({ err: error }, "gateway request failed");
    }
    void reply.status(normalized.statusCode).send({
      error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable }
    });
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({
      error: { code: "NOT_FOUND", message: "Resource not found", retryable: false }
    });
  });

  app.get("/healthz", {
    schema: { response: { 200: Type.Object({ status: Type.Literal("ok"), version: Type.Literal("2.0.0") }) } }
  }, async () => ({ status: "ok" as const, version: "2.0.0" as const }));

  app.get("/readyz", {
    schema: { response: { 200: Type.Object({ status: Type.Literal("ready") }), 503: ErrorSchema } }
  }, async () => {
    try {
      await store.isReady();
      if (!processor.isReady()) throw new Error("Job processor is not ready");
      return { status: "ready" as const };
    } catch {
      throw new GatewayError("INTERNAL_ERROR", "Gateway storage is not ready", 503, true);
    }
  });

  app.get("/v2/capabilities", async () => ({
    capabilities: [{ id: "coding.turn", enabled: true, modes: ["read-only"] }]
  }));

  app.get("/v2/repositories", async () => ({
    repositories: [...config.repositories.values()].map((repository) => ({ id: repository.id }))
  }));

  app.post("/v2/conversations", {
    schema: {
      body: Type.Object({ repositoryId: Type.String({ minLength: 1, maxLength: 64 }) }),
      response: {
        201: Type.Object({ id: Type.String(), repositoryId: Type.String(), createdAt: Type.String() }),
        401: ErrorSchema,
        404: ErrorSchema
      }
    }
  }, async (request, reply) => {
    const body = request.body as { repositoryId: string };
    requireRepository(config.repositories, body.repositoryId);
    const conversation = await store.createConversation(request.principalId, body.repositoryId);
    return reply.status(201).send(conversation);
  });

  app.post("/v2/conversations/:conversationId/turns", {
    schema: {
      params: Type.Object({ conversationId: Type.String({ minLength: 1, maxLength: 80 }) }),
      headers: Type.Object({
        "idempotency-key": Type.String({ minLength: 8, maxLength: 128 })
      }, { additionalProperties: true }),
      body: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: config.maxPromptBytes }) }),
      response: {
        202: Type.Object({ jobId: Type.String(), status: Type.String(), replayed: Type.Boolean() }),
        401: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        429: ErrorSchema
      }
    }
  }, async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const { prompt } = request.body as { prompt: string };
    if (Buffer.byteLength(prompt) > config.maxPromptBytes) {
      throw new GatewayError("INVALID_REQUEST", "Prompt exceeds the configured byte limit", 400);
    }
    const conversation = await store.getConversation(request.principalId, conversationId);
    if (!conversation) throw new GatewayError("NOT_FOUND", "Conversation not found", 404);
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string") {
      throw new GatewayError("INVALID_REQUEST", "Idempotency-Key is required", 400);
    }
    const secretBox = new SecretBox(config.encryptionKey);
    const submitted = await store.submitTurn({
      ownerId: request.principalId,
      conversationId,
      repositoryId: conversation.repositoryId,
      prompt,
      idempotencyKey,
      requestHash: secretBox.digest(JSON.stringify({ conversationId, prompt })),
      maxQueuedJobs: config.maxQueuedJobs
    });
    processor.wake();
    return reply.status(202).send({
      jobId: submitted.job.id,
      status: submitted.job.status,
      replayed: submitted.replayed
    });
  });

  app.get("/v2/jobs/:jobId", {
    schema: {
      params: Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 80 }) }),
      response: { 401: ErrorSchema, 404: ErrorSchema }
    }
  }, async (request) => {
    const { jobId } = request.params as { jobId: string };
    return store.getJob(request.principalId, jobId);
  });

  app.post("/v2/jobs/:jobId/cancel", {
    schema: {
      params: Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 80 }) }),
      response: { 202: Type.Object({ jobId: Type.String(), cancellationRequested: Type.Boolean() }), 409: ErrorSchema }
    }
  }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    await processor.cancel(request.principalId, jobId);
    return reply.status(202).send({ jobId, cancellationRequested: true });
  });

  app.get("/v2/jobs/:jobId/events", {
    schema: { params: Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 80 }) }) }
  }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    await store.getJob(request.principalId, jobId);
    const lastEventId = request.headers["last-event-id"];
    let cursor = typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number(lastEventId) : 0;
    let closed = false;
    request.raw.once("close", () => { closed = true; });
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    let heartbeatAt = Date.now();
    while (!closed) {
      const events = await store.events(request.principalId, jobId, cursor);
      for (const event of events) {
        cursor = event.sequence;
        const payload = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        if (!reply.raw.write(payload)) await once(reply.raw, "drain");
      }
      const job = await store.getJob(request.principalId, jobId);
      if (isTerminal(job.status) && events.length === 0) break;
      if (Date.now() - heartbeatAt >= 15_000) {
        reply.raw.write(": heartbeat\n\n");
        heartbeatAt = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    reply.raw.end();
  });

  app.addHook("onReady", async () => {
    if (dependencies.startProcessor !== false) await processor.start();
  });
  app.addHook("onClose", async () => {
    if (dependencies.startProcessor !== false) await processor.stop();
    await dependencies.closeDatabase();
  });
  return app;
}
