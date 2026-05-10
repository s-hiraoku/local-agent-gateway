import type { Db } from "../db/connection.js";
import type { TaskEventRecord, TaskEventType } from "../db/schema.js";
import { nowIso } from "../utils/ids.js";
import { sanitizePublicText } from "../utils/sanitize.js";

type TaskEventRow = {
  id: number;
  task_id: string;
  type: TaskEventType;
  payload_json: string;
  created_at: string;
};

export type NewTaskEvent = {
  type: TaskEventType;
  payload?: Record<string, unknown>;
};

export function appendTaskEvent(db: Db, taskId: string, event: NewTaskEvent): TaskEventRecord {
  const createdAt = nowIso();
  const payload = sanitizePayload(event.payload ?? {});
  const result = db
    .prepare(
      `INSERT INTO task_events (task_id, type, payload_json, created_at)
       VALUES (@taskId, @type, @payloadJson, @createdAt)`
    )
    .run({
      taskId,
      type: event.type,
      payloadJson: JSON.stringify(payload),
      createdAt
    });

  return {
    id: Number(result.lastInsertRowid),
    taskId,
    type: event.type,
    payload,
    createdAt
  };
}

export function listTaskEvents(db: Db, taskId: string, afterId?: number): TaskEventRecord[] {
  const rows = db
    .prepare(
      afterId === undefined
        ? `SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC`
        : `SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC`
    )
    .all(...(afterId === undefined ? [taskId] : [taskId, afterId])) as TaskEventRow[];

  return rows.map(parseTaskEventRow);
}

export function publicTaskEvent(taskId: string, event: TaskEventRecord) {
  return {
    id: String(event.id),
    taskId,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt
  };
}

function parseTaskEventRow(row: TaskEventRow): TaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at
  };
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "threadId" || key === "cwd" || key === "raw" || key === "jsonRpc") {
      continue;
    }
    sanitized[key] = sanitizeValue(value);
  }
  return sanitized;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizePublicText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === "object") {
    return sanitizePayload(value as Record<string, unknown>);
  }
  return value;
}
