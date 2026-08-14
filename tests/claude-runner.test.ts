import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHeadlessRunner } from "../src/adapters/claude/runner.js";
import { GatewayError } from "../src/domain/errors.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Write a fake `claude` executable that emits a canned response and records its
// argv so the test can assert the flags the runner passes.
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
      `cat > "$TMPDIR/claude-argv" <<EOF\n$@\nEOF\n` +
      `echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1","result":"{\\"verdict\\":\\"revise\\"}","structured_output":{"verdict":"revise"}}'`
    );
    const runner = runnerFor(command);
    const result = await runner.run(baseInput);
    expect(JSON.parse(result.result)).toEqual({ verdict: "revise" });
    expect(result.backendThreadId).toBe("sess-1");
  });

  it("passes --json-schema and disallows filesystem tools", async () => {
    const argvFile = join(mkdtempSync(join(tmpdir(), "codexgw-claude-argv-")), "argv");
    directories.push(argvFile);
    const { command } = fakeClaude(
      `printf '%s\\n' "$@" > "${argvFile}"\n` +
      `echo '{"type":"result","subtype":"success","is_error":false,"structured_output":{"verdict":"accept"}}'`
    );
    await runnerFor(command).run(baseInput);
    const argv = (await import("node:fs")).readFileSync(argvFile, "utf8");
    expect(argv).toContain("--json-schema");
    expect(argv).toContain("--disallowed-tools");
    expect(argv).toContain("Bash");
    expect(argv).toContain("--output-format");
  });

  it("maps an is_error envelope to a Claude error", async () => {
    const { command } = fakeClaude(
      `echo '{"type":"result","subtype":"success","is_error":true,"result":"Please run /login to authenticate"}'`
    );
    await expect(runnerFor(command).run(baseInput)).rejects.toMatchObject({
      code: "CLAUDE_UNAUTHORIZED"
    });
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

  it("checkReady resolves when the binary runs", async () => {
    const { command } = fakeClaude(`echo "2.1.0 (Claude Code)"`);
    await expect(runnerFor(command).checkReady()).resolves.toBeUndefined();
  });
});
