import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "../src/infrastructure/config.js";
import type { Clock } from "../src/mcp/client.js";
import { gatewayHostname, loadMcpAdapterConfig, parseLoopbackOrigin } from "../src/mcp/config.js";
import { McpFrameDecoder } from "../src/mcp/protocol.js";
import { runMcpStdio } from "../src/mcp/stdio.js";
import { testToken } from "./helpers.js";

const jobId = "job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const conversationId = "cnv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const secretToken = "super-secret-token-value-0123456789abcd";

describe("MCP loopback origin", () => {
  it("accepts the same loopback hosts the Gateway uses and rejects everything else", () => {
    expect(parseLoopbackOrigin("http://127.0.0.1:8787").origin).toBe("http://127.0.0.1:8787");
    expect(parseLoopbackOrigin("https://localhost:8787").protocol).toBe("https:");
    expect(gatewayHostname(parseLoopbackOrigin("http://[::1]:8787"))).toBe("::1");
    for (const host of ["127.0.0.1", "::1", "localhost", "0.0.0.0", "10.1.2.3", "example.com"]) {
      const allowed = isLoopbackHost(host);
      const raw = host.includes(":") ? `http://[${host}]:8787` : `http://${host}:8787`;
      if (allowed) {
        expect(gatewayHostname(parseLoopbackOrigin(raw))).toBe(host);
      } else {
        expect(() => parseLoopbackOrigin(raw)).toThrow(/loopback host/);
      }
    }
  });

  it("refuses userinfo, paths, and non-http URLs without echoing the token", () => {
    let thrown: unknown;
    try {
      parseLoopbackOrigin(`http://${secretToken}@127.0.0.1:8787`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/userinfo/);
    expect((thrown as Error).message).not.toContain(secretToken);
    expect(() => parseLoopbackOrigin("http://127.0.0.1:8787/v2/inference/runs")).toThrow(/path, query, or fragment/);
    expect(() => parseLoopbackOrigin("http://127.0.0.1:8787?x=1")).toThrow(/path, query, or fragment/);
    expect(() => parseLoopbackOrigin("file:///tmp/gateway")).toThrow(/http or https/);
    expect(() => loadMcpAdapterConfig({
      CODEXGW_API_TOKEN: "short",
      CODEXGW_BASE_URL: "http://127.0.0.1:8787"
    })).toThrow(/32 characters/);
    expect(() => loadMcpAdapterConfig({ CODEXGW_API_TOKEN: testToken })).not.toThrow();
    expect(loadMcpAdapterConfig({ CODEXGW_API_TOKEN: testToken }).origin.href).toBe("http://127.0.0.1:8787/");
  });
});

describe("MCP inference stdio", () => {
  it("lists only inference tools and calls POST /v2/inference/runs with the bearer token", async () => {
    const seen: Array<{ method: string; url: string; authorization: string | undefined; idempotencyKey: string | undefined; body: string }> = [];
    let gets = 0;
    const gateway = await listen((req, res) => {
      const bodyChunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(bodyChunks).toString("utf8");
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          authorization: req.headers.authorization,
          idempotencyKey: typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : undefined,
          body
        });
        if (req.method === "POST" && req.url === "/v2/inference/runs") {
          json(res, 202, { jobId, conversationId, status: "queued", replayed: false });
          return;
        }
        if (req.method === "GET" && req.url === `/v2/jobs/${jobId}`) {
          gets += 1;
          json(res, 200, jobBody(gets === 1 ? "queued" : "completed", { verdict: "revise" }));
          return;
        }
        json(res, 404, { error: { code: "NOT_FOUND", message: "missing", retryable: false } });
      });
    });
    const clock = manualClock();
    try {
      const responses = await exchange(gateway.origin, clock, [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "run_inference",
            arguments: {
              prompt: "Return a review verdict.",
              outputSchema: {
                type: "object",
                properties: { verdict: { type: "string" } },
                required: ["verdict"],
                additionalProperties: false
              },
              idempotencyKey: "decision-review-019f"
            }
          }
        }
      ]);
      expect(responses.map((response) => response.id)).toEqual([1, 2, 3]);
      expect(responses[0]?.result).toMatchObject({
        protocolVersion: "2025-03-26",
        serverInfo: { name: "local-agent-gateway", version: "2.0.0" }
      });
      const listed = responses[1]?.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } | undefined;
      if (listed === undefined) throw new Error("tools/list returned no result");
      const tools = listed.tools;
      expect(tools.map((tool) => tool.name)).toEqual(["run_inference", "get_inference_job"]);
      const runInference = tools[0];
      if (runInference === undefined) throw new Error("run_inference was not listed");
      expect(Object.keys(runInference.inputSchema.properties)).toEqual(["prompt", "outputSchema", "idempotencyKey"]);
      const completed = responses[2]?.result as { content: Array<{ text: string }> } | undefined;
      const completedText = completed?.content?.[0]?.text;
      if (completedText === undefined) throw new Error("run_inference returned no text");
      expect(JSON.parse(completedText)).toEqual({
        id: jobId,
        conversationId,
        repositoryId: null,
        kind: "inference.turn",
        status: "completed",
        createdAt: "2026-09-23T00:00:00.000Z",
        startedAt: "2026-09-23T00:00:01.000Z",
        completedAt: "2026-09-23T00:00:08.000Z",
        result: "{\"verdict\":\"revise\"}",
        structuredOutput: { verdict: "revise" },
        error: null
      });
      expect(seen.map((hit) => `${hit.method} ${hit.url}`)).toEqual([
        "POST /v2/inference/runs",
        `GET /v2/jobs/${jobId}`,
        `GET /v2/jobs/${jobId}`
      ]);
      expect(seen[0]).toMatchObject({
        authorization: `Bearer ${testToken}`,
        idempotencyKey: "decision-review-019f",
        body: JSON.stringify({
          prompt: "Return a review verdict.",
          outputSchema: {
            type: "object",
            properties: { verdict: { type: "string" } },
            required: ["verdict"],
            additionalProperties: false
          }
        })
      });
      expect(clock.sleeps).toEqual([500]);
    } finally {
      await gateway.close();
    }
  });

  it("returns a timeout payload with the job id and does not echo the prompt or token", async () => {
    let idempotencyKey = "";
    const gateway = await listen((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        if (typeof req.headers["idempotency-key"] === "string") {
          idempotencyKey = req.headers["idempotency-key"];
        }
        if (req.method === "POST") {
          json(res, 202, { jobId, conversationId, status: "queued", replayed: false });
          return;
        }
        json(res, 200, jobBody("running", null));
      });
    });
    const clock = manualClock();
    try {
      const responses = await exchange(gateway.origin, clock, [
        {
          jsonrpc: "2.0",
          id: "run",
          method: "tools/call",
          params: { name: "run_inference", arguments: { prompt: "do not leak this prompt" } }
        }
      ], { CODEXGW_MCP_POLL_INTERVAL_MS: "500", CODEXGW_MCP_TIMEOUT_MS: "1000" });
      const result = responses[0]?.result as { isError: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
        code: "INFERENCE_TIMEOUT",
        message: "Inference run did not finish before the MCP timeout",
        jobId,
        status: "running"
      });
      expect(result.content[0]?.text).not.toContain("do not leak this prompt");
      expect(result.content[0]?.text).not.toContain(testToken);
      expect(idempotencyKey).toMatch(/^[a-f0-9]{32}$/);
    } finally {
      await gateway.close();
    }
  });

  it("returns a failed inference job as a tool error and drops private fields", async () => {
    const gateway = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/v2/inference/runs") {
          json(res, 202, { jobId, conversationId, status: "queued", replayed: false });
          return;
        }
        json(res, 200, {
          ...jobBody("failed", null),
          error: { code: "CLAUDE_UNAUTHORIZED", message: "Claude is not logged in", retryable: false }
        });
      });
    });
    try {
      const responses = await exchange(gateway.origin, manualClock(), [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_inference", arguments: { prompt: "hello" } } }
      ]);
      const result = responses[0]?.result as { isError: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
        id: jobId,
        conversationId,
        repositoryId: null,
        kind: "inference.turn",
        status: "failed",
        createdAt: "2026-09-23T00:00:00.000Z",
        startedAt: "2026-09-23T00:00:01.000Z",
        completedAt: null,
        result: null,
        structuredOutput: null,
        error: { code: "CLAUDE_UNAUTHORIZED", message: "Claude is not logged in", retryable: false }
      });
      expect(result.content[0]?.text).not.toContain("private-workspace");
      expect(result.content[0]?.text).not.toContain("private-thread");
    } finally {
      await gateway.close();
    }
  });

  it("surfaces Gateway auth failures and hides coding jobs, redirects, and the bearer token", async () => {
    const gateway = await listen((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        if (req.url === "/v2/inference/runs") {
          json(res, 401, { error: { code: "AUTH_REQUIRED", message: "Bearer token is invalid", retryable: false } });
          return;
        }
        if (req.url === `/v2/jobs/${jobId}`) {
          json(res, 200, {
            ...jobBody("completed", null),
            kind: "coding.turn",
            repositoryId: "/tmp/secret-repo"
          });
          return;
        }
        if (req.url === "/redirect") {
          res.writeHead(302, { Location: `http://evil.example/?token=${testToken}` });
          res.end();
          return;
        }
        json(res, 404, { error: { code: "NOT_FOUND", message: "missing", retryable: false } });
      });
    });
    try {
      const unauthorized = await exchange(gateway.origin, manualClock(), [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_inference", arguments: { prompt: "hello" } } }
      ]);
      expect(unauthorized[0]?.result).toEqual({
        content: [{ type: "text", text: "AUTH_REQUIRED: Bearer token is invalid" }],
        isError: true
      });
      expect(JSON.stringify(unauthorized)).not.toContain(testToken);

      const coding = await exchange(gateway.origin, manualClock(), [
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_inference_job", arguments: { jobId } } }
      ]);
      expect(coding[0]?.result).toEqual({
        content: [{ type: "text", text: "Gateway returned a non-inference job" }],
        isError: true
      });
      expect(JSON.stringify(coding)).not.toContain("/tmp/secret-repo");

      const missing = await exchange(gateway.origin, manualClock(), [
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_inference", arguments: {} } }
      ]);
      expect(missing[0]?.result).toEqual({
        content: [{ type: "text", text: "prompt is required" }],
        isError: true
      });

      const unknown = await exchange(gateway.origin, manualClock(), [
        { jsonrpc: "2.0", id: 4, method: "resources/list" }
      ]);
      expect(unknown[0]?.error).toEqual({ code: -32601, message: "Method not found" });
    } finally {
      await gateway.close();
    }
  });

  it("refuses a redirect without sending the bearer token to the Location host", async () => {
    const gateway = await listen((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(302, { Location: `http://127.0.0.1:9/steal?token=${testToken}` });
        res.end();
      });
    });
    try {
      const responses = await exchange(gateway.origin, manualClock(), [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_inference", arguments: { prompt: "hello" } } }
      ]);
      expect(responses[0]?.result).toEqual({
        content: [{ type: "text", text: "Gateway redirect was refused" }],
        isError: true
      });
      expect(JSON.stringify(responses)).not.toContain(testToken);
    } finally {
      await gateway.close();
    }
  });

  it("reads a Content-Length frame split across chunks", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const running = runMcpStdio({
      input,
      output,
      env: { CODEXGW_API_TOKEN: testToken, CODEXGW_BASE_URL: "http://127.0.0.1:9" },
      clock: manualClock()
    });
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }), "utf8");
    const header = Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, "utf8");
    input.write(header.subarray(0, 8));
    input.write(Buffer.concat([header.subarray(8), payload.subarray(0, 4)]));
    input.write(payload.subarray(4));
    input.end();
    await running;
    const frames = new McpFrameDecoder().push(Buffer.concat(chunks));
    expect(frames).toEqual([{
      ok: true,
      message: { jsonrpc: "2.0", id: 7, result: {} }
    }]);
  });
});

