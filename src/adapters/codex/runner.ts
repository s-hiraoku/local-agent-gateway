import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { GatewayError } from "../../domain/errors.js";
import {
  assertSupportedCodexVersion,
  CODEX_APP_SERVER_METHODS,
  CODEX_APP_SERVER_NOTIFICATIONS,
  CODEX_INITIALIZE_PARAMS,
  parseCodexVersion,
  unsupportedCodexVersionError
} from "./compatibility.js";
import { BufferedJsonRpcTransport, CodexRpcError } from "./json-rpc.js";
import type { CodingRunInput, CodingRunResult, CodingRunner } from "../runner.js";

export type { CodingEvent, CodingRunInput, CodingRunResult, CodingRunner } from "../runner.js";

type CodexRunnerConfig = {
  command: string;
  codexHome: string;
  model?: string;
  rpcTimeoutMs: number;
  turnTimeoutMs: number;
  maxResultBytes: number;
};

type ThreadResponse = { thread: { id: string } };
type TurnResponse = { turn: { id: string } };

export function buildCodexEnvironment(source: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    CODEX_HOME: codexHome,
    NO_COLOR: "1",
    TERM: "dumb"
  };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL"] as const) {
    const value = source[key];
    if (value) result[key] = value;
  }
  return result;
}

export class CodexAppServerRunner implements CodingRunner {
  private readiness: { checkedAt: number; error?: GatewayError } | undefined;

  constructor(private readonly config: CodexRunnerConfig) {}

  async checkReady(): Promise<void> {
    if (this.readiness && Date.now() - this.readiness.checkedAt < 10_000) {
      if (this.readiness.error) throw this.readiness.error;
      return;
    }
    try {
      await this.assertCliVersion();
    } catch (error) {
      const normalized = mapCodexError(error);
      this.readiness = { checkedAt: Date.now(), error: normalized };
      throw normalized;
    }
    const transport = this.createTransport();
    try {
      await this.initialize(transport);
      const response = await transport.request<{ account?: unknown }>(
        CODEX_APP_SERVER_METHODS.accountRead,
        { refreshToken: false }
      );
      const account = asRecord(response.account);
      if (account.type !== "chatgpt") {
        throw new GatewayError(
          "CODEX_UNAUTHORIZED",
          "The dedicated Codex home is not signed in with a ChatGPT account",
          503,
          false
        );
      }
      this.readiness = { checkedAt: Date.now() };
    } catch (error) {
      const normalized = mapCodexError(error);
      this.readiness = { checkedAt: Date.now(), error: normalized };
      throw normalized;
    } finally {
      transport.close();
    }
  }

