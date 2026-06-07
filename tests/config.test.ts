import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("rejects the default token pepper in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        TOKEN_PEPPER: "change-me-to-a-long-random-secret"
      })
    ).toThrow();
  });

  it("rejects bootstrap token in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        TOKEN_PEPPER: "production-secret",
        BOOTSTRAP_ADMIN_TOKEN: "bootstrap"
      })
    ).toThrow();
  });

  it("rejects missing repo allowlist in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        TOKEN_PEPPER: "production-secret"
      })
    ).toThrow();
  });

  it("accepts an explicit Codex app-server model override", () => {
    expect(
      loadConfig({
        CODEX_APP_SERVER_MODEL: "gpt-5.4-mini"
      }).CODEX_APP_SERVER_MODEL
    ).toBe("gpt-5.4-mini");
  });

  it("loads a bounded read-only concurrency limit", () => {
    expect(
      loadConfig({
        CODEXGW_MAX_PARALLEL_READ_TASKS: "2"
      }).CODEXGW_MAX_PARALLEL_READ_TASKS
    ).toBe(2);

    expect(() =>
      loadConfig({
        CODEXGW_MAX_PARALLEL_READ_TASKS: "0"
      })
    ).toThrow();
  });
});
