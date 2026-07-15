import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CodexAppServerRunner,
  mapCodexInfo,
  PathRedactingStream,
  sanitizeOutput
} from "../src/adapters/codex/runner.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

describe("CodexAppServerRunner process contract", () => {
  it("checks ChatGPT auth and forwards outputSchema through real stdio", async () => {
    const runner = new CodexAppServerRunner({
      command: fixture,
      codexHome: "/tmp/codexgw-fake-home",
      rpcTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
      maxResultBytes: 1024
    });
    await expect(runner.checkReady()).resolves.toBeUndefined();
    const events: string[] = [];
    const result = await runner.run({
      repositoryPath: process.cwd(),
      backendThreadId: null,
      prompt: "review",
      outputSchema: {
        type: "object",
        properties: { verdict: { type: "string", enum: ["accept", "revise", "reject"] } },
        required: ["verdict"],
        additionalProperties: false
      },
      signal: new AbortController().signal,
      onEvent: async (event) => { events.push(event.data.delta); }
    });
    expect(result).toEqual({ backendThreadId: "thread-fake", result: '{"verdict":"accept"}' });
    expect(events).toEqual(['{"verdict":"accept"}']);
  });

  it("redacts absolute paths that span streaming chunk boundaries", async () => {
    const events: string[] = [];
    const stream = new PathRedactingStream("/workspace/repo", 1024, async (event) => {
      events.push(event.data.delta);
    });
    await stream.push("open /et");
    expect(events).toEqual(["open "]);
    await stream.push("c/passwd then ");
    await stream.push("\\\\server\\sha");
    await stream.push("re now");
    await stream.finish();
    expect(events.join("")).toBe("open [local-path] then [local-path] now");
    expect(events.join("")).not.toContain("/et");
    expect(events.join("")).not.toContain("server");
  });

  it("redacts short POSIX roots and maps current and legacy Codex error variants", () => {
    expect(sanitizeOutput("/etc/passwd /var/lib C:\\secret \\\\server\\share", "/workspace/repo"))
      .toBe("[local-path] [local-path] [local-path] [local-path]");
    expect(mapCodexInfo("unauthorized")).toBe("CODEX_UNAUTHORIZED");
    expect(mapCodexInfo("Unauthorized")).toBe("CODEX_UNAUTHORIZED");
    expect(mapCodexInfo("UsageLimitExceeded")).toBe("CODEX_RATE_LIMITED");
    expect(mapCodexInfo({ httpConnectionFailed: { httpStatusCode: 503 } })).toBe("CODEX_EXECUTION_FAILED");
  });

  it("bounds the final item/completed message and keeps unauthorized non-retryable", async () => {
    const bounded = new CodexAppServerRunner({
      command: fixture,
      codexHome: "/tmp/codexgw-fake-home",
      rpcTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
      maxResultBytes: 8
    });
    const result = await bounded.run({
      repositoryPath: process.cwd(),
      backendThreadId: null,
      prompt: "review",
      outputSchema: {
        type: "object",
        properties: { verdict: { type: "string", enum: ["accept"] } },
        required: ["verdict"],
        additionalProperties: false
      },
      signal: new AbortController().signal,
      onEvent: async () => undefined
    });
    expect(Buffer.byteLength(result.result)).toBeLessThanOrEqual(8);

    const failing = new CodexAppServerRunner({
      command: fixture,
      codexHome: "/tmp/codexgw-fake-home",
      rpcTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
      maxResultBytes: 1024
    });
    await expect(failing.run({
      repositoryPath: process.cwd(),
      backendThreadId: null,
      prompt: "fail unauthorized",
      outputSchema: { type: "object" },
      signal: new AbortController().signal,
      onEvent: async () => undefined
    })).rejects.toMatchObject({ code: "CODEX_UNAUTHORIZED", retryable: false });
  });
});
