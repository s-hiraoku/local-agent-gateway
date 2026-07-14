export const terminalJobStatuses = new Set(["completed", "failed", "cancelled"] as const);

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type PublicJob = {
  id: string;
  conversationId: string;
  repositoryId: string;
  kind: "coding.turn";
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: string | null;
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
