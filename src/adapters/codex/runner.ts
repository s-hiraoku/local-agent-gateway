import { homedir } from "node:os";
import { GatewayError } from "../../domain/errors.js";
import { BufferedJsonRpcTransport, CodexRpcError } from "./json-rpc.js";
import type { OutputSchema } from "../../domain/structured-output.js";

export type CodingEvent = { type: "agent.message.delta"; data: { delta: string } };

export type CodingRunInput = {
  repositoryPath: string;
  backendThreadId: string | null;
  prompt: string;
  outputSchema?: OutputSchema;
  signal: AbortSignal;
  onEvent: (event: CodingEvent) => Promise<void>;
};

export type CodingRunResult = { backendThreadId: string; result: string };

export interface CodingRunner {
  run(input: CodingRunInput): Promise<CodingRunResult>;
}

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
    const transport = this.createTransport();
    try {
      await this.initialize(transport);
      const response = await transport.request<{ account?: unknown }>("account/read", { refreshToken: false });
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
    const transport = this.createTransport();
    try {
      await this.initialize(transport);

      const common = {
        cwd: input.repositoryPath,
        approvalPolicy: "never",
        sandbox: "read-only",
        ...(this.config.model ? { model: this.config.model } : {})
      };
      const thread = input.backendThreadId
        ? await transport.request<ThreadResponse>("thread/resume", { threadId: input.backendThreadId, ...common })
        : await transport.request<ThreadResponse>("thread/start", {
            ...common,
            ephemeral: false,
            developerInstructions: "Operate read-only. Never request approval, network access, or filesystem writes."
          });
      const threadId = thread.thread.id;
      const started = await transport.request<TurnResponse>("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt }],
        approvalPolicy: "never",
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {})
      });
      const turnId = started.turn.id;
      const interrupt = () => {
        void transport.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      };
      input.signal.addEventListener("abort", interrupt, { once: true });
      try {
        const result = await this.collectTurn(transport, threadId, turnId, input);
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
      transport.close();
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

  private async initialize(transport: BufferedJsonRpcTransport): Promise<void> {
    await transport.request("initialize", {
      clientInfo: { name: "local-agent-gateway", title: "Local Agent Gateway", version: "2.0.0" },
      capabilities: { experimentalApi: false }
    });
    transport.notify("initialized");
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

      if (notification.method === "item/agentMessage/delta" && typeof params.delta === "string") {
        await stream.push(params.delta);
        continue;
      }
      if (notification.method === "item/completed") {
        const item = asRecord(params.item);
        if (item.type === "agentMessage" && typeof item.text === "string") completedAgentText = item.text;
        continue;
      }
      if (notification.method !== "turn/completed") continue;

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
    .replace(/\\\\[^\s"'`)}\],;]+/g, "[local-path]")
    .replace(/[A-Za-z]:\\[^\s"'`)}\],;]*/g, "[local-path]")
    .replace(/\/[^\s"'`)}\],;]*/g, "[local-path]");
}

function appendBounded(current: string, delta: string, maxBytes: number): string {
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
