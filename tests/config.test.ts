import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/infrastructure/config.js";
import { testToken } from "./helpers.js";

function validEnv(): NodeJS.ProcessEnv {
  return {
    CODEXGW_API_TOKEN: testToken,
    CODEXGW_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    CODEXGW_REPOSITORIES_JSON: JSON.stringify([{ id: "gateway", path: process.cwd() }]),
    CODEXGW_CODEX_HOME: `/tmp/nonexistent-codexgw-test-${process.pid}`
  };
}

describe("loadConfig", () => {
  it("loads canonical repository targets without exposing client paths", () => {
    const config = loadConfig(validEnv());
    expect(config.repositories.get("gateway")?.path).toBe(process.cwd());
    expect(config.host).toBe("127.0.0.1");
  });

  it("requires a strong owner token and encryption key", () => {
    expect(() => loadConfig({ ...validEnv(), CODEXGW_API_TOKEN: "short" })).toThrow(/32 characters/);
    expect(() => loadConfig({ ...validEnv(), CODEXGW_DATA_ENCRYPTION_KEY: "bad" })).toThrow(/32 bytes/);
  });

  it("rejects relative repository paths", () => {
    expect(() => loadConfig({
      ...validEnv(),
      CODEXGW_REPOSITORIES_JSON: JSON.stringify([{ id: "gateway", path: "relative" }])
    })).toThrow(/absolute path/);
  });
});
