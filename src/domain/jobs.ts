export const terminalJobStatuses = new Set(["completed", "failed", "cancelled"] as const);

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type PublicJob = {
  id: string;
  conversationId: string;
  repositoryId: string | null;
  kind: "coding.turn" | "inference.turn";
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: string | null;
  structuredOutput: unknown | null;
  error: { code: string; message: string; retryable: boolean } | null;
};

export type PublicEvent = {
  sequence: number;
  type: string;
  data: unknown;
  createdAt: string;
};

export function isTerminal(status: JobStatus): boolean {
  return terminalJobStatuses.has(status as "completed" | "failed" | "cancelled");
}

export type GatewayMetrics = {
  // Snapshot derived entirely from SQLite, so it is accurate after any restart.
  jobsByStatus: Record<JobStatus, number>;
  jobsByKind: Record<"coding.turn" | "inference.turn", number>;
  queue: {
    depth: number; // queued + running
    queued: number;
    running: number;
    oldestQueuedAgeSeconds: number | null;
  };
  retriedJobs: number; // jobs whose attempts > 1 (Codex flakiness signal)
  window: {
    since: string;
    failuresByErrorCode: Record<string, number>;
    completedDurationSeconds: { count: number; p50: number | null; p95: number | null };
  };
  uptimeSeconds: number;
};
