import { homedir } from "node:os";
import { GatewayError } from "../../domain/errors.js";
import { BufferedJsonRpcTransport, CodexRpcError } from "./json-rpc.js";

export type CodingEvent = { type: "agent.message.delta"; data: { delta: string } };

export type CodingRunInput = {
  repositoryPath: string;
  backendThreadId: string | null;
  prompt: string;
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
  constructor(private readonly config: CodexRunnerConfig) {}

  async run(input: CodingRunInput): Promise<CodingRunResult> {
    const transport = new BufferedJsonRpcTransport({
      command: this.config.command,
      args: ["app-server"],
      env: buildCodexEnvironment(process.env, this.config.codexHome),
      requestTimeoutMs: this.config.rpcTimeoutMs
    });
    try {
      await transport.request("initialize", {
        clientInfo: { name: "local-agent-gateway", title: "Local Agent Gateway", version: "2.0.0" },
        capabilities: { experimentalApi: false }
      });
      transport.notify("initialized");

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
        approvalPolicy: "never"
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
      throw mapCodexError(error);
    } finally {
      transport.close();
    }
  }

  private async collectTurn(
    transport: BufferedJsonRpcTransport,
    threadId: string,
    turnId: string,
    input: CodingRunInput
  ): Promise<string> {
    let streamed = "";
    while (true) {
      const notification = await transport.nextNotification(this.config.turnTimeoutMs, input.signal);
      const params = asRecord(notification.params);
      if (typeof params.threadId === "string" && params.threadId !== threadId) continue;
      if (typeof params.turnId === "string" && params.turnId !== turnId) continue;

      if (notification.method === "item/agentMessage/delta" && typeof params.delta === "string") {
        const delta = sanitizeOutput(params.delta, input.repositoryPath);
        streamed = appendBounded(streamed, delta, this.config.maxResultBytes);
        await input.onEvent({ type: "agent.message.delta", data: { delta } });
        continue;
      }
      if (notification.method !== "turn/completed") continue;

      const turn = asRecord(params.turn);
      const status = turn.status;
      if (status === "interrupted") throw input.signal.reason ?? new Error("Aborted");
      if (status !== "completed") {
        const turnError = asRecord(turn.error);
        throw new GatewayError(
          mapCodexInfo(turnError.codexErrorInfo),
          "Codex could not complete the coding turn",
          codexStatus(mapCodexInfo(turnError.codexErrorInfo)),
          true
        );
      }
      const completedText = finalAgentMessage(turn.items, input.repositoryPath);
      return completedText || streamed;
    }
  }
}

function finalAgentMessage(items: unknown, repositoryPath: string): string {
  if (!Array.isArray(items)) return "";
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = asRecord(items[index]);
    if (item.type === "agentMessage" && typeof item.text === "string") {
      return sanitizeOutput(item.text, repositoryPath);
    }
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function sanitizeOutput(value: string, repositoryPath: string): string {
  return value
    .replaceAll(repositoryPath, "[repository]")
    .replaceAll(homedir(), "[home]")
    .replace(/\/(?:Users|home|tmp|private|Volumes)\/[^\s"'`)}\]]+/g, "[local-path]")
    .replace(/[A-Za-z]:\\(?:[^\s"'`)}\]]+\\)*[^\s"'`)}\]]+/g, "[local-path]");
}

function appendBounded(current: string, delta: string, maxBytes: number): string {
  const combined = current + delta;
  if (Buffer.byteLength(combined) <= maxBytes) return combined;
  return Buffer.from(combined).subarray(0, maxBytes).toString("utf8");
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

function mapCodexInfo(value: unknown): "CODEX_UNAUTHORIZED" | "CODEX_RATE_LIMITED" | "CODEX_OVERLOADED" | "CODEX_EXECUTION_FAILED" {
  if (value === "unauthorized") return "CODEX_UNAUTHORIZED";
  if (value === "usageLimitExceeded" || value === "sessionBudgetExceeded") return "CODEX_RATE_LIMITED";
  if (value === "serverOverloaded") return "CODEX_OVERLOADED";
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
