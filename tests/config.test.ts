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

  it("defaults retention to 14 days and rejects non-positive values", () => {
    expect(loadConfig(validEnv()).retentionDays).toBe(14);
    expect(loadConfig({ ...validEnv(), CODEXGW_RETENTION_DAYS: "30" }).retentionDays).toBe(30);
    expect(() => loadConfig({ ...validEnv(), CODEXGW_RETENTION_DAYS: "0" })).toThrow(/positive integer/);
  });

  it("allows an empty repository registry for inference-only gateways", () => {
    const config = loadConfig({ ...validEnv(), CODEXGW_REPOSITORIES_JSON: "[]" });
    expect(config.repositories.size).toBe(0);
  });

  it("keeps OpenAI compatibility opt-in and loopback-only", () => {
    expect(loadConfig(validEnv()).openaiCompatibilityEnabled).toBe(false);
    expect(loadConfig({
      ...validEnv(),
      CODEXGW_OPENAI_COMPATIBILITY_ENABLED: "true"
    }).openaiCompatibilityEnabled).toBe(true);
    expect(loadConfig({
      ...validEnv(),
      CODEXGW_OPENAI_COMPATIBILITY_ENABLED: "true",
      CODEXGW_HOST: "::1"
    }).openaiCompatibilityEnabled).toBe(true);
    expect(() => loadConfig({
      ...validEnv(),
      CODEXGW_OPENAI_COMPATIBILITY_ENABLED: "true",
      CODEXGW_HOST: "0.0.0.0"
    })).toThrow(/loopback/);
    expect(() => loadConfig({
      ...validEnv(),
      CODEXGW_OPENAI_COMPATIBILITY_ENABLED: "yes"
    })).toThrow(/true or false/);
  });

  it("defaults the inference provider to codex and accepts claude", () => {
    expect(loadConfig(validEnv()).inferenceProvider).toBe("codex");
    expect(loadConfig({
      ...validEnv(),
      CODEXGW_INFERENCE_PROVIDER: "claude"
    }).inferenceProvider).toBe("claude");
    expect(() => loadConfig({
      ...validEnv(),
      CODEXGW_INFERENCE_PROVIDER: "gpt"
    })).toThrow(/'codex' or 'claude'/);
  });

  it("defaults the Claude command and leaves the model unset", () => {
    const config = loadConfig(validEnv());
    expect(config.claudeCommand).toBe("claude");
    expect(config.claudeModel).toBeUndefined();
    const overridden = loadConfig({
      ...validEnv(),
      CODEXGW_CLAUDE_COMMAND: "/usr/local/bin/claude",
      CODEXGW_CLAUDE_MODEL: "claude-opus-5"
    });
    expect(overridden.claudeCommand).toBe("/usr/local/bin/claude");
    expect(overridden.claudeModel).toBe("claude-opus-5");
  });

  it("still requires CODEXGW_REPOSITORIES_JSON to be present and an array", () => {
    const { CODEXGW_REPOSITORIES_JSON: _omitted, ...withoutRepos } = validEnv();
    void _omitted;
    expect(() => loadConfig(withoutRepos)).toThrow(/required/);
    expect(() => loadConfig({ ...validEnv(), CODEXGW_REPOSITORIES_JSON: "{}" })).toThrow(/must be a JSON array/);
  });

  it("rejects relative repository paths", () => {
    expect(() => loadConfig({
      ...validEnv(),
      CODEXGW_REPOSITORIES_JSON: JSON.stringify([{ id: "gateway", path: "relative" }])
    })).toThrow(/absolute path/);
  });
});
