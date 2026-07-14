import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../src/codex/app-server-client.js";
import { StdioJsonRpcTransport } from "../src/codex/json-rpc.js";
import type { JsonRpcNotification, JsonRpcTransport } from "../src/codex/json-rpc.js";
import type { ApiError } from "../src/utils/errors.js";
import { TEST_CONFIG } from "./helpers.js";

class FakeJsonRpcTransport implements JsonRpcTransport {
  calls: Array<{ method: string; params: unknown; type: "request" | "notify" }> = [];
  responses = new Map<string, unknown>();
  notifications: JsonRpcNotification[] = [];

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params, type: "request" });
    const response = this.responses.get(method);
    if (response instanceof Error) {
      throw response;
    }
    return response as T;
  }

  notify(method: string, params?: unknown): void {
    this.calls.push({ method, params, type: "notify" });
  }

  async waitForNotification(
    predicate: (notification: JsonRpcNotification) => boolean
  ): Promise<JsonRpcNotification> {
    const index = this.notifications.findIndex(predicate);
    if (index < 0) {
      throw new Error("no matching notification");
    }
    const [notification] = this.notifications.splice(index, 1);
    return notification as JsonRpcNotification;
  }

  close(): void {}
}

describe("CodexAppServerClient", () => {
  it("initializes app-server and runs a task through thread and turn APIs", async () => {
    const transport = new FakeJsonRpcTransport();
    transport.responses.set("initialize", {});
    transport.responses.set("thread/start", { thread: { id: "thr_test" } });
    transport.responses.set("turn/start", { turn: { id: "turn_test" } });
    transport.notifications.push(
      {
        method: "item/completed",
        params: {
          item: {
            id: "turn_test",
            type: "agentMessage",
            phase: "final_answer",
            text: "Done from /Users/name/project"
          }
        }
      },
      {
        method: "item/completed",
        params: {
          item: {
            id: "file_change",
            type: "fileChange",
            status: "completed",
            changes: [{ path: "README.md" }, { path: "/tmp/secret" }]
          }
        }
      },
      { method: "turn/completed", params: { turn: { id: "turn_test", status: "completed" } } }
    );

    const client = new CodexAppServerClient(TEST_CONFIG, { transport });
    const result = await client.runTask({
      prompt: "Summarize",
      cwd: "/repo",
      mode: "workspace-write"
    });

    expect(transport.calls.map((call) => `${call.type}:${call.method}`)).toEqual([
      "request:initialize",
      "notify:initialized",
      "request:thread/start",
      "request:turn/start"
    ]);
    expect(result).toEqual({
      provider: "codex",
      backend: "app-server",
      threadId: "thr_test",
      summary: "Done from [redacted-path]",
      changedFiles: ["README.md"]
    });
    expect(transport.calls[2]?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "workspace-write"
    });
    expect(transport.calls[3]?.params).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/repo"],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true
      }
    });
  });

  it("uses account/read and device-code login without returning secrets", async () => {
    const transport = new FakeJsonRpcTransport();
    transport.responses.set("initialize", {});
    transport.responses.set("account/read", {
      account: { type: "chatgpt", email: "user@example.com", planType: "plus", accessToken: "secret" },
      requiresOpenaiAuth: false
    });
    transport.responses.set("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "login_test",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      deviceCode: "secret"
    });

    const client = new CodexAppServerClient(TEST_CONFIG, { transport });

    await expect(client.getAccount()).resolves.toEqual({
      account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
      requiresOpenaiAuth: false
    });
    await expect(client.startDeviceCodeLogin()).resolves.toEqual({
      type: "chatgptDeviceCode",
      loginId: "login_test",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234"
    });

    transport.responses.set("account/logout", {});
    await client.logout();
    expect(transport.calls.at(-1)).toEqual({
      method: "account/logout",
      params: undefined,
      type: "request"
    });
  });

  it("forwards outputSchema to turn/start and parses the final answer as structured output", async () => {
    const transport = new FakeJsonRpcTransport();
    transport.responses.set("initialize", {});
    transport.responses.set("thread/start", { thread: { id: "thr_test" } });
    transport.responses.set("turn/start", { turn: { id: "turn_test" } });
    transport.notifications.push(
      {
        method: "item/completed",
        params: {
          item: {
            id: "turn_test",
            type: "agentMessage",
            phase: "final_answer",
            text: '{"verdict":"revise","confidence":0.8,"summary":"needs work in /Users/name/project"}'
          }
        }
      },
      { method: "turn/completed", params: { turn: { id: "turn_test", status: "completed" } } }
    );

    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const client = new CodexAppServerClient(TEST_CONFIG, { transport });
    const result = await client.runTask({
      prompt: "Review",
      cwd: "/repo",
      mode: "read-only",
      outputSchema: schema
    });

    expect(transport.calls[3]?.params).toMatchObject({ outputSchema: schema });
    // structuredOutput stays raw at this layer; JSON-aware sanitization
    // happens on API egress, not here.
    expect(result.structuredOutput).toEqual({
      verdict: "revise",
      confidence: 0.8,
      summary: "needs work in /Users/name/project"
    });
    expect(result.summary).toBe('{"verdict":"revise","confidence":0.8,"summary":"needs work in [redacted-path]"}');
  });

  it("tolerates a markdown-fenced final answer when a schema was requested", async () => {
    const transport = new FakeJsonRpcTransport();
    transport.responses.set("initialize", {});
    transport.responses.set("thread/start", { thread: { id: "thr_test" } });
    transport.responses.set("turn/start", { turn: { id: "turn_test" } });
    transport.notifications.push(
      {
        method: "item/completed",
        params: {
          item: {
            id: "turn_test",
            type: "agentMessage",
            phase: "final_answer",
            text: '```json\n{"verdict":"accept"}\n```'
          }
        }
      },
      { method: "turn/completed", params: { turn: { id: "turn_test", status: "completed" } } }
    );

    const client = new CodexAppServerClient(TEST_CONFIG, { transport });
    const result = await client.runTask({
      prompt: "Review",
      cwd: "/repo",
      mode: "read-only",
      outputSchema: { type: "object" }
    });

    expect(result.structuredOutput).toEqual({ verdict: "accept" });
  });

  it("fails closed when the final answer does not parse despite a requested schema", async () => {
    const transport = new FakeJsonRpcTransport();
    transport.responses.set("initialize", {});
    transport.responses.set("thread/start", { thread: { id: "thr_test" } });
    transport.responses.set("turn/start", { turn: { id: "turn_test" } });
    transport.notifications.push(
      {
        method: "item/completed",
        params: {
          item: {
            id: "turn_test",
            type: "agentMessage",
            phase: "final_answer",
            text: "Sorry, I could not produce JSON."
          }
        }
      },
      { method: "turn/completed", params: { turn: { id: "turn_test", status: "completed" } } }
    );

    const client = new CodexAppServerClient(TEST_CONFIG, { transport });
    await expect(
      client.runTask({
        prompt: "Review",
        cwd: "/repo",
        mode: "read-only",
        outputSchema: { type: "object" }
      })
    ).rejects.toMatchObject({
      code: "STRUCTURED_OUTPUT_INVALID",
      statusCode: 500
    } satisfies Partial<ApiError>);
  });

  it("does not attempt structured parsing for an interrupted turn", async () => {
    const transport = new FakeJsonRpcTransport();
    transport.responses.set("initialize", {});
    transport.responses.set("thread/start", { thread: { id: "thr_test" } });
    transport.responses.set("turn/start", { turn: { id: "turn_test" } });
    transport.notifications.push({
      method: "turn/completed",
      params: { turn: { id: "turn_test", status: "interrupted" } }
    });

    const client = new CodexAppServerClient(TEST_CONFIG, { transport });
    const result = await client.runTask({
      prompt: "Review",
      cwd: "/repo",
      mode: "read-only",
      outputSchema: { type: "object" }
    });

    expect(result.structuredOutput).toBeUndefined();
    expect(result.summary).toBe("Task interrupted");
  });

  it("classifies Codex configuration failures separately from runtime failures", async () => {
    const authTransport = new FakeJsonRpcTransport();
    authTransport.responses.set("initialize", new Error("Authentication credentials are not configured"));
    const authClient = new CodexAppServerClient(TEST_CONFIG, { transport: authTransport });

    await expect(authClient.getAccount()).rejects.toMatchObject({
      code: "CODEX_NOT_CONFIGURED",
      statusCode: 501
    } satisfies Partial<ApiError>);

    const runtimeTransport = new FakeJsonRpcTransport();
    runtimeTransport.responses.set("initialize", {});
    runtimeTransport.responses.set("thread/start", new Error("sandbox process exited"));
    const runtimeClient = new CodexAppServerClient(TEST_CONFIG, { transport: runtimeTransport });

    await expect(
      runtimeClient.runTask({
        prompt: "Run",
        cwd: "/repo",
        mode: "read-only"
      })
    ).rejects.toMatchObject({
      code: "CODEX_EXECUTION_FAILED",
      statusCode: 500
    } satisfies Partial<ApiError>);
  });
});

describe("StdioJsonRpcTransport", () => {
  it("rejects server-initiated requests so app-server does not wait forever", async () => {
    const writes: string[] = [];
    const stdout = new PassThrough();
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString());
        callback();
      }
    });
    const proc = {
      stdout,
      stdin,
      once: () => proc,
      kill: () => true
    };

    new StdioJsonRpcTransport("codex", ["app-server"], {}, proc as never);
    stdout.write(
      `${JSON.stringify({
        id: 7,
        method: "item/permissions/requestApproval",
        params: { reason: "needs permissions" }
      })}\n`
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] as string)).toEqual({
      id: 7,
      error: {
        code: -32000,
        message: "Gateway does not permit Codex app-server request: item/permissions/requestApproval"
      }
    });
  });
});
