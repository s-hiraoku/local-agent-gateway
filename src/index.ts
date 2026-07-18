import { mkdirSync } from "node:fs";
import { buildApp } from "./app.js";
import { CodexAppServerRunner } from "./adapters/codex/runner.js";
import { JobProcessor } from "./application/job-processor.js";
import { GatewayStore } from "./application/store.js";
import { loadConfig } from "./infrastructure/config.js";
import { SecretBox } from "./infrastructure/crypto.js";
import { openDatabase } from "./infrastructure/database.js";

const config = loadConfig();
mkdirSync(config.inferenceWorkspaceRoot, { recursive: true, mode: 0o700 });
const database = openDatabase(config.databasePath);
const store = new GatewayStore(database.db, new SecretBox(config.encryptionKey), {
  maxEventBytes: config.maxEventBytes,
  maxEventsPerJob: config.maxEventsPerJob,
  maxResultBytes: config.maxResultBytes
});
const runner = new CodexAppServerRunner({
  command: config.codexCommand,
  codexHome: config.codexHome,
  ...(config.codexModel ? { model: config.codexModel } : {}),
  rpcTimeoutMs: config.rpcTimeoutMs,
  turnTimeoutMs: config.turnTimeoutMs,
  maxResultBytes: config.maxResultBytes
});
const processor = new JobProcessor(store, runner, config.repositories, config.maxConcurrentJobs, config.inferenceWorkspaceRoot);
const app = await buildApp({
  config,
  store,
  processor,
  closeDatabase: database.close,
  readinessProbe: () => runner.checkReady()
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
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
