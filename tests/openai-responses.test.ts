import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { buildApp } from "../src/app.js";
import type { CodingRunner } from "../src/adapters/codex/runner.js";
import { JobProcessor } from "../src/application/job-processor.js";
import { GatewayStore } from "../src/application/store.js";
import { GatewayError } from "../src/domain/errors.js";
import { SecretBox } from "../src/infrastructure/crypto.js";
import { openDatabase } from "../src/infrastructure/database.js";
import type { GatewayConfig } from "../src/infrastructure/config.js";
import { authorization, testConfig, testToken } from "./helpers.js";

const apps: FastifyInstance[] = [];
const inferenceRoots: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of inferenceRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function testApp(
  runner: CodingRunner,
  enabled = true,
  overrides: Partial<GatewayConfig> = {}
) {
  const inferenceWorkspaceRoot = mkdtempSync(join(tmpdir(), "codexgw-openai-root-"));
  inferenceRoots.push(inferenceWorkspaceRoot);
  const config = testConfig({
    ...overrides,
    openaiCompatibilityEnabled: enabled,
    inferenceWorkspaceRoot,
    rpcTimeoutMs: overrides.rpcTimeoutMs ?? 100,
    turnTimeoutMs: overrides.turnTimeoutMs ?? 1_000
  });
  const database = openDatabase(":memory:");
  const store = new GatewayStore(database.db, new SecretBox(config.encryptionKey));
  const processor = new JobProcessor(
    store,
    runner,
    config.repositories,
    config.maxConcurrentJobs,
    config.inferenceWorkspaceRoot
  );
  const app = await buildApp({ config, store, processor, closeDatabase: database.close });
  apps.push(app);
  await app.ready();
  return { app, database, store };
}

const successfulRunner: CodingRunner = {
  async run(input) {
    await input.onEvent({ type: "agent.message.delta", data: { delta: "hello" } });
    return { backendThreadId: "private-thread", result: "hello" };
  }
};

