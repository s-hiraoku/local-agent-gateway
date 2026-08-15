import { spawn } from "node:child_process";
import { GatewayError } from "../../domain/errors.js";
import { appendBounded, sanitizeOutput } from "../codex/runner.js";
import type { CodingRunInput, CodingRunResult, CodingRunner } from "../runner.js";

// Claude provider for inference turns: runs Claude Code headless
// (`claude -p ... --json-schema ... --output-format json`) as a subprocess.
// The final assistant answer arrives as a native `structured_output` object in
// the JSON envelope, so there is no stdout scraping. Auth is the user's Claude
// login/subscription (never an API key in a request body), mirroring the codex
// subscription boundary. Filesystem/network tools are disallowed; the turn is
// pure text-in / JSON-out against an empty working directory.

type ClaudeRunnerConfig = {
  command: string;
  model?: string;
  turnTimeoutMs: number;
  maxResultBytes: number;
};

const DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "Read", "WebFetch", "WebSearch", "Glob", "Grep"];

export class ClaudeHeadlessRunner implements CodingRunner {
  constructor(private readonly config: ClaudeRunnerConfig) {}

  async checkReady(): Promise<void> {
    // A cheap version probe confirms the binary is present and runnable. A full
    // auth check would consume subscription usage on every readiness poll, so
    // authentication failures surface on the first real run instead.
    await this.spawnClaude(["--version"], undefined, 10_000, "readiness");
  }

  async run(input: CodingRunInput): Promise<CodingRunResult> {
    const args = [
      "--print",
      "--output-format", "json",
      "--json-schema", JSON.stringify(input.outputSchema ?? {}),
      "--disallowed-tools", ...DISALLOWED_TOOLS,
      ...(this.config.model ? ["--model", this.config.model] : []),
      input.prompt
    ];
    const stdout = await this.spawnClaude(args, input.repositoryPath, this.config.turnTimeoutMs, "turn", input.signal);

    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      throw new GatewayError("CLAUDE_EXECUTION_FAILED", "Claude did not return a JSON envelope", 502, true);
    }
    if (envelope.is_error === true || envelope.subtype !== "success") {
      const message = typeof envelope.result === "string" ? envelope.result : "Claude reported an error";
      const code = /unauthor|logged in|log in|authenticate|credit balance/i.test(message)
        ? "CLAUDE_UNAUTHORIZED"
        : "CLAUDE_EXECUTION_FAILED";
      throw new GatewayError(code, "Claude could not complete the inference turn", code === "CLAUDE_UNAUTHORIZED" ? 401 : 502, code !== "CLAUDE_UNAUTHORIZED");
    }

    // Prefer the native structured object; fall back to the result text.
    const structured = envelope.structured_output;
    const result = structured !== undefined && structured !== null
      ? JSON.stringify(structured)
      : typeof envelope.result === "string" ? envelope.result : "";
    if (!result) {
      throw new GatewayError("CLAUDE_EXECUTION_FAILED", "Claude returned an empty result", 502, true);
    }
    const bounded = appendBounded("", result, this.config.maxResultBytes);
    // Claude has no persistent backend thread in this mode; a fresh session id
    // per run is fine because inference turns are stateless.
    const sessionId = typeof envelope.session_id === "string" ? envelope.session_id : "claude-inference";
    return { backendThreadId: sessionId, result: sanitizeOutput(bounded, input.repositoryPath) };
  }

  private spawnClaude(
    args: string[],
    cwd: string | undefined,
    timeoutMs: number,
    phase: "readiness" | "turn",
    signal?: AbortSignal
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.config.command, args, {
        cwd,
        env: buildClaudeEnvironment(process.env),
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => finish(() => {
        child.kill("SIGKILL");
        const code = phase === "turn" ? "CLAUDE_TIMEOUT" : "CLAUDE_NOT_CONFIGURED";
        reject(new GatewayError(code, `Claude ${phase} timed out`, 504, phase === "turn"));
      }), timeoutMs);
      timer.unref();
      const onAbort = () => finish(() => {
        child.kill("SIGKILL");
        reject(new GatewayError("CLAUDE_EXECUTION_FAILED", "The inference turn was cancelled", 409));
      });
      signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        action();
      };

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-8192); });
      child.on("error", (error) => finish(() => {
        const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "CLAUDE_NOT_CONFIGURED" : "CLAUDE_EXECUTION_FAILED";
        reject(new GatewayError(code, "Claude executable could not be started", 502, code !== "CLAUDE_NOT_CONFIGURED"));
      }));
      child.on("close", (exitCode) => finish(() => {
        if (phase === "readiness") {
          if (exitCode === 0) resolve(stdout);
          else reject(new GatewayError("CLAUDE_NOT_CONFIGURED", "Claude readiness check failed", 503, false));
          return;
        }
        // For a turn, a non-zero exit still usually carries a JSON envelope with
        // is_error=true; let run() classify it. Only reject when there is no
        // parseable output at all.
        if (stdout.trim()) resolve(stdout);
        else reject(new GatewayError("CLAUDE_EXECUTION_FAILED", "Claude produced no output", 502, true));
      }));
    });
  }
}

export function buildClaudeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NO_COLOR: "1", TERM: "dumb" };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL"] as const) {
    const value = source[key];
    if (value) result[key] = value;
  }
  return result;
}
