import { buildApp } from "../src/app.js";
import type { CodingRunner } from "../src/adapters/codex/runner.js";
import { JobProcessor } from "../src/application/job-processor.js";
import { GatewayStore } from "../src/application/store.js";
import { SecretBox } from "../src/infrastructure/crypto.js";
import { openDatabase } from "../src/infrastructure/database.js";
import type { GatewayConfig } from "../src/infrastructure/config.js";

const token = "smoke-token-abcdefghijklmnopqrstuvwxyz-1234";
const repository = { id: "gateway", path: process.cwd() };
const config: GatewayConfig = {
  host: "127.0.0.1",
  port: 8787,
  databasePath: ":memory:",
  apiToken: token,
  encryptionKey: Buffer.alloc(32, 4),
  repositories: new Map([[repository.id, repository]]),
  codexCommand: "codex",
  codexHome: "/tmp/codexgw-smoke",
  inferenceWorkspaceRoot: "/tmp/codexgw-smoke-inference",
  openaiCompatibilityEnabled: false,
  maxQueuedJobs: 10,
  maxConcurrentJobs: 1,
  maxPromptBytes: 64 * 1024,
  maxResultBytes: 1024 * 1024,
  maxEventBytes: 64 * 1024,
  maxEventsPerJob: 10_000,
  rpcTimeoutMs: 1_000,
  turnTimeoutMs: 1_000,
  retentionDays: 14
};
const runner: CodingRunner = {
  async run(input) {
    await input.onEvent({ type: "agent.message.delta", data: { delta: "ok" } });
    return { backendThreadId: "private-thread", result: "ok" };
  }
};
const database = openDatabase(":memory:");
const store = new GatewayStore(database.db, new SecretBox(config.encryptionKey));
const processor = new JobProcessor(store, runner, config.repositories, 1, config.inferenceWorkspaceRoot);
const app = await buildApp({ config, store, processor, closeDatabase: database.close });
await app.ready();

const auth = { authorization: `Bearer ${token}` };
const health = await app.inject({ method: "GET", url: "/healthz" });
if (health.statusCode !== 200) throw new Error("health check failed");
const conversation = await app.inject({
  method: "POST", url: "/v2/conversations", headers: auth, payload: { repositoryId: "gateway" }
});
if (conversation.statusCode !== 201) throw new Error("conversation creation failed");
const turn = await app.inject({
  method: "POST",
  url: `/v2/conversations/${conversation.json().id as string}/turns`,
  headers: { ...auth, "idempotency-key": "smoke-request-1" },
  payload: { prompt: "smoke" }
});
if (turn.statusCode !== 202) throw new Error("turn submission failed");

let completed = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  const job = await app.inject({ method: "GET", url: `/v2/jobs/${turn.json().jobId as string}`, headers: auth });
  if (job.json().status === "completed") {
    completed = job.json().result === "ok" && !job.body.includes("private-thread");
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
await app.close();
if (!completed) throw new Error("coding job did not complete safely");
process.stdout.write("V2 smoke check passed\n");
