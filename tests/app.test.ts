import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { CodingRunner } from "../src/adapters/codex/runner.js";
import { JobProcessor } from "../src/application/job-processor.js";
import { GatewayStore } from "../src/application/store.js";
import { SecretBox } from "../src/infrastructure/crypto.js";
import { openDatabase } from "../src/infrastructure/database.js";
import { authorization, testConfig } from "./helpers.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function testApp(runner?: CodingRunner, maxQueuedJobs = 10) {
  const config = testConfig({ maxQueuedJobs });
  const database = openDatabase(":memory:");
  const store = new GatewayStore(database.db, new SecretBox(config.encryptionKey));
  const resolvedRunner: CodingRunner = runner ?? {
    async run(input) {
      await input.onEvent({ type: "agent.message.delta", data: { delta: "done" } });
      return { backendThreadId: input.backendThreadId ?? "internal-thread-id", result: "done" };
    }
  };
  const processor = new JobProcessor(store, resolvedRunner, config.repositories, config.maxConcurrentJobs);
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
});
