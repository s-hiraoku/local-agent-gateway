import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrokHeadlessRunner, buildGrokEnvironment, mapGrokInfo } from "../src/adapters/grok/runner.js";
import { GatewayError } from "../src/domain/errors.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeGrok(script: string): { command: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "codexgw-grok-fake-"));
  directories.push(dir);
  const command = join(dir, "grok");
  writeFileSync(command, `#!/bin/sh\n${script}\n`);
  chmodSync(command, 0o755);
  return { command, dir };
}

function runnerFor(command: string) {
  return new GrokHeadlessRunner({ command, turnTimeoutMs: 5_000, maxResultBytes: 1024 * 1024 });
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "codexgw-grok-ws-"));
  directories.push(dir);
  return dir;
}

function readNulSeparated(path: string): string[] {
  return readFileSync(path).toString("utf8").split("\0").slice(0, -1);
}

const baseInput = {
  backendThreadId: null,
  prompt: "review this",
  outputSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false },
  signal: new AbortController().signal,
  onEvent: async () => undefined
};

describe("GrokHeadlessRunner", () => {
  it("returns the native structured_output object as the result", async () => {
    const { command } = fakeGrok(
      `echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1","result":"{\\"verdict\\":\\"revise\\"}","structured_output":{"verdict":"revise"}}'`
    );
    const result = await runnerFor(command).run({ ...baseInput, repositoryPath: workspace() });
    expect(JSON.parse(result.result)).toEqual({ verdict: "revise" });
    expect(result.backendThreadId).toBe("sess-1");
  });

  it("returns the live Grok json envelope text field", async () => {
    const { command } = fakeGrok(
      `echo '{"text":"ok","stopReason":"end_turn","sessionId":"sess-live","thought":"ignore"}'`
    );
    const { outputSchema: _omitted, ...withoutSchema } = baseInput;
    const result = await runnerFor(command).run({ ...withoutSchema, repositoryPath: workspace() });
    expect(result.result).toBe("ok");
    expect(result.backendThreadId).toBe("sess-live");
  });

  it("writes the prompt to a file and disables tools", async () => {
    const capture = mkdtempSync(join(tmpdir(), "codexgw-grok-argv-"));
    directories.push(capture);
    const argvFile = join(capture, "argv");
    const { command } = fakeGrok(
      `printf '%s\\0' "$@" > "${argvFile}"\n` +
      `echo '{"type":"result","subtype":"success","is_error":false,"structured_output":{"verdict":"accept"}}'`
    );
    const repositoryPath = workspace();
    await runnerFor(command).run({ ...baseInput, repositoryPath });
    const tokens = readNulSeparated(argvFile);
    expect(tokens).toContain("--output-format");
    expect(tokens).toContain("json");
    expect(tokens).toContain("--prompt-file");
    expect(tokens).toContain("--json-schema");
    expect(tokens).toContain("--sandbox");
    expect(tokens).toContain("read-only");
    expect(tokens).toContain("--tools");
    expect(tokens[tokens.indexOf("--tools") + 1]).toBe("");
    expect(tokens).toContain("--disallowed-tools");
    expect(tokens).toContain("Agent");
    expect(tokens).not.toContain(baseInput.prompt);
    const promptFile = tokens[tokens.indexOf("--prompt-file") + 1];
    expect(promptFile).toBe(join(repositoryPath, ".gateway-prompt"));
    expect(promptFile).toBeDefined();
    expect(() => readFileSync(promptFile!)).toThrow();
  });

  it("omits --json-schema when the turn has no output schema", async () => {
    const capture = mkdtempSync(join(tmpdir(), "codexgw-grok-argv-"));
    directories.push(capture);
    const argvFile = join(capture, "argv");
    const { command } = fakeGrok(
      `printf '%s\\0' "$@" > "${argvFile}"\n` +
      `echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'`
    );
    const { outputSchema: _omitted, ...withoutSchema } = baseInput;
    await runnerFor(command).run({ ...withoutSchema, repositoryPath: workspace() });
    expect(readNulSeparated(argvFile)).not.toContain("--json-schema");
  });

  it("maps an is_error envelope to a Grok error", async () => {
    const { command } = fakeGrok(
      `echo '{"type":"result","subtype":"success","is_error":true,"result":"Please log in to authenticate"}'`
    );
    await expect(runnerFor(command).run({ ...baseInput, repositoryPath: workspace() })).rejects.toMatchObject({
      code: "GROK_UNAUTHORIZED"
    });
  });

  it("maps usage-limit envelopes to GROK_RATE_LIMITED", async () => {
    const { command } = fakeGrok(
      `echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"rate limit reached"}'`
    );
    await expect(runnerFor(command).run({ ...baseInput, repositoryPath: workspace() })).rejects.toMatchObject({
      code: "GROK_RATE_LIMITED",
      retryable: true,
      statusCode: 429
    });
    expect(mapGrokInfo("Too many requests")).toBe("GROK_RATE_LIMITED");
    expect(mapGrokInfo("quota exceeded")).toBe("GROK_RATE_LIMITED");
  });

  it("maps non-auth failures to GROK_EXECUTION_FAILED", async () => {
    const { command } = fakeGrok(
      `echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"model overloaded"}'`
    );
    await expect(runnerFor(command).run({ ...baseInput, repositoryPath: workspace() })).rejects.toMatchObject({
      code: "GROK_EXECUTION_FAILED"
    });
  });

  it("fails cleanly when the executable is missing", async () => {
    await expect(runnerFor("/nonexistent/grok-binary-xyz").run({
      ...baseInput,
      repositoryPath: workspace()
    })).rejects.toBeInstanceOf(GatewayError);
  });

  it("rejects an oversized stdout envelope before parsing", async () => {
    const { command } = fakeGrok(
      `printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}' "$(printf 'x%.0s' $(seq 1 9000))"`
    );
    const runner = new GrokHeadlessRunner({ command, turnTimeoutMs: 5_000, maxResultBytes: 100 });
    await expect(runner.run({ ...baseInput, repositoryPath: workspace() })).rejects.toMatchObject({
      code: "GROK_EXECUTION_FAILED"
    });
  });

  it("checkReady resolves when the binary runs", async () => {
    const { command } = fakeGrok(`echo "grok 1.0.4"`);
    await expect(runnerFor(command).checkReady()).resolves.toBeUndefined();
  });

  it("does not forward XAI_API_KEY into the child environment", () => {
    expect(buildGrokEnvironment({
      PATH: "/usr/bin",
      HOME: "/tmp",
      XAI_API_KEY: "should-not-leak"
    }).XAI_API_KEY).toBeUndefined();
  });
});
