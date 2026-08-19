import { spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayError } from "../../domain/errors.js";
import { appendBounded, sanitizeOutput } from "../codex/runner.js";
import type { CodingRunInput, CodingRunResult, CodingRunner } from "../runner.js";

// Grok provider for inference turns: runs the official Grok Build CLI headless
// (`grok --output-format json --prompt-file ...`) against the owner's grok.com
// login. Tools are disabled so the turn stays text-in / JSON-out. Auth is the
// local subscription session in ~/.grok; request bodies never carry an API key.

type GrokRunnerConfig = {
  command: string;
  model?: string;
  turnTimeoutMs: number;
  maxResultBytes: number;
};

export class GrokHeadlessRunner implements CodingRunner {
  constructor(private readonly config: GrokRunnerConfig) {}

  async checkReady(): Promise<void> {
    // A cheap version probe confirms the binary is present. A full auth check
    // would consume subscription usage on every readiness poll.
    await this.spawnGrok(["--version"], undefined, 10_000, "readiness");
  }

  async run(input: CodingRunInput): Promise<CodingRunResult> {
    // Grok does not read the prompt from stdin. Write it into the private
    // single-use workspace so it never appears on argv or in the process table.
    const promptFile = join(input.repositoryPath, ".gateway-prompt");
    writeFileSync(promptFile, input.prompt, { encoding: "utf8", mode: 0o600 });
    try {
      const args = [
        "--output-format", "json",
        "--prompt-file", promptFile,
        "--verbatim",
        "--sandbox", "read-only",
        "--permission-mode", "dontAsk",
        "--disable-web-search",
        "--disallowed-tools", "Agent",
        ...(input.outputSchema ? ["--json-schema", JSON.stringify(input.outputSchema)] : []),
        ...(this.config.model ? ["--model", this.config.model] : []),
        // Empty allowlist: no built-in tools. MCP meta-tools are not in this list,
        // so Agent is also denied above.
        "--tools", ""
      ];
      const stdout = await this.spawnGrok(
        args,
        input.repositoryPath,
        this.config.turnTimeoutMs,
        "turn",
        input.signal
      );
      const envelope = parseGrokEnvelope(stdout);
      if (envelope.is_error === true || (envelope.subtype !== undefined && envelope.subtype !== "success")) {
        const message = typeof envelope.result === "string" ? envelope.result : grokErrorText(envelope);
        const code = mapGrokInfo(message);
        throw new GatewayError(
          code,
          "Grok could not complete the inference turn",
          code === "GROK_UNAUTHORIZED" ? 401 : code === "GROK_RATE_LIMITED" ? 429 : 502,
          code !== "GROK_UNAUTHORIZED"
        );
      }

      const structured = envelope.structured_output;
      const result = structured !== undefined && structured !== null
        ? JSON.stringify(structured)
        : typeof envelope.result === "string" ? envelope.result : "";
      if (!result) {
        throw new GatewayError("GROK_EXECUTION_FAILED", "Grok returned an empty result", 502, true);
      }
      const bounded = appendBounded("", result, this.config.maxResultBytes);
      const sessionId = typeof envelope.session_id === "string"
        ? envelope.session_id
        : typeof envelope.sessionId === "string"
          ? envelope.sessionId
          : "grok-inference";
      return { backendThreadId: sessionId, result: sanitizeOutput(bounded, input.repositoryPath) };
    } finally {
      try { unlinkSync(promptFile); } catch { /* workspace is ephemeral */ }
    }
  }

  private spawnGrok(
    args: string[],
    cwd: string | undefined,
    timeoutMs: number,
    phase: "readiness" | "turn",
    signal?: AbortSignal
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.config.command, args, {
        cwd,
        env: buildGrokEnvironment(process.env),
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (!child.stdout || !child.stderr) {
        child.kill("SIGKILL");
        reject(new GatewayError("GROK_EXECUTION_FAILED", "Grok executable could not be started", 502, true));
        return;
      }
      let stdout = "";
      let stdoutBytes = 0;
      let settled = false;
      const maxStdoutBytes = phase === "turn"
        ? this.config.maxResultBytes * 2 + 8192
        : 65_536;
      const timer = setTimeout(() => finish(() => {
        child.kill("SIGKILL");
        const code = phase === "turn" ? "GROK_TIMEOUT" : "GROK_NOT_CONFIGURED";
        reject(new GatewayError(code, `Grok ${phase} timed out`, 504, phase === "turn"));
      }), timeoutMs);
      timer.unref();
      const onAbort = () => finish(() => {
        child.kill("SIGKILL");
        reject(new GatewayError("GROK_EXECUTION_FAILED", "The inference turn was cancelled", 409));
      });
      signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        action();
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > maxStdoutBytes) {
          finish(() => {
            child.kill("SIGKILL");
            reject(new GatewayError("GROK_EXECUTION_FAILED", "Grok produced an oversized response", 502, true));
          });
          return;
        }
        stdout += chunk.toString();
      });
      child.stderr.on("data", () => undefined);
      child.on("error", (error) => finish(() => {
        const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "GROK_NOT_CONFIGURED" : "GROK_EXECUTION_FAILED";
        reject(new GatewayError(code, "Grok executable could not be started", 502, code !== "GROK_NOT_CONFIGURED"));
      }));
      child.on("close", (exitCode) => finish(() => {
        if (phase === "readiness") {
          if (exitCode === 0) resolve(stdout);
          else reject(new GatewayError("GROK_NOT_CONFIGURED", "Grok readiness check failed", 503, false));
          return;
        }
        if (stdout.trim()) resolve(stdout);
        else reject(new GatewayError("GROK_EXECUTION_FAILED", "Grok produced no output", 502, true));
      }));
    });
  }
}

function parseGrokEnvelope(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        // fall through
      }
    }
    throw new GatewayError("GROK_EXECUTION_FAILED", "Grok did not return a JSON envelope", 502, true);
  }
}

function grokErrorText(envelope: Record<string, unknown>): string {
  if (typeof envelope.error === "string") return envelope.error;
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
    const first = envelope.errors[0];
    if (typeof first === "string") return first;
  }
  return "Grok reported an error";
}

export function mapGrokInfo(message: string): "GROK_UNAUTHORIZED" | "GROK_RATE_LIMITED" | "GROK_EXECUTION_FAILED" {
  if (/unauthor|logged in|log in|authenticate|not signed in|auth\.json/i.test(message)) {
    return "GROK_UNAUTHORIZED";
  }
  if (/rate limit|too many requests|usage limit|quota exceeded|hit your limit|\b429\b/i.test(message)) {
    return "GROK_RATE_LIMITED";
  }
  return "GROK_EXECUTION_FAILED";
}

export function buildGrokEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Do not forward XAI_API_KEY: that would switch billing from the grok.com
  // subscription session to metered Platform API spend.
  const result: NodeJS.ProcessEnv = {
    NO_COLOR: "1",
    TERM: "dumb",
    GROK_SANDBOX: "read-only"
  };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "GROK_HOME"] as const) {
    const value = source[key];
    if (value) result[key] = value;
  }
  return result;
}
