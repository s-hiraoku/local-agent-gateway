import { describe, expect, it } from "vitest";
import { authHeader, issueToken, makeTestApp } from "./helpers.js";

describe("providers", () => {
  it("lists available task providers without exposing backend internals", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:read"]);

    const response = await app.inject({
      method: "GET",
      url: "/v1/providers",
      headers: authHeader(token.token)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providers: [
        {
          id: "codex",
          label: "Codex",
          capabilities: {
            readOnly: true,
            workspaceWrite: true,
            streamEvents: true,
            diffArtifacts: true,
            accountAuth: true,
            cancel: false,
            steer: false,
            models: false
          }
        }
      ]
    });
    expect(JSON.stringify(response.json())).not.toContain("app-server");
  });

  it("requires task read authorization", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["token:read"]);

    const response = await app.inject({
      method: "GET",
      url: "/v1/providers",
      headers: authHeader(token.token)
    });

    expect(response.statusCode).toBe(403);
  });
});
