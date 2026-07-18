import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { CodingRunner } from "../src/adapters/codex/runner.js";
import { JobProcessor } from "../src/application/job-processor.js";
import { GatewayStore } from "../src/application/store.js";
import { SecretBox } from "../src/infrastructure/crypto.js";
import { openDatabase } from "../src/infrastructure/database.js";
import { authorization, testConfig } from "./helpers.js";

const apps: FastifyInstance[] = [];
const inferenceRoots: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of inferenceRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function testApp(runner?: CodingRunner, maxQueuedJobs = 10) {
  const inferenceWorkspaceRoot = mkdtempSync(join(tmpdir(), "codexgw-inference-root-"));
  inferenceRoots.push(inferenceWorkspaceRoot);
  const config = testConfig({ maxQueuedJobs, inferenceWorkspaceRoot });
  const database = openDatabase(":memory:");
  const store = new GatewayStore(database.db, new SecretBox(config.encryptionKey));
  const resolvedRunner: CodingRunner = runner ?? {
    async run(input) {
      await input.onEvent({ type: "agent.message.delta", data: { delta: "done" } });
      return { backendThreadId: input.backendThreadId ?? "internal-thread-id", result: "done" };
    }
  };
  const processor = new JobProcessor(store, resolvedRunner, config.repositories, config.maxConcurrentJobs, config.inferenceWorkspaceRoot);
  const app = await buildApp({ config, store, processor, closeDatabase: database.close });
  apps.push(app);
  await app.ready();
  return { app, store, database };
}

