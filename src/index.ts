import { mkdirSync } from "node:fs";
import { buildApp } from "./app.js";
import { limaAppServerLauncher } from "./adapters/codex/launcher.js";
import { defaultLimaClient } from "./adapters/codex/lima/client.js";
import { CodexAppServerRunner } from "./adapters/codex/runner.js";
import { ClaudeHeadlessRunner } from "./adapters/claude/runner.js";
import type { CodingRunner } from "./adapters/runner.js";
import { JobProcessor } from "./application/job-processor.js";
import { GatewayStore } from "./application/store.js";
import { loadConfig } from "./infrastructure/config.js";
import { SecretBox } from "./infrastructure/crypto.js";
import { openDatabase } from "./infrastructure/database.js";

const config = loadConfig();
mkdirSync(config.inferenceWorkspaceRoot, { recursive: true, mode: 0o700 });
const database = openDatabase(config.databasePath);
const secrets = new SecretBox(config.encryptionKey);
const store = new GatewayStore(database.db, secrets, {
  maxEventBytes: config.maxEventBytes,
  maxEventsPerJob: config.maxEventsPerJob,
  maxResultBytes: config.maxResultBytes
});
// Coding turns always run on Codex (repository/sandbox isolation is
// codex-specific). Inference turns run on the configured provider.
const limaLauncher = config.codexExecutor === "lima"
  ? limaAppServerLauncher(defaultLimaClient({
      limactl: config.limaCommand,
      instance: config.limaInstance,
      guestCodexCommand: config.codexCommand
    }))
  : undefined;
const codexRunner = new CodexAppServerRunner({
  command: config.codexCommand,
  codexHome: config.codexHome,
  ...(config.codexModel ? { model: config.codexModel } : {}),
  rpcTimeoutMs: config.rpcTimeoutMs,
  turnTimeoutMs: config.turnTimeoutMs,
  maxResultBytes: config.maxResultBytes,
  ...(limaLauncher ? { launcher: limaLauncher } : {})
});
const claudeRunner = new ClaudeHeadlessRunner({
  command: config.claudeCommand,
  ...(config.claudeModel ? { model: config.claudeModel } : {}),
  turnTimeoutMs: config.turnTimeoutMs,
  maxResultBytes: config.maxResultBytes
});
const inferenceRunner: CodingRunner = config.inferenceProvider === "claude" ? claudeRunner : codexRunner;
const processor = new JobProcessor(
  store,
  { coding: codexRunner, inference: inferenceRunner },
  config.repositories,
  config.maxConcurrentJobs,
  config.inferenceWorkspaceRoot
);
const app = await buildApp({
  config,
  store,
  processor,
  closeDatabase: database.close,
  // Probe every distinct active runner so readiness reflects the real backends.
  readinessProbe: async () => {
    await codexRunner.checkReady();
    if (inferenceRunner !== codexRunner) await inferenceRunner.checkReady();
  }
});

let closing = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "gateway shutdown started");
  await app.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await store.assertEncryptionKey();
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
