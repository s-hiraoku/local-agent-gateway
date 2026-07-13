import { describe, expect, it } from "vitest";
import { authHeader, issueToken, makeTestApp } from "./helpers.js";

describe("policy", () => {
  it("rejects unregistered repos", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "not-allowed",
        prompt: "Summarize",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("does not accept raw cwd on task creation", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        cwd: "/tmp/other",
        prompt: "Summarize",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("accepts a registered workspace target without exposing raw paths", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, [
      "task:create",
      "task:read",
      "repo:local-agent-gateway",
      "workspace:local-agent-gateway",
      "mode:read-only"
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        workspaceId: "local-agent-gateway",
        prompt: "Summarize",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      repo: "local-agent-gateway",
      mode: "read-only"
    });
    expect(JSON.stringify(response.json())).not.toContain(process.cwd());
  });

  it("rejects raw workspace paths on task creation", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        workspacePath: "/tmp/other",
        prompt: "Summarize",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("lists registered workspace targets without exposing raw paths", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:read", "repo:local-agent-gateway", "workspace:local-agent-gateway"]);

    const response = await app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: authHeader(token.token)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      workspaces: [
        {
          workspaceId: "local-agent-gateway",
          repo: "local-agent-gateway",
          defaultMode: "read-only",
          allowedModes: ["read-only", "workspace-write"],
          defaultProvider: "codex",
          allowedProviders: ["codex"]
        }
      ]
    });
    expect(JSON.stringify(response.json())).not.toContain(process.cwd());
  });

  it("requires workspace scope when creating a task from a workspace target", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        workspaceId: "local-agent-gateway",
        prompt: "Summarize",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("rejects ambiguous repo and workspace task targets", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, [
      "task:create",
      "repo:local-agent-gateway",
      "workspace:local-agent-gateway",
      "mode:read-only"
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        workspaceId: "local-agent-gateway",
        prompt: "Summarize",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("uses read-only as the default mode", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Summarize"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().mode).toBe("read-only");
  });

  it("rejects danger-full-access", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Summarize",
        mode: "danger-full-access"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects workspace-write for read-only-only repos", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, [
      "task:create",
      "repo:readonly-example",
      "mode:read-only",
      "mode:workspace-write"
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "readonly-example",
        prompt: "Summarize",
        mode: "workspace-write"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("MODE_NOT_ALLOWED");
  });
});
