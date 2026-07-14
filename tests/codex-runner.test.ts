import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexAppServerRunner } from "../src/adapters/codex/runner.js";

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
});
