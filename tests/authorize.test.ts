import { describe, expect, it } from "vitest";
import { authHeader, FakeTaskRunner, issueToken, makeTestApp } from "./helpers.js";

describe("authorization", () => {
  it("passes when required scopes are present", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Summarize README",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(202);
  });

  it("rejects task create without task:create", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Summarize README",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects task create without repo scope", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Summarize README",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects workspace-write without workspace-write mode scope", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Implement a change",
        mode: "workspace-write"
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects unknown task providers before dispatching a runner", async () => {
    const taskRunner = new FakeTaskRunner();
    const { app, db } = makeTestApp({ taskRunner });
    const token = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        provider: "unknown-agent",
        prompt: "Summarize README",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PROVIDER_NOT_ALLOWED");
    expect(taskRunner.calls).toHaveLength(0);
  });

  it("prevents token:create from minting scopes the caller lacks", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["token:create", "task:read"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: authHeader(token.token),
      payload: {
        name: "escalation",
        scopes: ["task:read", "mode:workspace-write"],
        expiresInDays: 30
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("prevents child tokens from outliving their issuer", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["token:create", "task:read"], { expiresInDays: 1 });

    const response = await app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: authHeader(token.token),
      payload: {
        name: "too-long",
        scopes: ["task:read"],
        expiresInDays: 30
      }
    });

    expect(response.statusCode).toBe(403);
  });
});