function jobBody(status: string, structuredOutput: unknown) {
  return {
    id: jobId,
    conversationId,
    repositoryId: null,
    kind: "inference.turn",
    status,
    createdAt: "2026-09-23T00:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-09-23T00:00:01.000Z",
    completedAt: status === "completed" ? "2026-09-23T00:00:08.000Z" : null,
    result: status === "completed" ? "{\"verdict\":\"revise\"}" : null,
    structuredOutput: status === "completed" ? structuredOutput : null,
    error: null,
    cwd: "/tmp/private-workspace",
    backendThreadId: "private-thread"
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test gateway failed to listen");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

function manualClock(): Clock & { sleeps: number[] } {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    }
  };
}

async function exchange(
  origin: string,
  clock: Clock,
  messages: unknown[],
  env: NodeJS.ProcessEnv = {}
): Promise<Array<{ id?: unknown; result?: unknown; error?: unknown }>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const running = runMcpStdio({
    input,
    output,
    env: { CODEXGW_API_TOKEN: testToken, CODEXGW_BASE_URL: origin, ...env },
    clock
  });
  for (const message of messages) input.write(encode(message));
  input.end();
  await running;
  return new McpFrameDecoder().push(Buffer.concat(chunks)).map((frame) => {
    if (!frame.ok) throw new Error("adapter wrote a frame that was not JSON");
    return frame.message as { id?: unknown; result?: unknown; error?: unknown };
  });
}

function encode(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${json.byteLength}\r\n\r\n`, "utf8"), json]);
}