  async run(input: CodingRunInput): Promise<CodingRunResult> {
    let transport: BufferedJsonRpcTransport | undefined;
    try {
      await this.assertCliVersion(input.signal);
      if (input.signal.aborted) {
        throw input.signal.reason ?? new Error("Aborted");
      }
      const active = this.createTransport();
      transport = active;
      await this.initialize(active);

      const common = {
        cwd: input.repositoryPath,
        approvalPolicy: "never",
        sandbox: "read-only",
        ...(this.config.model ? { model: this.config.model } : {})
      };
      const thread = input.backendThreadId
        ? await active.request<ThreadResponse>(CODEX_APP_SERVER_METHODS.threadResume, {
            threadId: input.backendThreadId,
            ...common
          })
        : await active.request<ThreadResponse>(CODEX_APP_SERVER_METHODS.threadStart, {
            ...common,
            ephemeral: false,
            developerInstructions: "Operate read-only. Never request approval, network access, or filesystem writes."
          });
      const threadId = thread.thread.id;
      const started = await active.request<TurnResponse>(CODEX_APP_SERVER_METHODS.turnStart, {
        threadId,
        input: [{ type: "text", text: input.prompt }],
        approvalPolicy: "never",
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {})
      });
      const turnId = started.turn.id;
      const interrupt = () => {
        void active.request(CODEX_APP_SERVER_METHODS.turnInterrupt, { threadId, turnId }).catch(() => undefined);
      };
      input.signal.addEventListener("abort", interrupt, { once: true });
      try {
        const result = await this.collectTurn(active, threadId, turnId, input);
        return { backendThreadId: threadId, result };
      } finally {
        input.signal.removeEventListener("abort", interrupt);
      }
    } catch (error) {
      const normalized = mapCodexError(error);
      this.readiness = normalized.code === "CODEX_UNAUTHORIZED"
        ? { checkedAt: Date.now(), error: normalized }
        : undefined;
      throw normalized;
    } finally {
      transport?.close();
    }
  }

  private createTransport(): BufferedJsonRpcTransport {
    return new BufferedJsonRpcTransport({
      command: this.config.command,
      args: ["app-server"],
      env: buildCodexEnvironment(process.env, this.config.codexHome),
      requestTimeoutMs: this.config.rpcTimeoutMs
    });
  }

  private async assertCliVersion(signal?: AbortSignal): Promise<void> {
    const output = await this.readCliVersion(signal);
    const version = parseCodexVersion(output);
    if (!version) throw unsupportedCodexVersionError();
    assertSupportedCodexVersion(version);
  }

  private readCliVersion(signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted"));
        return;
      }
      const child = spawn(this.config.command, ["--version"], {
        env: buildCodexEnvironment(process.env, this.config.codexHome),
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stdoutBytes = 0;
      let settled = false;
      const onAbort = () => finish(() => {
        child.kill("SIGKILL");
        reject(signal?.reason ?? new Error("Aborted"));
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => finish(() => {
        child.kill("SIGKILL");
        reject(new GatewayError("CODEX_NOT_CONFIGURED", "Codex version probe timed out", 503, false));
      }), 10_000);
      timer.unref();
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        action();
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > 4096) {
          finish(() => {
            child.kill("SIGKILL");
            reject(unsupportedCodexVersionError());
          });
          return;
        }
        stdout += chunk.toString();
      });
      child.on("error", (error) => finish(() => {
        const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "CODEX_NOT_CONFIGURED" : "CODEX_EXECUTION_FAILED";
        reject(new GatewayError(code, "Codex executable could not be started", 503, false));
      }));
      child.on("close", (exitCode) => finish(() => {
        if (exitCode === 0) resolve(stdout);
        else reject(new GatewayError("CODEX_NOT_CONFIGURED", "Codex version probe failed", 503, false));
      }));
    });
  }

  private async initialize(transport: BufferedJsonRpcTransport): Promise<void> {
    const result = await transport.request<Record<string, unknown>>(
      CODEX_APP_SERVER_METHODS.initialize,
      CODEX_INITIALIZE_PARAMS
    );
    if (typeof result.userAgent !== "string" || result.userAgent.length === 0) {
      throw unsupportedCodexVersionError();
    }
    transport.notify(CODEX_APP_SERVER_METHODS.initialized);
  }

  private async collectTurn(
    transport: BufferedJsonRpcTransport,
    threadId: string,
    turnId: string,
    input: CodingRunInput
  ): Promise<string> {
    const stream = new PathRedactingStream(input.repositoryPath, this.config.maxResultBytes, input.onEvent);
    let completedAgentText = "";
    while (true) {
      const notification = await transport.nextNotification(this.config.turnTimeoutMs, input.signal);
      const params = asRecord(notification.params);
      if (typeof params.threadId === "string" && params.threadId !== threadId) continue;
      if (typeof params.turnId === "string" && params.turnId !== turnId) continue;

      if (notification.method === CODEX_APP_SERVER_NOTIFICATIONS.agentMessageDelta && typeof params.delta === "string") {
        await stream.push(params.delta);
        continue;
      }
      if (notification.method === CODEX_APP_SERVER_NOTIFICATIONS.itemCompleted) {
        const item = asRecord(params.item);
        if (item.type === "agentMessage" && typeof item.text === "string") completedAgentText = item.text;
        continue;
      }
      if (notification.method !== CODEX_APP_SERVER_NOTIFICATIONS.turnCompleted) continue;

      const turn = asRecord(params.turn);
      const status = turn.status;
      if (status === "interrupted") throw input.signal.reason ?? new Error("Aborted");
      if (status !== "completed") {
        const turnError = asRecord(turn.error);
        const code = mapCodexInfo(turnError.codexErrorInfo);
        throw new GatewayError(
          code,
          "Codex could not complete the coding turn",
          codexStatus(code),
          code !== "CODEX_UNAUTHORIZED"
        );
      }
      await stream.finish();
      const finalText = completedAgentText || finalAgentMessage(turn.items);
      if (!finalText) return stream.result;
      const bounded = appendBounded("", sanitizeOutput(finalText, input.repositoryPath), this.config.maxResultBytes);
      await stream.reconcile(bounded);
      return bounded;
    }
  }
}

