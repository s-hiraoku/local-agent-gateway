import { relative, resolve, sep } from "node:path";
import type { AppConfig } from "../config.js";
import type { NewTaskEvent } from "../tasks/task-events.js";
import type { TaskMode } from "../policy/modes.js";
import type { TaskRunner, TaskRunResult } from "../provider/task-runner.js";
import { ApiError } from "../utils/errors.js";
import { sanitizePublicText } from "../utils/sanitize.js";
import { StdioJsonRpcTransport, type JsonRpcNotification, type JsonRpcTransport } from "./json-rpc.js";

export type CodexAccountState = {
  account: null | {
    type: string;
    email?: string;
    planType?: string | null;
  };
  requiresOpenaiAuth: boolean;
};

export type DeviceCodeLogin = {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

export interface CodexAccountClient {
  getAccount(refreshToken?: boolean): Promise<CodexAccountState>;
  startDeviceCodeLogin(): Promise<DeviceCodeLogin>;
  cancelLogin(loginId: string): Promise<void>;
  logout(): Promise<void>;
}

type ThreadStartResult = {
  thread?: {
    id?: string;
  };
};

type TurnStartResult = {
  turn?: {
    id?: string;
  };
};

type TurnCompletedParams = {
  turn?: {
    id?: string;
    status?: string;
    error?: {
      message?: string;
    } | null;
  };
};

type ItemCompletedParams = {
  item?: {
    type?: string;
    text?: string;
    phase?: string;
    changes?: Array<{ path?: string }>;
    status?: string;
  };
};

type CodexAppServerOptions = {
  transport?: JsonRpcTransport;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  turnTimeoutMs?: number;
};

export class CodexAppServerClient implements TaskRunner, CodexAccountClient {
  private transport: JsonRpcTransport | null = null;
  private readonly configuredTransport: JsonRpcTransport | undefined;
  private readonly command: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly turnTimeoutMs: number;
  private initializePromise: Promise<void> | null = null;

  constructor(config: AppConfig, options: CodexAppServerOptions = {}) {
    this.configuredTransport = options.transport;
    this.command = options.command ?? config.CODEX_APP_SERVER_COMMAND;
    this.args = options.args ?? ["app-server"];
    this.env = {
      ...process.env,
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      ...options.env
    };
    this.turnTimeoutMs = options.turnTimeoutMs ?? config.CODEX_APP_SERVER_TURN_TIMEOUT_MS;
  }

  async getAccount(refreshToken = false): Promise<CodexAccountState> {
    await this.ensureInitialized();
    const result = await this.safeRequest<unknown>(this.getTransport(), "account/read", { refreshToken });
    return parseAccountState(result);
  }

  async startDeviceCodeLogin(): Promise<DeviceCodeLogin> {
    await this.ensureInitialized();
    const result = await this.safeRequest<unknown>(this.getTransport(), "account/login/start", {
      type: "chatgptDeviceCode"
    });
    return parseDeviceCodeLogin(result);
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.ensureInitialized();
    await this.safeRequest(this.getTransport(), "account/login/cancel", { loginId });
  }

  async logout(): Promise<void> {
    await this.ensureInitialized();
    await this.safeRequest(this.getTransport(), "account/logout");
  }

  async runTask(params: {
    prompt: string;
    cwd: string;
    threadId?: string;
    mode: TaskMode;
    onEvent?: (event: NewTaskEvent) => void | Promise<void>;
  }): Promise<TaskRunResult> {
    const transport = this.configuredTransport ?? this.createTransport();
    try {
      if (this.configuredTransport) {
        await this.ensureInitialized();
      } else {
        await this.initializeTransport(transport);
      }
      return await this.runTaskWithTransport(transport, params);
    } finally {
      if (!this.configuredTransport) {
        transport.close();
      }
    }
  }

  close(): void {
    this.transport?.close();
    this.transport = null;
    this.initializePromise = null;
  }

  private async runTaskWithTransport(
    transport: JsonRpcTransport,
    params: {
      prompt: string;
      cwd: string;
      threadId?: string;
      mode: TaskMode;
      onEvent?: (event: NewTaskEvent) => void | Promise<void>;
    }
  ): Promise<TaskRunResult> {
    const threadResult = params.threadId
      ? await this.safeRequest<ThreadStartResult>(transport, "thread/resume", {
          threadId: params.threadId,
          cwd: params.cwd,
          approvalPolicy: "never",
          sandbox: toAppServerSandbox(params.mode),
          serviceName: "codex_app_server_gateway"
        })
      : await this.safeRequest<ThreadStartResult>(transport, "thread/start", {
          cwd: params.cwd,
          approvalPolicy: "never",
          sandbox: toAppServerSandbox(params.mode),
          serviceName: "codex_app_server_gateway"
        });
    const threadId = threadResult.thread?.id;
    if (!threadId) {
      throw new ApiError("CODEX_EXECUTION_FAILED", "Codex app-server did not return a thread id");
    }

    const turnResult = await this.safeRequest<TurnStartResult>(transport, "turn/start", {
      threadId,
      input: [{ type: "text", text: params.prompt }],
      cwd: params.cwd,
      approvalPolicy: "never",
      sandboxPolicy: toAppServerSandboxPolicy(params.mode, params.cwd)
    });
    const turnId = turnResult.turn?.id;
    if (!turnId) {
      throw new ApiError("CODEX_EXECUTION_FAILED", "Codex app-server did not return a turn id");
    }

    const collected = await this.collectTurn(transport, params.cwd, turnId, params.onEvent);
    return {
      provider: "codex",
      backend: "app-server",
      threadId,
      summary: sanitizePublicText(collected.summary || "Task completed"),
      changedFiles: collected.changedFiles
    };
  }

  private ensureInitialized(): Promise<void> {
    this.initializePromise ??= this.initialize();
    return this.initializePromise;
  }

  private async initialize(): Promise<void> {
    return this.initializeTransport(this.getTransport());
  }

  private async initializeTransport(transport: JsonRpcTransport): Promise<void> {
    await this.safeRequest(transport, "initialize", {
      clientInfo: {
        name: "codex_app_server_gateway",
        title: "Local Agent Gateway",
        version: "0.1.0"
      },
      capabilities: {
        optOutNotificationMethods: ["item/agentMessage/delta", "item/reasoning/textDelta"]
      }
    });
    transport.notify("initialized", {});
  }

  private async collectTurn(
    transport: JsonRpcTransport,
    repoRoot: string,
    turnId: string,
    onEvent?: (event: NewTaskEvent) => void | Promise<void>
  ): Promise<{ summary: string; changedFiles: string[] }> {
    const changedFiles = new Set<string>();
    let finalSummary = "";
    let latestSummary = "";

    while (true) {
      const notification = await transport.waitForNotification(
        (candidate) => isTurnNotification(candidate, turnId),
        this.turnTimeoutMs
      );

      if (notification.method === "item/completed") {
        const item = (notification.params as ItemCompletedParams | undefined)?.item;
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          latestSummary = item.text;
          await onEvent?.({
            type: "agent.message.completed",
            payload: { text: item.text, phase: item.phase ?? null }
          });
          if (item.phase === "final_answer") {
            finalSummary = item.text;
          }
        }
        if (item?.type === "fileChange" && item.status === "completed" && Array.isArray(item.changes)) {
          for (const change of item.changes) {
            if (typeof change.path !== "string") {
              continue;
            }
            const safePath = assertInsideRepo(change.path, repoRoot);
            if (safePath) {
              changedFiles.add(safePath);
              await onEvent?.({ type: "file.changed", payload: { path: safePath } });
            }
          }
          await onEvent?.({ type: "diff.available", payload: { changedFiles: [...changedFiles].sort() } });
        }
      }

      if (notification.method === "turn/completed") {
        const turn = (notification.params as TurnCompletedParams | undefined)?.turn;
        if (turn?.status === "failed") {
          throw new ApiError("CODEX_EXECUTION_FAILED", sanitizePublicText(turn.error?.message ?? "Codex turn failed"));
        }
        return {
          summary: finalSummary || latestSummary,
          changedFiles: [...changedFiles].sort()
        };
      }
    }
  }

  private async safeRequest<T>(transport: JsonRpcTransport, method: string, params?: unknown): Promise<T> {
    try {
      return await transport.request<T>(method, params);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw classifyCodexError(error);
    }
  }

  private getTransport(): JsonRpcTransport {
    this.transport ??= this.configuredTransport ?? this.createTransport();
    return this.transport;
  }

  private createTransport(): JsonRpcTransport {
    return new StdioJsonRpcTransport(this.command, this.args, this.env);
  }
}

