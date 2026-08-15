import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHeadlessRunner, mapClaudeInfo } from "../src/adapters/claude/runner.js";
import { GatewayError } from "../src/domain/errors.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Write a fake `claude` executable that emits a canned response. Tests that
// need to inspect flags or the prompt can record argv/stdin themselves.
function fakeClaude(script: string): { command: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "codexgw-claude-fake-"));
  directories.push(dir);
  const command = join(dir, "claude");
  writeFileSync(command, `#!/bin/sh\n${script}\n`);
  chmodSync(command, 0o755);
  return { command, dir };
}

function runnerFor(command: string) {
  return new ClaudeHeadlessRunner({ command, turnTimeoutMs: 5_000, maxResultBytes: 1024 * 1024 });
}

function readNulSeparated(path: string): string[] {
  return readFileSync(path).toString("utf8").split("\0").slice(0, -1);
}

const baseInput = {
  repositoryPath: "/tmp",
  backendThreadId: null,
  prompt: "review this",
  outputSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false },
  signal: new AbortController().signal,
  onEvent: async () => undefined
};

describe("ClaudeHeadlessRunner", () => {
  it("returns the native structured_output object as the result", async () => {
    const { command } = fakeClaude(
      `cat >/dev/null\n` +
      `echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1","result":"{\\"verdict\\":\\"revise\\"}","structured_output":{"verdict":"revise"}}'`
    );
    const runner = runnerFor(command);
    const result = await runner.run(baseInput);
    expect(JSON.parse(result.result)).toEqual({ verdict: "revise" });
    expect(result.backendThreadId).toBe("sess-1");
  });

  it("sends the prompt on stdin and disables all tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codexgw-claude-argv-"));
    directories.push(dir);
    const argvFile = join(dir, "argv");
    const stdinFile = join(dir, "stdin");
    const { command } = fakeClaude(
      `printf '%s\\0' "$@" > "${argvFile}"\n` +
      `cat > "${stdinFile}"\n` +
      `echo '{"type":"result","subtype":"success","is_error":false,"structured_output":{"verdict":"accept"}}'`
    );
    await runnerFor(command).run(baseInput);
    const tokens = readNulSeparated(argvFile);
    expect(tokens).toContain("--json-schema");
    expect(tokens).toContain("--output-format");
    expect(tokens).toContain("--safe-mode");
    expect(tokens).toContain("--tools");
    expect(tokens[tokens.indexOf("--tools") + 1]).toBe("");
    expect(tokens.at(-2)).toBe("--tools");
    expect(tokens).not.toContain("--disallowed-tools");
    expect(tokens).not.toContain(baseInput.prompt);
    expect(readFileSync(stdinFile, "utf8")).toBe(baseInput.prompt);
  });

  it("omits --json-schema when the turn has no output schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codexgw-claude-argv-"));
    directories.push(dir);
    const argvFile = join(dir, "argv");
    const { command } = fakeClaude(
      `printf '%s\\0' "$@" > "${argvFile}"\n` +
      `cat >/dev/null\n` +
      `echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'`
    );
    const { outputSchema: _omitted, ...withoutSchema } = baseInput;
    await runnerFor(command).run(withoutSchema);
    const tokens = readNulSeparated(argvFile);
    expect(tokens).not.toContain("--json-schema");
    expect(tokens).toContain("--tools");
  });

  it("maps an is_error envelope to a Claude error", async () => {
    const { command } = fakeClaude(
      `echo '{"type":"result","subtype":"success","is_error":true,"result":"Please run /login to authenticate"}'`
    );
    await expect(runnerFor(command).run(baseInput)).rejects.toMatchObject({
      code: "CLAUDE_UNAUTHORIZED"
    });
  });

  it("maps usage-limit envelopes to CLAUDE_RATE_LIMITED", async () => {
    const { command } = fakeClaude(
      `echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"rate limit reached"}'`
    );
    await expect(runnerFor(command).run(baseInput)).rejects.toMatchObject({
      code: "CLAUDE_RATE_LIMITED",
      retryable: true,
      statusCode: 429
    });
    expect(mapClaudeInfo("Too many requests")).toBe("CLAUDE_RATE_LIMITED");
    expect(mapClaudeInfo("quota exceeded")).toBe("CLAUDE_RATE_LIMITED");
  });

  it("maps non-auth failures to CLAUDE_EXECUTION_FAILED", async () => {
    const { command } = fakeClaude(
      `echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"model overloaded"}'`
    );
    await expect(runnerFor(command).run(baseInput)).rejects.toMatchObject({
      code: "CLAUDE_EXECUTION_FAILED"
    });
  });

  it("fails cleanly when the executable is missing", async () => {
    const runner = runnerFor("/nonexistent/claude-binary-xyz");
    await expect(runner.run(baseInput)).rejects.toBeInstanceOf(GatewayError);
  });

  it("rejects an oversized stdout envelope before parsing", async () => {
    const { command } = fakeClaude(
      `printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}' "$(printf 'x%.0s' $(seq 1 9000))"`
    );
    const runner = new ClaudeHeadlessRunner({ command, turnTimeoutMs: 5_000, maxResultBytes: 100 });
    await expect(runner.run(baseInput)).rejects.toMatchObject({
      code: "CLAUDE_EXECUTION_FAILED"
    });
  });

  it("bounds an oversized result to maxResultBytes", async () => {
    const { command } = fakeClaude(
      `printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}' "$(printf 'x%.0s' $(seq 1 500))"`
    );
    const runner = new ClaudeHeadlessRunner({ command, turnTimeoutMs: 5_000, maxResultBytes: 100 });
    const result = await runner.run(baseInput);
    expect(Buffer.byteLength(result.result)).toBeLessThanOrEqual(100);
  });

  it("checkReady resolves when the binary runs", async () => {
    const { command } = fakeClaude(`echo "2.1.0 (Claude Code)"`);
    await expect(runnerFor(command).checkReady()).resolves.toBeUndefined();
  });
});
