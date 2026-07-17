import type { GatewayConfig } from "../src/infrastructure/config.js";

export const testToken = "test-token-abcdefghijklmnopqrstuvwxyz-123456";

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const repository = { id: "gateway", path: process.cwd() };
  return {
    host: "127.0.0.1",
    port: 8787,
    databasePath: ":memory:",
    apiToken: testToken,
    encryptionKey: Buffer.alloc(32, 7),
    repositories: new Map([[repository.id, repository]]),
    codexCommand: "codex",
    codexHome: "/tmp/codexgw-test-home",
    maxQueuedJobs: 10,
    maxConcurrentJobs: 1,
    maxPromptBytes: 64 * 1024,
    maxResultBytes: 1024 * 1024,
    maxEventBytes: 64 * 1024,
    maxEventsPerJob: 10_000,
    rpcTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
    retentionDays: 14,
    ...overrides
  };
}

export const authorization = { authorization: `Bearer ${testToken}` };
