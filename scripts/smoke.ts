import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../src/config.js";
import type {
  CodexAccountClient,
  CodexAccountState,
  DeviceCodeLogin
} from "../src/codex/client.js";
import type { TaskRunner, TaskRunResult } from "../src/provider/task-runner.js";

const smokeRepo = {
  id: "local-agent-gateway",
  path: process.cwd(),
  defaultMode: "read-only",
  allowedModes: ["read-only", "workspace-write"]
};

const config: AppConfig = {
  NODE_ENV: "development",
  PORT: 8787,
  HOST: "127.0.0.1",
  DATABASE_PATH: ":memory:",
  APP_BACKEND: "codex-app-server",
  CODEX_APP_SERVER_COMMAND: "codex",
  CODEX_APP_SERVER_TURN_TIMEOUT_MS: 1_000,
  CODEXGW_ALLOWED_REPOS_JSON: JSON.stringify([smokeRepo]),
  TOKEN_PEPPER: "smoke-test-pepper",
  BOOTSTRAP_ADMIN_TOKEN: "smoke-bootstrap-token"
};

class SmokeTaskRunner implements TaskRunner {
  async runTask(): Promise<TaskRunResult> {
    return {
      provider: "codex",
      backend: "app-server",
      threadId: "thr_smoke_internal",
      summary: "smoke task completed",
      changedFiles: []
    };
  }
}

class SmokeCodexAccountClient implements CodexAccountClient {
  async getAccount(): Promise<CodexAccountState> {
    return {
      account: null,
      requiresOpenaiAuth: true
    };
  }

  async startDeviceCodeLogin(): Promise<DeviceCodeLogin> {
    return {
      type: "chatgptDeviceCode",
      loginId: "login_smoke",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "SMOKE-TEST"
    };
  }

  async cancelLogin(): Promise<void> {}

  async logout(): Promise<void> {}
}

function expectStatus(response: { statusCode: number; body: string }, expected: number, label: string): void {
  if (response.statusCode !== expected) {
    throw new Error(`${label} returned ${response.statusCode}: ${response.body}`);
  }
}

async function waitForTask(app: FastifyInstance, token: string, taskId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expectStatus(response, 200, "GET /v1/tasks/:id");
    const body = response.json<Record<string, unknown>>();
    if (body.status !== "pending") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Task did not complete during smoke check");
}

async function main(): Promise<void> {
  process.env.CODEXGW_ALLOWED_REPOS_JSON = config.CODEXGW_ALLOWED_REPOS_JSON;
  const { buildApp } = await import("../src/app.js");
  const app = buildApp({
    config,
    taskRunner: new SmokeTaskRunner(),
    codexAccountClient: new SmokeCodexAccountClient()
  });

  try {
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expectStatus(health, 200, "GET /healthz");

    const createToken = await app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: {
        authorization: `Bearer ${config.BOOTSTRAP_ADMIN_TOKEN}`,
        "content-type": "application/json"
      },
      payload: {
        name: "smoke-client",
        scopes: ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"],
        expiresInDays: 1
      }
    });
    expectStatus(createToken, 200, "POST /v1/tokens");
    const createdToken = createToken.json<{ token?: string }>();
    if (!createdToken.token) {
      throw new Error("POST /v1/tokens did not return a bootstrap token");
    }

    const repos = await app.inject({
      method: "GET",
      url: "/v1/repos",
      headers: { authorization: `Bearer ${createdToken.token}` }
    });
    expectStatus(repos, 200, "GET /v1/repos");
    if (!repos.body.includes("local-agent-gateway")) {
      throw new Error("GET /v1/repos did not include the smoke repo");
    }

    const createTask = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: {
        authorization: `Bearer ${createdToken.token}`,
        "content-type": "application/json"
      },
      payload: {
        repo: "local-agent-gateway",
        prompt: "Smoke check the Gateway task API",
        mode: "read-only"
      }
    });
    expectStatus(createTask, 202, "POST /v1/tasks");
    const pendingTask = createTask.json<{ taskId?: string; threadId?: string }>();
    if (!pendingTask.taskId) {
      throw new Error("POST /v1/tasks did not return a Gateway taskId");
    }
    if (pendingTask.threadId) {
      throw new Error("POST /v1/tasks exposed an internal threadId");
    }

    const completedTask = await waitForTask(app, createdToken.token, pendingTask.taskId);
    if (completedTask.status !== "completed") {
      throw new Error(`Task finished with unexpected status: ${String(completedTask.status)}`);
    }
    if ("threadId" in completedTask) {
      throw new Error("GET /v1/tasks/:id exposed an internal threadId");
    }

    console.log("Smoke check passed: health, token bootstrap, repo listing, task create, and task polling.");
  } finally {
    await app.close();
  }
}

await main();
