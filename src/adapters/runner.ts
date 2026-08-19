import type { OutputSchema } from "../domain/structured-output.js";

// Provider-neutral contract for a backend that runs one read-only turn.
// Codex (App Server over stdio), Claude (Code CLI headless), and Grok (Build
// CLI headless) all implement it; the job processor picks an implementation
// by job kind / config.

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
  checkReady(): Promise<void>;
}
