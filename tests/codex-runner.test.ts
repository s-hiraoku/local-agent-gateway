import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_APP_SERVER_METHODS,
  CODEX_INITIALIZE_PARAMS
} from "../src/adapters/codex/compatibility.js";
import {
  CodexAppServerRunner,
  mapCodexInfo,
  PathRedactingStream,
  sanitizeOutput
} from "../src/adapters/codex/runner.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fakeHome(sidecars: Record<string, string> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "codexgw-fake-home-"));
  homes.push(home);
  for (const [name, value] of Object.entries(sidecars)) {
    writeFileSync(join(home, name), value);
  }
  return home;
}

function runner(codexHome: string, maxResultBytes = 1024): CodexAppServerRunner {
  return new CodexAppServerRunner({
    command: fixture,
    codexHome,
    rpcTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
    maxResultBytes
  });
}

describe("CodexAppServerRunner process contract", () => {
  it("checks ChatGPT auth and forwards outputSchema through real stdio", async () => {
    const home = fakeHome();
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(join(home, "fake-transcript-path"), transcript);
    await expect(runner(home).checkReady()).resolves.toBeUndefined();
    const events: string[] = [];
    const result = await runner(home).run({
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

    const methods = readFileSync(transcript, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: Record<string, unknown> | null;
    });
    expect(methods.map((entry) => entry.method)).toEqual([
      CODEX_APP_SERVER_METHODS.initialize,
      CODEX_APP_SERVER_METHODS.initialized,
      CODEX_APP_SERVER_METHODS.accountRead,
      CODEX_APP_SERVER_METHODS.initialize,
      CODEX_APP_SERVER_METHODS.initialized,
      CODEX_APP_SERVER_METHODS.threadStart,
      CODEX_APP_SERVER_METHODS.turnStart
    ]);
    expect(methods[0]?.params).toEqual(CODEX_INITIALIZE_PARAMS);
    expect(methods.at(-1)?.params).toMatchObject({
      approvalPolicy: "never",
      outputSchema: { type: "object" }
    });
  });

  it("fails closed on an unsupported or unreadable Codex CLI version", async () => {
    await expect(runner(fakeHome({ "fake-version": "0.80.0" })).checkReady())
      .rejects.toMatchObject({ code: "CODEX_UNSUPPORTED_VERSION", retryable: false, statusCode: 503 });
    await expect(runner(fakeHome({ "fake-version": "not-a-version" })).checkReady())
      .rejects.toMatchObject({ code: "CODEX_UNSUPPORTED_VERSION" });
    await expect(runner(fakeHome({ "fake-initialize": "missing-user-agent" })).checkReady())
      .rejects.toMatchObject({ code: "CODEX_UNSUPPORTED_VERSION" });
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

  it("preserves API routes and URLs while redacting local POSIX paths", () => {
    const value = '{"endpoint":"/v2/jobs","docs":"https://example.com/api","file":"/etc/passwd","uri":"file:///tmp/key"}';
    expect(sanitizeOutput(value, "/workspace/repo"))
      .toBe('{"endpoint":"/v2/jobs","docs":"https://example.com/api","file":"[local-path]","uri":"[local-path]"}');
  });

  it("bounds the final item/completed message and keeps unauthorized non-retryable", async () => {
    const bounded = runner(fakeHome(), 8);
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

    const failing = runner(fakeHome());
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
