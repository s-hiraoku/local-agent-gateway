import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/connection.js";
import type { AuditLogRecord } from "../db/schema.js";
import { makeId, nowIso } from "../utils/ids.js";

type AuditLogRow = {
  id: string;
  timestamp: string;
  token_id: string | null;
  token_name: string | null;
  client_ip: string | null;
  user_agent: string | null;
  action: string;
  repo: string | null;
  mode: string | null;
  task_id: string | null;
  status: "success" | "failure";
  error: string | null;
  prompt_hash: string | null;
  prompt_preview: string | null;
};

function defaultAction(request: FastifyRequest): string {
  return `${request.method} ${request.routeOptions.url ?? request.url}`;
}

export function writeAuditLog(db: Db, request: FastifyRequest, reply: FastifyReply): void {
  const auth = request.auth;
  const audit = request.audit ?? {};
  const status = reply.statusCode >= 400 ? "failure" : "success";
  db.prepare(
    `INSERT INTO audit_logs (
      id, timestamp, token_id, token_name, client_ip, user_agent, action, repo, mode,
      task_id, status, error, prompt_hash, prompt_preview
    ) VALUES (
      @id, @timestamp, @tokenId, @tokenName, @clientIp, @userAgent, @action, @repo, @mode,
      @taskId, @status, @error, @promptHash, @promptPreview
    )`
  ).run({
    id: makeId("aud"),
    timestamp: nowIso(),
    tokenId: auth?.id ?? null,
    tokenName: auth?.name ?? null,
    clientIp: request.ip ?? null,
    userAgent: request.headers["user-agent"] ?? null,
    action: audit.action ?? defaultAction(request),
    repo: audit.repo ?? null,
    mode: audit.mode ?? null,
    taskId: audit.taskId ?? null,
    status,
    error: status === "failure" ? (audit.error ?? String(reply.statusCode)) : null,
    promptHash: audit.promptHash ?? null,
    promptPreview: audit.promptPreview ?? null
  });
}

export function listAuditLogs(
  db: Db,
  params: {
    action?: string | undefined;
    repo?: string | undefined;
    status?: "success" | "failure" | undefined;
    taskId?: string | undefined;
    limit: number;
  }
): AuditLogRecord[] {
  const filters: string[] = [];
  const values: Record<string, string | number> = { limit: params.limit };

  if (params.action) {
    filters.push("action = @action");
    values.action = params.action;
  }
  if (params.repo) {
    filters.push("repo = @repo");
    values.repo = params.repo;
  }
  if (params.status) {
    filters.push("status = @status");
    values.status = params.status;
  }
  if (params.taskId) {
    filters.push("task_id = @taskId");
    values.taskId = params.taskId;
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM audit_logs
       ${where}
       ORDER BY timestamp DESC, id DESC
       LIMIT @limit`
    )
    .all(values) as AuditLogRow[];

  return rows.map(parseAuditLogRow);
}

function parseAuditLogRow(row: AuditLogRow): AuditLogRecord {
  return {
    id: row.id,
    timestamp: row.timestamp,
    tokenId: row.token_id,
    tokenName: row.token_name,
    clientIp: row.client_ip,
    userAgent: row.user_agent,
    action: row.action,
    repo: row.repo,
    mode: row.mode,
    taskId: row.task_id,
    status: row.status,
    error: row.error,
    promptHash: row.prompt_hash,
    promptPreview: row.prompt_preview
  };
}