describe("OpenAI Responses compatibility", () => {
  it("is unregistered by default and uses an OpenAI-shaped 404", async () => {
    const { app } = await testApp(successfulRunner, false);
    const response = await app.inject({ method: "GET", url: "/v1/models" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toEqual({
      message: "Resource not found",
      type: "invalid_request_error",
      param: null,
      code: "NOT_FOUND"
    });
  });

  it("requires the Gateway token and exposes only the stable model alias", async () => {
    const { app } = await testApp(successfulRunner);
    const unauthorized = await app.inject({ method: "GET", url: "/v1/models" });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json().error.type).toBe("authentication_error");

    const response = await app.inject({ method: "GET", url: "/v1/models", headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      object: "list",
      data: [{
        id: "codex-subscription",
        object: "model",
        created: 0,
        owned_by: "local-agent-gateway"
      }]
    });
  });

  it("returns a stable, opaque Responses object through the encrypted inference pipeline", async () => {
    let receivedPrompt = "";
    const runner: CodingRunner = {
      async run(input) {
        receivedPrompt = input.prompt;
        return { backendThreadId: "private-thread", result: "hello" };
      }
    };
    const { app, database } = await testApp(runner);
    const request = {
      method: "POST" as const,
      url: "/v1/responses",
      headers: { ...authorization, "idempotency-key": "openai-response-0001" },
      payload: {
        model: "codex-subscription",
        instructions: "Be concise.",
        input: "Say hello."
      }
    };
    const response = await app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(receivedPrompt).toBe([
      "Client instructions:",
      "<client_instructions>",
      "Be concise.",
      "</client_instructions>",
      "",
      "User input:",
      "<user_input>",
      "Say hello.",
      "</user_input>"
    ].join("\n"));
    expect(response.json()).toMatchObject({
      object: "response",
      status: "completed",
      model: "codex-subscription",
      store: false,
      tool_choice: "none",
      temperature: null,
      top_p: null,
      usage: null,
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello", annotations: [] }]
      }]
    });
    expect(response.body).not.toContain("private-thread");
    expect(response.json().output[0].content[0]).not.toHaveProperty("logprobs");

    const stored = await database.db.selectFrom("jobs").select("id").executeTakeFirstOrThrow();
    expect(response.json().id).not.toContain(stored.id.replace(/^job_/, ""));

    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(response.json().id);

    const conflict = await app.inject({
      ...request,
      payload: { model: "codex-subscription", input: "Different request." }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({
      type: "invalid_request_error",
      code: "IDEMPOTENCY_CONFLICT"
    });
  });

  it("rejects unsupported fields and models instead of silently ignoring them", async () => {
    const { app } = await testApp(successfulRunner);
    const unsupported = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authorization,
      payload: {
        model: "codex-subscription",
        input: "hello",
        tools: [{ type: "web_search" }]
      }
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error).toMatchObject({
      type: "invalid_request_error",
      code: "INVALID_REQUEST"
    });

    const model = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authorization,
      payload: { model: "gpt-arbitrary", input: "hello" }
    });
    expect(model.statusCode).toBe(400);
    expect(model.json().error.code).toBe("INVALID_REQUEST");

    const structuredInput = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authorization,
      payload: {
        model: "codex-subscription",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
      }
    });
    expect(structuredInput.statusCode).toBe(400);
    expect(structuredInput.json().error.code).toBe("INVALID_REQUEST");
  });

  it("enforces the configured UTF-8 prompt byte limit", async () => {
    const { app } = await testApp(successfulRunner, true, { maxPromptBytes: 8 });
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authorization,
      payload: { model: "codex-subscription", input: "日本語" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      type: "invalid_request_error",
      code: "INVALID_REQUEST"
    });
  });

  it("cancels a response that exceeds the bounded wait", async () => {
    const runner: CodingRunner = {
      async run(input) {
        return new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
        });
      }
    };
    const { app, database } = await testApp(runner, true, { rpcTimeoutMs: 20, turnTimeoutMs: 20 });
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authorization,
      payload: { model: "codex-subscription", input: "hello" }
    });
    expect(response.statusCode).toBe(504);
    expect(response.json().error).toMatchObject({ type: "api_error", code: "CODEX_TIMEOUT" });

    await expect.poll(async () => {
      const job = await database.db.selectFrom("jobs").select("status").executeTakeFirstOrThrow();
      return job.status;
    }).toBe("cancelled");
  });

  it("maps queue saturation to an OpenAI-shaped rate-limit error", async () => {
    const { app, database } = await testApp(successfulRunner, true, {
      maxConcurrentJobs: 0,
      maxQueuedJobs: 1,
      rpcTimeoutMs: 100,
      turnTimeoutMs: 100
    });
    const first = app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authorization,
      payload: { model: "codex-subscription", input: "first" }
    });
    await expect.poll(async () => {
      const row = await database.db.selectFrom("jobs").select("status").executeTakeFirst();
      return row?.status;
    }).toBe("queued");

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authorization,
      payload: { model: "codex-subscription", input: "second" }
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error).toMatchObject({ type: "rate_limit_error", code: "QUEUE_FULL" });
    expect((await first).statusCode).toBe(504);
  });

  it("cancels the durable job when a synchronous client disconnects", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const runner: CodingRunner = {
      async run(input) {
        markStarted?.();
        return new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
        });
      }
    };
    const { app, database } = await testApp(runner);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ model: "codex-subscription", input: "hello" }),
      signal: controller.signal
    });
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await expect.poll(async () => {
      const job = await database.db.selectFrom("jobs").select("status").executeTakeFirstOrThrow();
      return job.status;
    }).toBe("cancelled");
  });

  it("does not cancel an explicitly idempotent job when one waiter disconnects", async () => {
    let markStarted: (() => void) | undefined;
    let finishRun: (() => void) | undefined;
    let aborted = false;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishRun = resolve; });
    const runner: CodingRunner = {
      async run(input) {
        markStarted?.();
        input.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        await finish;
        return { backendThreadId: "private-thread", result: "hello" };
      }
    };
    const { app, database, store } = await testApp(runner);
    const submit = vi.spyOn(store, "submitInference");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
    const controller = new AbortController();
    const headers = {
      ...authorization,
      "content-type": "application/json",
      "idempotency-key": "openai-shared-response"
    };
    const first = fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "codex-subscription", input: "hello" }),
      signal: controller.signal
    });
    await started;
    const second = app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "codex-subscription", input: "hello" }
    });
    await expect.poll(() => submit.mock.calls.length).toBe(2);

    controller.abort();
    await expect(first).rejects.toThrow();
    finishRun?.();
    const response = await second;
    expect(response.statusCode).toBe(200);
    expect(response.json().output[0].content[0].text).toBe("hello");
    expect(aborted).toBe(false);
    const job = await database.db.selectFrom("jobs").select("status").executeTakeFirstOrThrow();
    expect(job.status).toBe("completed");
  });

  it("maps only allowlisted text deltas to Responses SSE events", async () => {
    const runner: CodingRunner = {
      async run(input) {
        await input.onEvent({ type: "agent.message.delta", data: { delta: "hel" } });
        await input.onEvent({ type: "agent.message.delta", data: { delta: "lo" } });
        return { backendThreadId: "private-thread", result: "hello" };
      }
    };
    const { app } = await testApp(runner);
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authorization,
      payload: { model: "codex-subscription", input: "hello", stream: true }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const eventNames = [...response.body.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
    expect(eventNames).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed"
    ]);
    expect(response.body).toContain('"delta":"hel"');
    expect(response.body).not.toContain("private-thread");
    expect(response.body).not.toContain(process.cwd());
    expect(response.body).not.toContain("[DONE]");
  });

  it("drains deltas committed immediately before the terminal job update", async () => {
    const runner: CodingRunner = {
      async run(input) {
        await input.onEvent({ type: "agent.message.delta", data: { delta: "final text" } });
        return { backendThreadId: "private-thread", result: "final text" };
      }
    };
    const { app, database, store } = await testApp(runner);
    const originalEvents = store.events.bind(store);
    vi.spyOn(store, "events").mockImplementationOnce(async () => {
      await expect.poll(async () => {
        const job = await database.db.selectFrom("jobs").select("status").executeTakeFirst();
        return job?.status;
      }).toBe("completed");
      return [];
    }).mockImplementation(originalEvents);

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authorization,
      payload: { model: "codex-subscription", input: "hello", stream: true }
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"delta":"final text"');
    expect(response.body).toContain("event: response.completed");
  });

  it("drains every stored delta page when replaying a completed job", async () => {
    const deltaCount = 1_001;
    const runner: CodingRunner = {
      async run(input) {
        for (let index = 0; index < deltaCount; index += 1) {
          await input.onEvent({ type: "agent.message.delta", data: { delta: "x" } });
        }
        return { backendThreadId: "private-thread", result: "x".repeat(deltaCount) };
      }
    };
    const { app } = await testApp(runner);
    const headers = { ...authorization, "idempotency-key": "openai-response-many-deltas" };
    const completed = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "codex-subscription", input: "hello" }
    });
    expect(completed.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "codex-subscription", input: "hello", stream: true }
    });
    const deltas = [...replay.body.matchAll(/^event: response\.output_text\.delta$/gm)];
    expect(deltas).toHaveLength(deltaCount);
    expect(replay.body).toContain("event: response.completed");
  });

  it("closes a timed-out stream after a bounded cancellation grace period", async () => {
    const runner: CodingRunner = {
      async run(input) {
        return new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => {
            setTimeout(() => reject(input.signal.reason), 100);
          }, { once: true });
        });
      }
    };
    const { app, database } = await testApp(runner, true, { rpcTimeoutMs: 20, turnTimeoutMs: 20 });
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authorization,
      payload: { model: "codex-subscription", input: "hello", stream: true }
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: response.failed");
    expect(response.body).toContain('"code":"CODEX_TIMEOUT"');

    await expect.poll(async () => {
      const job = await database.db.selectFrom("jobs").select("status").executeTakeFirstOrThrow();
      return job.status;
    }).toBe("cancelled");
  });

  it("preserves the timeout error when deadline cancellation finishes promptly", async () => {
    const runner: CodingRunner = {
      async run(input) {
        return new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
        });
      }
    };
    const { app } = await testApp(runner, true, { rpcTimeoutMs: 20, turnTimeoutMs: 20 });
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authorization,
      payload: { model: "codex-subscription", input: "hello", stream: true }
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: response.failed");
    expect(response.body).toContain('"code":"CODEX_TIMEOUT"');
    expect(response.body).not.toContain('"code":"CODEX_EXECUTION_FAILED"');
  });

  it("maps upstream rate limits to an OpenAI-shaped 429", async () => {
    const runner: CodingRunner = {
      async run() {
        throw new GatewayError("CODEX_RATE_LIMITED", "Codex plan usage limit was reached", 429, true);
      }
    };
    const { app } = await testApp(runner);
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authorization,
      payload: { model: "codex-subscription", input: "hello" }
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error).toEqual({
      message: "Codex plan usage limit was reached",
      type: "rate_limit_error",
      param: null,
      code: "CODEX_RATE_LIMITED"
    });
  });

  it("treats stream as delivery-only for idempotent replay", async () => {
    const { app } = await testApp(successfulRunner);
    const headers = { ...authorization, "idempotency-key": "openai-response-0002" };
    const first = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "codex-subscription", input: "hello" }
    });
    const streamed = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "codex-subscription", input: "hello", stream: true }
    });
    expect(first.statusCode).toBe(200);
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body).toContain(`"id":"${first.json().id as string}"`);
  });

  it("parses synchronous and streaming responses with the official OpenAI JavaScript SDK", async () => {
    const { app } = await testApp(successfulRunner);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
    const client = new OpenAI({
      apiKey: testToken,
      baseURL: `http://127.0.0.1:${address.port}/v1`
    });

    const response = await client.responses.create({
      model: "codex-subscription",
      input: "hello"
    });
    expect(response.status).toBe("completed");
    expect(response.output_text).toBe("hello");

    const stream = await client.responses.create({
      model: "codex-subscription",
      input: "hello",
      stream: true
    });
    const eventTypes: string[] = [];
    let streamedText = "";
    for await (const event of stream) {
      eventTypes.push(event.type);
      if (event.type === "response.output_text.delta") streamedText += event.delta;
    }
    expect(streamedText).toBe("hello");
    expect(eventTypes.at(-1)).toBe("response.completed");
  });
});
