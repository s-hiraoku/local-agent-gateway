import { describe, expect, it } from "vitest";
import { authHeader, issueToken, makeTestApp } from "./helpers.js";

describe("audit log API", () => {
  it("lists sanitized audit logs for audit readers", async () => {
    const { app, db } = makeTestApp();
    const actor = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);
    const auditor = issueToken(db, ["audit:read"], { name: "auditor" });
    const prompt = "Sensitive prompt text that must not be stored";

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(actor.token),
      payload: {
        repo: "local-agent-gateway",
        prompt,
        mode: "read-only"
      }
    });
    expect(created.statusCode).toBe(202);

    const response = await app.inject({
      method: "GET",
      url: "/v1/audit-logs?action=tasks:create&limit=10",
      headers: authHeader(auditor.token)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().auditLogs).toHaveLength(1);
    expect(response.json().auditLogs[0]).toMatchObject({
      action: "tasks:create",
      repo: "local-agent-gateway",
      mode: "read-only",
      status: "success",
      promptPreview: `[prompt omitted; length=${prompt.length}]`
    });
    expect(response.json().auditLogs[0].promptHash).toHaveLength(64);
    expect(JSON.stringify(response.json())).not.toContain(prompt);
    expect(JSON.stringify(response.json())).not.toContain("tokenHash");
  });

  it("requires audit:read and validates audit query filters", async () => {
    const { app, db } = makeTestApp();
    const taskReader = issueToken(db, ["task:read"]);
    const auditor = issueToken(db, ["audit:read"], { name: "auditor" });

    const missingScope = await app.inject({
      method: "GET",
      url: "/v1/audit-logs",
      headers: authHeader(taskReader.token)
    });
    expect(missingScope.statusCode).toBe(403);

    const invalidQuery = await app.inject({
      method: "GET",
      url: "/v1/audit-logs?unexpected=true",
      headers: authHeader(auditor.token)
    });
    expect(invalidQuery.statusCode).toBe(400);
    expect(invalidQuery.json().error.code).toBe("VALIDATION_ERROR");
  });
});
