import { describe, expect, it } from "vitest";
import { authHeader, issueToken, makeTestApp, TEST_CONFIG } from "./helpers.js";

describe("auth", () => {
  it("validates a correct bearer token", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:read"]);

    const response = await app.inject({
      method: "GET",
      url: "/v1/repos",
      headers: authHeader(token.token)
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects missing token with 401", async () => {
    const { app, db } = makeTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/v1/repos"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });

    const row = db.prepare("SELECT token_id, token_name, status, error FROM audit_logs").get() as {
      token_id: string | null;
      token_name: string | null;
      status: string;
      error: string;
    };
    expect(row).toEqual({
      token_id: null,
      token_name: null,
      status: "failure",
      error: "UNAUTHORIZED"
    });
  });

  it("rejects invalid token with 401", async () => {
    const { app } = makeTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/v1/repos",
      headers: authHeader("codexgw_live_invalid")
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects revoked tokens", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:read"]);
    db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), token.id);

    const response = await app.inject({
      method: "GET",
      url: "/v1/repos",
      headers: authHeader(token.token)
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("TOKEN_REVOKED");
  });

  it("rejects expired tokens", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:read"]);
    db.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", token.id);

    const response = await app.inject({
      method: "GET",
      url: "/v1/repos",
      headers: authHeader(token.token)
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("TOKEN_EXPIRED");
  });

  it("does not store raw tokens in the database", async () => {
    const { db } = makeTestApp();
    const token = issueToken(db, ["task:read"]);
    const row = db.prepare("SELECT token_hash, prefix FROM api_tokens WHERE id = ?").get(token.id) as {
      token_hash: string;
      prefix: string;
    };

    expect(row.token_hash).not.toBe(token.token);
    expect(row.token_hash).not.toContain(token.token);
    expect(row.prefix).toBe(token.prefix);
  });

  it("allows bootstrap token to create a scoped token", async () => {
    const { app } = makeTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: authHeader(TEST_CONFIG.BOOTSTRAP_ADMIN_TOKEN ?? ""),
      payload: {
        name: "raycast",
        scopes: ["task:read", "repo:local-agent-gateway", "mode:read-only", "provider:codex"],
        expiresInDays: 30
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().token).toMatch(/^codexgw_live_/);
  });

  it("requires auth outside healthz even for unknown routes", async () => {
    const { app } = makeTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/v1/does-not-exist"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });
});
