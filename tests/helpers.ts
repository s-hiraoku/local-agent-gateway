import { buildApp } from "../src/app.js";
import { openDatabase, type Db } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { createApiToken } from "../src/auth/token.js";
import type { AppConfig } from "../src/config.js";
import type { CodexAccountClient, CodexAccountState, DeviceCodeLogin } from "../src/codex/client.js";
import type { NewTaskEvent } from "../src/tasks/task-events.js";
import type { TaskRunner, TaskRunResult } from "../src/provider/task-runner.js";

export const TEST_CONFIG: AppConfig = {
  NODE_ENV: "test",
  PORT: 8787,
  HOST: "127.0.0.1",
  DATABASE_PATH: ":memory:",
  APP_BACKEND: "codex-app-server",
  CODEX_APP_SERVER_COMMAND: "codex",
  CODEX_APP_SERVER_TURN_TIMEOUT_MS: 1_000,
  CODEXGW_ALLOWED_REPOS_JSON: undefined,
  TOKEN_PEPPER: "test-pepper",
  BOOTSTRAP_ADMIN_TOKEN: "bootstrap-secret"
};

export class FakeTaskRunner implements TaskRunner {
  calls: Array<{ prompt: string; cwd: string; mode: string }> = [];
  summary = "task completed";
  changedFiles: string[] = [];
  error: Error | null = null;

  async runTask(params: {
    prompt: string;
    cwd: string;
    threadId?: string;
    mode: "read-only" | "workspace-write";
    onEvent?: (event: NewTaskEvent) => void | Promise<void>;
  }): Promise<TaskRunResult> {
    this.calls.push(params);
    if (this.error) {
      throw this.error;
    }
    return {
      provider: "codex",
      backend: "app-server",
      threadId: "thr_test",
      summary: this.summary,
      changedFiles: this.changedFiles
    };
  }
}

export const FakeCodexRunner = FakeTaskRunner;

export class FakeCodexAccountClient implements CodexAccountClient {
  account: CodexAccountState = {
    account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
    requiresOpenaiAuth: false
  };
  deviceCodeLogin: DeviceCodeLogin = {
    type: "chatgptDeviceCode",
    loginId: "login_test",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234"
  };
  cancelledLoginId: string | null = null;
  loggedOut = false;

  async getAccount(): Promise<CodexAccountState> {
    return this.account;
  }

  async startDeviceCodeLogin(): Promise<DeviceCodeLogin> {
    return this.deviceCodeLogin;
  }

  async cancelLogin(loginId: string): Promise<void> {
    this.cancelledLoginId = loginId;
  }

  async logout(): Promise<void> {
    this.loggedOut = true;
  }
}

export function makeTestDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

export function makeTestApp(
  options: { db?: Db; taskRunner?: TaskRunner; codexRunner?: TaskRunner; codexAccountClient?: CodexAccountClient } = {}
) {
  const db = options.db ?? makeTestDb();
  const taskRunner = options.taskRunner ?? options.codexRunner ?? new FakeTaskRunner();
  const codexAccountClient = options.codexAccountClient ?? new FakeCodexAccountClient();
  const app = buildApp({
    config: TEST_CONFIG,
    db,
    taskRunner,
    codexAccountClient
  });

  return { app, db, taskRunner, codexRunner: taskRunner, codexAccountClient };
}

export function issueToken(
  db: Db,
  scopes: string[],
  options: { name?: string; expiresInDays?: number | null } = {}
) {
  return createApiToken(db, {
    name: options.name ?? "test-token",
    scopes,
    expiresInDays: options.expiresInDays ?? 30,
    pepper: TEST_CONFIG.TOKEN_PEPPER
  });
}

export function authHeader(token: string) {
  return {
    authorization: `Bearer ${token}`
  };
}
