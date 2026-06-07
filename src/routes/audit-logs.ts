import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/connection.js";
import { requireScopes } from "../auth/authorize.js";
import { listAuditLogs } from "../audit/audit-log.js";
import type { AuditLogRecord } from "../db/schema.js";

const listAuditLogsQuerySchema = z.object({
  action: z.string().min(1).max(100).optional(),
  repo: z.string().min(1).max(100).optional(),
  status: z.enum(["success", "failure"]).optional(),
  taskId: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();

export async function auditLogRoutes(app: FastifyInstance, deps: { db: Db }) {
  app.get("/v1/audit-logs", async (request) => {
    request.audit = { ...request.audit, action: "audit-logs:list" };
    requireScopes(request, ["audit:read"]);

    const query = listAuditLogsQuerySchema.parse(request.query);
    return {
      auditLogs: listAuditLogs(deps.db, query).map(publicAuditLog)
    };
  });
}

function publicAuditLog(record: AuditLogRecord) {
  return {
    id: record.id,
    timestamp: record.timestamp,
    tokenId: record.tokenId,
    tokenName: record.tokenName,
    clientIp: record.clientIp,
    userAgent: record.userAgent,
    action: record.action,
    repo: record.repo,
    mode: record.mode,
    taskId: record.taskId,
    status: record.status,
    error: record.error,
    promptHash: record.promptHash,
    promptPreview: record.promptPreview
  };
}
