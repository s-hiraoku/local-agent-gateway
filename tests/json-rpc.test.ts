import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { BufferedJsonRpcTransport } from "../src/adapters/codex/json-rpc.js";
import { buildCodexEnvironment } from "../src/adapters/codex/runner.js";

function fakeProcess() {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    kill: vi.fn()
  });
  return process;
}

describe("BufferedJsonRpcTransport", () => {
  it("retains notifications that arrive before a consumer waits", async () => {
    const process = fakeProcess();
    const transport = new BufferedJsonRpcTransport({
      command: "unused",
      args: [],
      env: {},
      requestTimeoutMs: 100,
      process
    });
    process.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-1" } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(transport.nextNotification(50)).resolves.toMatchObject({ method: "turn/completed" });
    transport.close();
  });

  it("drains stderr without exposing it through public errors", async () => {
    const process = fakeProcess();
    const transport = new BufferedJsonRpcTransport({
      command: "unused",
      args: [],
      env: {},
      requestTimeoutMs: 10,
      process
    });
    process.stderr.write("private diagnostic");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(transport.diagnosticStderrTail()).toContain("private diagnostic");
    await expect(transport.request("never/responds")).rejects.not.toThrow(/private diagnostic/);
    transport.close();
  });

  it("fails explicitly instead of dropping terminal events on buffer overflow", async () => {
    const process = fakeProcess();
    const transport = new BufferedJsonRpcTransport({
      command: "unused",
      args: [],
      env: {},
      requestTimeoutMs: 100,
      maxBufferedNotifications: 1,
      process
    });
    process.stdout.write(`${JSON.stringify({ method: "item/started" })}\n`);
    process.stdout.write(`${JSON.stringify({ method: "turn/completed" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(transport.nextNotification(50)).rejects.toThrow(/buffer overflowed/);
    expect(process.kill).toHaveBeenCalled();
    transport.close();
  });
});

describe("buildCodexEnvironment", () => {
  it("passes only explicitly allowed environment variables", () => {
    const child = buildCodexEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      TOKEN_PEPPER: "secret",
      OPENAI_API_KEY: "secret",
      BOOTSTRAP_ADMIN_TOKEN: "secret"
    }, "/isolated/codex-home");
    expect(child.PATH).toBe("/bin");
    expect(child.CODEX_HOME).toBe("/isolated/codex-home");
    expect(child).not.toHaveProperty("TOKEN_PEPPER");
    expect(child).not.toHaveProperty("OPENAI_API_KEY");
    expect(child).not.toHaveProperty("BOOTSTRAP_ADMIN_TOKEN");
  });
});
