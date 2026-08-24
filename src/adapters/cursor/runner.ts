import { GatewayError } from "../../domain/errors.js";
import type { OutputSchema } from "../../domain/structured-output.js";
import { appendBounded, sanitizeOutput } from "../codex/runner.js";
import type { CodingRunInput, CodingRunResult, CodingRunner } from "../runner.js";

// Cursor provider for inference turns: runs `@cursor/sdk` in-process against
// the owner's Cursor user/service-account API key. That key bills the same
// request pools as the IDE. Tools are disabled so the turn stays text-in /
// JSON-out. The public API never accepts or returns this key.

export const DEFAULT_CURSOR_MODEL = "composer-2.5";
export const MIN_CURSOR_API_KEY_LENGTH = 20;

export type CursorPromptResult = {
  id?: string;
  status?: string;
  result?: unknown;
  error?: { message?: string; code?: string };
};

export type CursorPromptOptions = {
  apiKey: string;
  model: string;
  cwd: string;
  signal?: AbortSignal;
};

export type CursorPromptClient = (
  prompt: string,
  options: CursorPromptOptions
) => Promise<CursorPromptResult>;

type CursorRunnerConfig = {
  apiKey: string;
  model?: string;
  turnTimeoutMs: number;
  maxResultBytes: number;
};

export class CursorSdkRunner implements CodingRunner {
  constructor(
    private readonly config: CursorRunnerConfig,
    private readonly promptClient: CursorPromptClient = defaultCursorPrompt
  ) {}

  async checkReady(): Promise<void> {
    // Confirm the key and SDK package only. A live models.list() call would
    // consume subscription usage on every readiness poll.
    if (!this.config.apiKey || this.config.apiKey.length < MIN_CURSOR_API_KEY_LENGTH) {
      throw new GatewayError("CURSOR_NOT_CONFIGURED", "Cursor API key is not configured", 503, false);
    }
    if (this.promptClient !== defaultCursorPrompt) return;
    try {
      await import("@cursor/sdk");
    } catch {
      throw new GatewayError("CURSOR_NOT_CONFIGURED", "Cursor SDK is not available", 503, false);
    }
  }

  async run(input: CodingRunInput): Promise<CodingRunResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), this.config.turnTimeoutMs);
    timer.unref();
    const onInputAbort = () => controller.abort("cancel");
    if (input.signal.aborted) controller.abort("cancel");
    else input.signal.addEventListener("abort", onInputAbort, { once: true });

    try {
      const result = await Promise.race([
        this.promptClient(withOutputSchema(input.prompt, input.outputSchema), {
          apiKey: this.config.apiKey,
          model: this.config.model ?? DEFAULT_CURSOR_MODEL,
          cwd: input.repositoryPath,
          signal: controller.signal
        }),
        whenAborted(controller.signal)
      ]);
      if (result.status === "error") {
        throw mapCursorFailure(result.error?.message ?? "Cursor reported an error");
      }
      const text = cursorResultText(result);
      if (!text) {
        throw new GatewayError("CURSOR_EXECUTION_FAILED", "Cursor returned an empty result", 502, true);
      }
      const bounded = appendBounded("", text, this.config.maxResultBytes);
      const sanitized = redactSecret(
        sanitizeOutput(bounded, input.repositoryPath),
        this.config.apiKey
      );
      return {
        backendThreadId: typeof result.id === "string" && result.id ? result.id : "cursor-inference",
        result: sanitized
      };
    } catch (error) {
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      throw mapCursorError(error, this.config.apiKey);
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onInputAbort);
    }
  }
}

export async function defaultCursorPrompt(
  prompt: string,
  options: CursorPromptOptions
): Promise<CursorPromptResult> {
  const { Agent } = await import("@cursor/sdk");
  const agent = await Agent.create({
    apiKey: options.apiKey,
    model: { id: options.model },
    local: { cwd: options.cwd, settingSources: [] },
    tools: []
  });
  try {
    const run = await agent.send(prompt);
    const onAbort = () => {
      if (run.supports("cancel")) void run.cancel();
    };
    if (options.signal?.aborted) {
      onAbort();
      throw abortError(options.signal.reason);
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await run.wait();
      return {
        id: result.id,
        status: result.status,
        result: result.result,
        ...(result.error ? { error: result.error } : {})
      };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

export function withOutputSchema(prompt: string, schema?: OutputSchema): string {
  if (!schema) return prompt;
  return [
    prompt,
    "",
    "Return only JSON that validates against this JSON Schema. Do not wrap it in Markdown.",
    JSON.stringify(schema)
  ].join("\n");
}

export function cursorResultText(result: CursorPromptResult): string {
  const value = result.result;
  if (typeof value === "string" && value) return value;
  if (value !== undefined && value !== null) return JSON.stringify(value);
  return "";
}

export function mapCursorInfo(message: string): "CURSOR_UNAUTHORIZED" | "CURSOR_RATE_LIMITED" | "CURSOR_EXECUTION_FAILED" {
  if (/unauthor|invalid api key|api key|not logged in|authenticate/i.test(message)) {
    return "CURSOR_UNAUTHORIZED";
  }
  if (/rate limit|too many requests|usage limit|quota exceeded|hit your limit|\b429\b/i.test(message)) {
    return "CURSOR_RATE_LIMITED";
  }
  return "CURSOR_EXECUTION_FAILED";
}

export function mapCursorError(error: unknown, apiKey?: string): GatewayError {
  if (error instanceof GatewayError) return error;
  const name = error instanceof Error ? error.name : "";
  const status = error && typeof error === "object" && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
  const message = error instanceof Error ? redactSecret(error.message, apiKey) : "";
  if (name === "AuthenticationError" || status === 401) {
    return new GatewayError("CURSOR_UNAUTHORIZED", "Cursor could not complete the inference turn", 401, false);
  }
  if (name === "RateLimitError" || status === 429) {
    return new GatewayError("CURSOR_RATE_LIMITED", "Cursor could not complete the inference turn", 429, true);
  }
  return mapCursorFailure(message || "Cursor could not complete the inference turn");
}

function mapCursorFailure(message: string): GatewayError {
  const code = mapCursorInfo(message);
  return new GatewayError(
    code,
    "Cursor could not complete the inference turn",
    code === "CURSOR_UNAUTHORIZED" ? 401 : code === "CURSOR_RATE_LIMITED" ? 429 : 502,
    code !== "CURSOR_UNAUTHORIZED"
  );
}

function abortError(reason: unknown): GatewayError {
  if (reason === "timeout") {
    return new GatewayError("CURSOR_TIMEOUT", "Cursor turn timed out", 504, true);
  }
  return new GatewayError("CURSOR_EXECUTION_FAILED", "The inference turn was cancelled", 409);
}

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(abortError(signal.reason));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

function redactSecret(value: string, secret?: string): string {
  if (!secret) return value;
  return value.split(secret).join("[redacted]");
}