export class CodexClient extends CodexAppServerClient {}

function toAppServerSandbox(mode: TaskMode): "read-only" | "workspace-write" {
  return mode === "workspace-write" ? "workspace-write" : "read-only";
}

function toAppServerSandboxPolicy(mode: TaskMode, cwd: string) {
  if (mode === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true
    };
  }
  return {
    type: "readOnly",
    networkAccess: false
  };
}

function assertInsideRepo(path: string, repoRoot: string): string | null {
  const resolvedRoot = resolve(repoRoot);
  const resolvedPath = resolve(repoRoot, path);
  const relativePath = relative(resolvedRoot, resolvedPath);

  if (relativePath === "" || relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) {
    return null;
  }

  return relativePath;
}

function isTurnNotification(notification: JsonRpcNotification, turnId: string): boolean {
  if (notification.method !== "turn/completed" && notification.method !== "item/completed") {
    return false;
  }
  const params = notification.params as { turn?: { id?: string }; item?: { id?: string } } | undefined;
  return params?.turn?.id === turnId || params?.item?.id === turnId || notification.method === "item/completed";
}

function parseAccountState(result: unknown): CodexAccountState {
  if (!result || typeof result !== "object") {
    throw new ApiError("CODEX_EXECUTION_FAILED", "Invalid account state from Codex app-server");
  }
  const candidate = result as {
    account?: null | { type?: unknown; email?: unknown; planType?: unknown };
    requiresOpenaiAuth?: unknown;
  };
  const account =
    candidate.account && typeof candidate.account.type === "string"
      ? {
          type: candidate.account.type,
          ...(typeof candidate.account.email === "string" ? { email: candidate.account.email } : {}),
          ...(typeof candidate.account.planType === "string" || candidate.account.planType === null
            ? { planType: candidate.account.planType }
            : {})
        }
      : null;
  return {
    account,
    requiresOpenaiAuth: candidate.requiresOpenaiAuth === true
  };
}

function parseDeviceCodeLogin(result: unknown): DeviceCodeLogin {
  if (!result || typeof result !== "object") {
    throw new ApiError("CODEX_EXECUTION_FAILED", "Invalid device-code login response from Codex app-server");
  }
  const candidate = result as Record<string, unknown>;
  if (
    candidate.type !== "chatgptDeviceCode" ||
    typeof candidate.loginId !== "string" ||
    typeof candidate.verificationUrl !== "string" ||
    typeof candidate.userCode !== "string"
  ) {
    throw new ApiError("CODEX_EXECUTION_FAILED", "Invalid device-code login response from Codex app-server");
  }
  return {
    type: "chatgptDeviceCode",
    loginId: candidate.loginId,
    verificationUrl: candidate.verificationUrl,
    userCode: candidate.userCode
  };
}

function classifyCodexError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : "Codex app-server request failed";
  if (/\b(auth|authenticate|authentication|credential|login|api key|not configured|unauthorized)\b/i.test(message)) {
    return new ApiError("CODEX_NOT_CONFIGURED", "Codex task execution is not available");
  }
  return new ApiError("CODEX_EXECUTION_FAILED", "Codex task execution failed");
}
