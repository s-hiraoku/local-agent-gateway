import { describe, expect, it } from "vitest";
import {
  CursorSdkRunner,
  cursorResultText,
  mapCursorError,
  mapCursorInfo,
  withOutputSchema,
  type CursorPromptClient
} from "../src/adapters/cursor/runner.js";
import { GatewayError } from "../src/domain/errors.js";

const schema = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
  additionalProperties: false
};

const baseInput = {
  repositoryPath: "/tmp/codexgw-cursor-ws",
  backendThreadId: null,
  prompt: "review this",
  outputSchema: schema,
  signal: new AbortController().signal,
  onEvent: async () => undefined
};

function runnerFor(promptClient: CursorPromptClient, overrides: { apiKey?: string; model?: string; turnTimeoutMs?: number } = {}) {
  return new CursorSdkRunner({
    apiKey: overrides.apiKey ?? "cursor_test_key_1234567890",
    ...(overrides.model ? { model: overrides.model } : {}),
    turnTimeoutMs: overrides.turnTimeoutMs ?? 5_000,
    maxResultBytes: 1024 * 1024
  }, promptClient);
}

describe("CursorSdkRunner", () => {
  it("returns the SDK result text and run id", async () => {
    const result = await runnerFor(async () => ({
      id: "run-1",
      status: "finished",
      result: '{"verdict":"revise"}'
    })).run(baseInput);
    expect(JSON.parse(result.result)).toEqual({ verdict: "revise" });
    expect(result.backendThreadId).toBe("run-1");
  });

  it("JSON-stringifies a non-string result so a string schema can parse it", async () => {
    const result = await runnerFor(async () => ({
      id: "run-obj",
      status: "finished",
      result: { verdict: "accept" }
    })).run({ ...baseInput, outputSchema: { type: "string" } });
    expect(result.result).toBe('{"verdict":"accept"}');
    expect(JSON.parse(result.result)).toEqual({ verdict: "accept" });
  });

  it("appends the output schema and disables tools by staying on the injected client", async () => {
    let received = "";
    await runnerFor(async (prompt, options) => {
      received = prompt;
      expect(options.model).toBe("composer-2.5");
      expect(options.cwd).toBe(baseInput.repositoryPath);
      return { id: "run-schema", status: "finished", result: '{"verdict":"accept"}' };
    }).run(baseInput);
    expect(received).toContain(baseInput.prompt);
    expect(received).toContain(JSON.stringify(schema));
    expect(withOutputSchema("hello")).toBe("hello");
  });

  it("passes a configured model to the prompt client", async () => {
    let model = "";
    const { outputSchema: _omitted, ...withoutSchema } = baseInput;
    await runnerFor(async (_prompt, options) => {
      model = options.model;
      return { status: "finished", result: "ok" };
    }, { model: "grok-4.6" }).run(withoutSchema);
    expect(model).toBe("grok-4.6");
  });

  it("maps a run-status error to a Cursor error code", async () => {
    await expect(runnerFor(async () => ({
      status: "error",
      error: { message: "Please log in with a valid API key" }
    })).run(baseInput)).rejects.toMatchObject({
      code: "CURSOR_UNAUTHORIZED",
      statusCode: 401,
      retryable: false
    });
  });

  it("maps usage-limit messages to CURSOR_RATE_LIMITED", async () => {
    await expect(runnerFor(async () => ({
      status: "error",
      error: { message: "rate limit reached" }
    })).run(baseInput)).rejects.toMatchObject({
      code: "CURSOR_RATE_LIMITED",
      retryable: true,
      statusCode: 429
    });
    expect(mapCursorInfo("Too many requests")).toBe("CURSOR_RATE_LIMITED");
    expect(mapCursorInfo("quota exceeded")).toBe("CURSOR_RATE_LIMITED");
  });

  it("maps AuthenticationError and RateLimitError by name", () => {
    expect(mapCursorError(Object.assign(new Error("nope"), { name: "AuthenticationError" }))).toMatchObject({
      code: "CURSOR_UNAUTHORIZED",
      statusCode: 401
    });
    expect(mapCursorError(Object.assign(new Error("slow down"), { name: "RateLimitError" }))).toMatchObject({
      code: "CURSOR_RATE_LIMITED",
      statusCode: 429
    });
  });

  it("maps non-auth failures to CURSOR_EXECUTION_FAILED", async () => {
    await expect(runnerFor(async () => ({
      status: "error",
      error: { message: "model overloaded" }
    })).run(baseInput)).rejects.toMatchObject({
      code: "CURSOR_EXECUTION_FAILED"
    });
  });

  it("redacts the API key from thrown error messages", () => {
    const mapped = mapCursorError(new Error("bad cursor_test_key_1234567890"), "cursor_test_key_1234567890");
    expect(mapped.message).not.toContain("cursor_test_key_1234567890");
    expect(mapped.code).toBe("CURSOR_EXECUTION_FAILED");
  });

  it("times out a hanging prompt client", async () => {
    await expect(runnerFor(async (_prompt, options) => new Promise((_, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }), { turnTimeoutMs: 20 }).run(baseInput)).rejects.toMatchObject({
      code: "CURSOR_TIMEOUT",
      statusCode: 504
    });
  });

  it("checkReady resolves when a key is present", async () => {
    await expect(runnerFor(async () => ({ status: "finished", result: "ok" })).checkReady()).resolves.toBeUndefined();
  });

  it("checkReady fails when the API key is missing", async () => {
    await expect(runnerFor(async () => ({ status: "finished", result: "ok" }), { apiKey: "short" }).checkReady())
      .rejects.toBeInstanceOf(GatewayError);
  });

  it("returns an empty cursorResultText for missing results", () => {
    expect(cursorResultText({})).toBe("");
    expect(cursorResultText({ result: "ok" })).toBe("ok");
  });
});