function finalAgentMessage(items: unknown): string {
  if (!Array.isArray(items)) return "";
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = asRecord(items[index]);
    if (item.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function sanitizeOutput(value: string, repositoryPath: string): string {
  return value
    .replaceAll(repositoryPath, "[repository]")
    .replaceAll(homedir(), "[home]")
    .replace(/file:\/\/\/[^\s"'`)}\],;]*/gi, "[local-path]")
    .replace(/\\\\[^\s"'`)}\],;]+/g, "[local-path]")
    .replace(/[A-Za-z]:\\[^\s"'`)}\],;]*/g, "[local-path]")
    .replace(/(?<![:/])\/[^\s"'`)}\],;]*/g, (candidate) =>
      isLikelyLocalPosixPath(candidate) ? "[local-path]" : candidate
    );
}

const LOCAL_POSIX_ROOTS = new Set([
  "Applications", "Library", "System", "Users", "Volumes", "app", "bin", "data", "dev", "etc",
  "home", "mnt", "nix", "opt", "private", "proc", "root", "run", "sbin", "srv", "sys", "tmp",
  "usr", "var", "workspace", "workspaces"
]);

function isLikelyLocalPosixPath(candidate: string): boolean {
  const root = candidate.slice(1).split("/", 1)[0];
  return root !== undefined && LOCAL_POSIX_ROOTS.has(root);
}

export function appendBounded(current: string, delta: string, maxBytes: number): string {
  const combined = current + delta;
  if (Buffer.byteLength(combined) <= maxBytes) return combined;
  return Buffer.from(combined).subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

export class PathRedactingStream {
  private carry = "";
  private emitted = "";

  constructor(
    private readonly repositoryPath: string,
    private readonly maxBytes: number,
    private readonly onEvent: CodingRunInput["onEvent"]
  ) {}

  get result(): string {
    return this.emitted;
  }

  async push(delta: string): Promise<void> {
    const remaining = Math.max(0, this.maxBytes - Buffer.byteLength(this.emitted));
    this.carry = appendBounded(this.carry, delta, remaining);
    let boundary = -1;
    for (let index = this.carry.length - 1; index >= 0; index -= 1) {
      if (/\s/u.test(this.carry[index] ?? "")) {
        boundary = index;
        break;
      }
    }
    if (boundary < 0) return;
    const complete = this.carry.slice(0, boundary + 1);
    this.carry = this.carry.slice(boundary + 1);
    await this.emitSanitized(complete);
  }

  async finish(): Promise<void> {
    const remaining = this.carry;
    this.carry = "";
    await this.emitSanitized(remaining);
  }

  async reconcile(finalResult: string): Promise<void> {
    if (!finalResult.startsWith(this.emitted)) return;
    await this.emit(finalResult.slice(this.emitted.length));
  }

  private async emitSanitized(value: string): Promise<void> {
    await this.emit(sanitizeOutput(value, this.repositoryPath));
  }

  private async emit(value: string): Promise<void> {
    const bounded = appendBounded(this.emitted, value, this.maxBytes);
    const delta = bounded.slice(this.emitted.length);
    this.emitted = bounded;
    if (delta) await this.onEvent({ type: "agent.message.delta", data: { delta } });
  }
}

function mapCodexError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof CodexRpcError) {
    const data = asRecord(error.data);
    const code = mapCodexInfo(data.codexErrorInfo);
    return new GatewayError(code, publicCodexMessage(code), codexStatus(code), code !== "CODEX_UNAUTHORIZED");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new GatewayError("CODEX_EXECUTION_FAILED", "The coding turn was cancelled", 409);
  }
  return new GatewayError("CODEX_EXECUTION_FAILED", "Codex could not complete the coding turn", 502, true);
}

export function mapCodexInfo(value: unknown): "CODEX_UNAUTHORIZED" | "CODEX_RATE_LIMITED" | "CODEX_OVERLOADED" | "CODEX_EXECUTION_FAILED" {
  const normalized = (typeof value === "string" ? value : Object.keys(asRecord(value))[0] ?? "").toLowerCase();
  if (normalized === "unauthorized") return "CODEX_UNAUTHORIZED";
  if (normalized === "usagelimitexceeded" || normalized === "sessionbudgetexceeded") return "CODEX_RATE_LIMITED";
  if (normalized === "serveroverloaded") return "CODEX_OVERLOADED";
  return "CODEX_EXECUTION_FAILED";
}

function codexStatus(code: string): number {
  if (code === "CODEX_UNAUTHORIZED") return 401;
  if (code === "CODEX_RATE_LIMITED") return 429;
  if (code === "CODEX_OVERLOADED") return 503;
  return 502;
}

function publicCodexMessage(code: string): string {
  if (code === "CODEX_UNAUTHORIZED") return "Codex authentication is required";
  if (code === "CODEX_RATE_LIMITED") return "Codex plan usage limit was reached";
  if (code === "CODEX_OVERLOADED") return "Codex is temporarily overloaded";
  return "Codex could not complete the coding turn";
}