async function createConversation(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v2/conversations",
    headers: authorization,
    payload: { repositoryId: "gateway" }
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

async function waitForCompletion(app: FastifyInstance, jobId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/v2/jobs/${jobId}`, headers: authorization });
    const job = response.json();
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not complete");
}

describe("V2 API", () => {
  const reviewSchema = {
    type: "object",
    properties: { verdict: { type: "string", enum: ["accept", "revise", "reject"] } },
    required: ["verdict"],
    additionalProperties: false
  };

  it("requires authentication and never returns repository paths", async () => {
    const { app } = await testApp();
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v2/repositories" })).statusCode).toBe(401);
    const response = await app.inject({ method: "GET", url: "/v2/repositories", headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(process.cwd());
    expect(response.json()).toEqual({ repositories: [{ id: "gateway" }] });
  });

  it("returns a stable 400 error for invalid public input", async () => {
    const { app } = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/v2/conversations",
      headers: authorization,
      payload: {}
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toEqual({
      code: "INVALID_REQUEST",
      message: "Request validation failed",
      retryable: false
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/v2/conversations",
      headers: { ...authorization, "content-type": "application/json" },
      payload: "{"
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("INVALID_REQUEST");
    const missing = await app.inject({ method: "GET", url: "/v2/does-not-exist", headers: authorization });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
  });

  it("runs an encrypted durable job and replays idempotent submissions", async () => {
    const { app, store, database } = await testApp();
    const conversationId = await createConversation(app);
    const request = {
      method: "POST" as const,
      url: `/v2/conversations/${conversationId}/turns`,
      headers: { ...authorization, "idempotency-key": "request-0001" },
      payload: { prompt: "inspect the repository" }
    };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(202);
    const second = await app.inject(request);
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ jobId: first.json().jobId, replayed: true });

    const job = await waitForCompletion(app, first.json().jobId as string);
    expect(job).toMatchObject({ status: "completed", result: "done", repositoryId: "gateway" });
    expect(JSON.stringify(job)).not.toContain("internal-thread-id");

    const events = await store.events("owner", job.id);
    expect(events.map((event) => event.type)).toEqual([
      "job.queued", "job.started", "agent.message.delta", "job.completed"
    ]);
    const stored = await database.db.selectFrom("jobEvents").select("encryptedData").execute();
    expect(stored.some((row) => row.encryptedData.includes("done"))).toBe(false);
  });

  it("rejects reuse of an idempotency key with a different prompt", async () => {
    const { app } = await testApp();
    const conversationId = await createConversation(app);
    const headers = { ...authorization, "idempotency-key": "request-0002" };
    expect((await app.inject({
      method: "POST", url: `/v2/conversations/${conversationId}/turns`, headers, payload: { prompt: "first" }
    })).statusCode).toBe(202);
    const conflict = await app.inject({
      method: "POST", url: `/v2/conversations/${conversationId}/turns`, headers, payload: { prompt: "second" }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("bounds queued and running jobs", async () => {
    let release: (() => void) | undefined;
    const runner: CodingRunner = {
      async run() {
        await new Promise<void>((resolve) => { release = resolve; });
        return { backendThreadId: "thread", result: "done" };
      }
    };
    const { app } = await testApp(runner, 1);
    const conversationId = await createConversation(app);
    const first = await app.inject({
      method: "POST",
      url: `/v2/conversations/${conversationId}/turns`,
      headers: { ...authorization, "idempotency-key": "queue-0001" },
      payload: { prompt: "first" }
    });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({
      method: "POST",
      url: `/v2/conversations/${conversationId}/turns`,
      headers: { ...authorization, "idempotency-key": "queue-0002" },
      payload: { prompt: "second" }
    });
    expect(second.statusCode).toBe(429);
    release?.();
  });

  it("atomically runs a one-shot structured coding job", async () => {
    let receivedSchema: unknown;
    const runner: CodingRunner = {
      async run(input) {
        receivedSchema = input.outputSchema;
        return { backendThreadId: "thread", result: JSON.stringify({ verdict: "accept" }) };
      }
    };
    const { app, database } = await testApp(runner);
    const request = {
      method: "POST" as const,
      url: "/v2/coding/runs",
      headers: { ...authorization, "idempotency-key": "decision-review-0001" },
      payload: { repositoryId: "gateway", prompt: "review this", outputSchema: reviewSchema }
    };
    const created = await app.inject(request);
    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({ status: "queued", replayed: false });

    const replay = await app.inject({
      ...request,
      payload: {
        repositoryId: "gateway",
        prompt: "review this",
        outputSchema: { required: ["verdict"], properties: reviewSchema.properties, type: "object", additionalProperties: false }
      }
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ jobId: created.json().jobId, replayed: true });

    const job = await waitForCompletion(app, created.json().jobId as string);
    expect(job).toMatchObject({
      status: "completed",
      structuredOutput: { verdict: "accept" }
    });
    expect(receivedSchema).toEqual(reviewSchema);
    const stored = await database.db.selectFrom("jobs").select("encryptedOutputSchema").executeTakeFirstOrThrow();
    expect(stored.encryptedOutputSchema).not.toContain("verdict");
  });

  it("runs an inference job against a private cwd with no repository", async () => {
    let receivedCwd: string | undefined;
    const runner: CodingRunner = {
      async run(input) {
        receivedCwd = input.repositoryPath;
        return { backendThreadId: "thread", result: JSON.stringify({ verdict: "revise" }) };
      }
    };
    const { app, database } = await testApp(runner);
    const created = await app.inject({
      method: "POST",
      url: "/v2/inference/runs",
      headers: { ...authorization, "idempotency-key": "inference-0001" },
      payload: { prompt: "judge this artifact", outputSchema: reviewSchema }
    });
    expect(created.statusCode).toBe(202);

    const job = await waitForCompletion(app, created.json().jobId as string);
    expect(job).toMatchObject({ status: "completed", kind: "inference.turn", repositoryId: null, structuredOutput: { verdict: "revise" } });
    // The Codex cwd is a gateway-owned dir under the inference root, never a public repo.
    expect(receivedCwd?.startsWith(inferenceRoots.at(-1) ?? " ")).toBe(true);
    expect(receivedCwd).not.toBe(process.cwd());
    // A conversation without a repository is stored NULL, not a sentinel string.
    const conversation = await database.db.selectFrom("conversations").select("repositoryId").executeTakeFirstOrThrow();
    expect(conversation.repositoryId).toBeNull();
  });

  it("keeps inference and coding endpoints structurally separate", async () => {
    let receivedCwd: string | undefined;
    const runner: CodingRunner = {
      async run(input) {
        receivedCwd = input.repositoryPath;
        return { backendThreadId: "thread", result: "ok" };
      }
    };
    const { app } = await testApp(runner);
    // A repositoryId on the inference endpoint is stripped by the schema, never
    // honored: the run still executes as inference against the private cwd.
    const withRepo = await app.inject({
      method: "POST",
      url: "/v2/inference/runs",
      headers: { ...authorization, "idempotency-key": "inference-0002" },
      payload: { prompt: "judge", repositoryId: "gateway" }
    });
    expect(withRepo.statusCode).toBe(202);
    const job = await waitForCompletion(app, withRepo.json().jobId as string);
    expect(job).toMatchObject({ kind: "inference.turn", repositoryId: null });
    expect(receivedCwd).not.toBe(process.cwd());
    // The coding endpoint still cannot reach the inference workspace.
    const codingTarget = await app.inject({
      method: "POST",
      url: "/v2/coding/runs",
      headers: { ...authorization, "idempotency-key": "inference-0003" },
      payload: { repositoryId: "__inference__", prompt: "judge" }
    });
    expect(codingTarget.statusCode).toBe(404);
    // The capability is advertised.
    const capabilities = await app.inject({ method: "GET", url: "/v2/capabilities", headers: authorization });
    expect(capabilities.json().capabilities.map((c: { id: string }) => c.id)).toContain("inference.turn");
  });

  it("rejects unsafe schemas and fails invalid structured output", async () => {
    const runner: CodingRunner = {
      async run() {
        return { backendThreadId: "thread", result: "not json" };
      }
    };
    const { app } = await testApp(runner);
    const unsafe = await app.inject({
      method: "POST",
      url: "/v2/coding/runs",
      headers: { ...authorization, "idempotency-key": "decision-review-0002" },
      payload: { repositoryId: "gateway", prompt: "review", outputSchema: { $ref: "https://example.test/schema" } }
    });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().error.code).toBe("INVALID_REQUEST");

    const created = await app.inject({
      method: "POST",
      url: "/v2/coding/runs",
      headers: { ...authorization, "idempotency-key": "decision-review-0003" },
      payload: { repositoryId: "gateway", prompt: "review", outputSchema: reviewSchema }
    });
    const job = await waitForCompletion(app, created.json().jobId as string);
    expect(job).toMatchObject({
      status: "failed",
      structuredOutput: null,
      error: { code: "STRUCTURED_OUTPUT_INVALID", retryable: false }
    });
  });
});
