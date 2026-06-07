export type ApiTokenRecord = {
  id: string;
  name: string;
  prefix: string;
  tokenHash: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

export type TaskRecord = {
  id: string;
  tokenId: string;
  provider: string;
  backend: string;
  repo: string;
  mode: string;
  threadId: string | null;
  status: "queued" | "pending" | "completed" | "failed";
  summary: string;
  changedFiles: string[];
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type TaskEventType =
  | "task.queued"
  | "task.started"
  | "task.interrupted"
  | "task.steered"
  | "task.completed"
  | "task.failed"
  | "agent.message.delta"
  | "agent.message.completed"
  | "tool.started"
  | "tool.completed"
  | "file.changed"
  | "diff.available"
  | "approval.requested"
  | "approval.resolved";

export type TaskEventRecord = {
  id: number;
  taskId: string;
  type: TaskEventType;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type TaskDiffArtifactRecord = {
  taskId: string;
  changedFiles: string[];
  patch: string;
  truncated: boolean;
  createdAt: string;
};

export type AuditLogRecord = {
  id: string;
  timestamp: string;
  tokenId: string | null;
  tokenName: string | null;
  clientIp: string | null;
  userAgent: string | null;
  action: string;
  repo: string | null;
  mode: string | null;
  taskId: string | null;
  status: "success" | "failure";
  error: string | null;
  promptHash: string | null;
  promptPreview: string | null;
};
