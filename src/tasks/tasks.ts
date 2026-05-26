import type { Db } from "../db/connection.js";
import type { TaskEventRecord, TaskRecord } from "../db/schema.js";
import type { TaskRunner } from "../provider/task-runner.js";
import type { TaskMode } from "../policy/modes.js";
import { makeId, nowIso } from "../utils/ids.js";
import { sanitizePublicText } from "../utils/sanitize.js";
import { appendTaskEvent } from "./task-events.js";
import { captureTaskDiffArtifact } from "./diff-artifacts.js";
import type { LiveTaskEvents } from "./live-events.js";
import type { InitialTaskStatus, TaskQueue } from "./task-queue.js";
import type { ActiveTaskSessions } from "./active-sessions.js";

type TaskRow = {
  id: string;
  token_id: string;
  provider: string;
  backend: string;
  repo: string;
  mode: string;
  thread_id: string | null;
  status: "queued" | "pending" | "completed" | "failed";
  summary: string;
  changed_files_json: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

export function parseTaskRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    tokenId: row.token_id,
    provider: row.provider,
    backend: row.backend,
    repo: row.repo,
    mode: row.mode,
    threadId: row.thread_id,
    status: row.status,
    summary: row.summary,
    changedFiles: JSON.parse(row.changed_files_json) as string[],
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

export function createTask(
  db: Db,
  runner: TaskRunner,
  queue: TaskQueue,
  params: {
    tokenId: string;
    repoId: string;
    cwd: string;
    prompt: string;
    mode: TaskMode;
    id?: string;
    liveEvents?: LiveTaskEvents;
    activeSessions?: ActiveTaskSessions;
  }
): TaskRecord {
  const initialStatus = queue.initialStatus(params.repoId, params.mode);
  const task = createTaskRecord(db, params, initialStatus, params.liveEvents);
  queue.enqueue({
    repoId: params.repoId,
    mode: params.mode,
    run: () => runTask(db, runner, task.id, params)
  });
  return task;
}

function createTaskRecord(
  db: Db,
  params: {
    tokenId: string;
    repoId: string;
    mode: TaskMode;
    id?: string;
  },
  status: InitialTaskStatus,
  liveEvents?: LiveTaskEvents
): TaskRecord {
  const id = params.id ?? makeId("task");
  const createdAt = nowIso();

  db.prepare(
    `INSERT INTO tasks (
      id, token_id, provider, backend, repo, mode, thread_id, status, summary, changed_files_json, error, created_at, completed_at
    ) VALUES (
      @id, @tokenId, 'codex', 'app-server', @repo, @mode, NULL, @status, '', '[]', NULL, @createdAt, NULL
    )`
  ).run({
    id,
    tokenId: params.tokenId,
    repo: params.repoId,
    mode: params.mode,
    status,
    createdAt
  });
  if (status === "queued") {
    appendAndPublish(db, liveEvents, id, { type: "task.queued", payload: { repo: params.repoId, mode: params.mode } });
  }

  return getTask(db, id) as TaskRecord;
}

async function runTask(
  db: Db,
  runner: TaskRunner,
  id: string,
  params: {
    tokenId: string;
    repoId: string;
    cwd: string;
    prompt: string;
    mode: TaskMode;
    liveEvents?: LiveTaskEvents;
    activeSessions?: ActiveTaskSessions;
  }
): Promise<void> {
  let sawAgentMessage = false;
  let sawDiffUpdate = false;
  let activeSession: ReturnType<ActiveTaskSessions["register"]> | null = null;

  try {
    markTaskStarted(db, id, params.repoId, params.mode, params.liveEvents);
    activeSession = params.activeSessions?.register({
      taskId: id,
      tokenId: params.tokenId,
      repo: params.repoId,
      mode: params.mode
    }) ?? null;
    const result = await runner.runTask({
      prompt: params.prompt,
      cwd: params.cwd,
      mode: params.mode,
      onControlHandle: (handle) => activeSession?.attachHandle(handle),
      onEvent: (event) => {
        if (event.type === "agent.message.completed") {
          sawAgentMessage = true;
        }
        if (event.type === "diff.available") {
          sawDiffUpdate = true;
        }
        appendAndPublish(db, params.liveEvents, id, event);
      }
    });
    const completedAt = nowIso();
    if (!sawAgentMessage) {
      appendAndPublish(db, params.liveEvents, id, {
        type: "agent.message.completed",
        payload: { text: result.summary, phase: "final_answer" }
      });
    }
    if (!sawDiffUpdate && result.changedFiles.length > 0) {
      appendAndPublish(db, params.liveEvents, id, { type: "diff.available", payload: { changedFiles: result.changedFiles } });
    }
    await captureTaskDiffArtifact(db, { taskId: id, repoId: params.repoId, changedFiles: result.changedFiles });
    db.prepare(
      `UPDATE tasks
       SET thread_id = @threadId,
           provider = @provider,
           backend = @backend,
           status = 'completed',
           summary = @summary,
           changed_files_json = @changedFilesJson,
           completed_at = @completedAt
       WHERE id = @id`
    ).run({
      id,
      threadId: result.threadId,
      provider: result.provider,
      backend: result.backend,
      summary: sanitizePublicText(result.summary),
      changedFilesJson: JSON.stringify(result.changedFiles),
      completedAt
    });
    appendAndPublish(db, params.liveEvents, id, { type: "task.completed", payload: { summary: result.summary } });
  } catch (error) {
    const completedAt = nowIso();
    const publicError = error instanceof Error ? sanitizePublicText(error.message) : "Task failed";
    db.prepare(
      `UPDATE tasks
       SET status = 'failed',
           error = @error,
           completed_at = @completedAt
       WHERE id = @id`
    ).run({
      id,
      error: publicError,
      completedAt
    });
    appendAndPublish(db, params.liveEvents, id, {
      type: "task.failed",
      payload: { error: publicError }
    });
  } finally {
    activeSession?.complete();
  }
}

function markTaskStarted(db: Db, id: string, repoId: string, mode: TaskMode, liveEvents?: LiveTaskEvents): void {
  db.prepare("UPDATE tasks SET status = 'pending' WHERE id = ? AND status = 'queued'").run(id);
  appendAndPublish(db, liveEvents, id, { type: "task.started", payload: { repo: repoId, mode } });
}

function appendAndPublish(
  db: Db,
  liveEvents: LiveTaskEvents | undefined,
  taskId: string,
  event: Parameters<typeof appendTaskEvent>[2]
): TaskEventRecord {
  const record = appendTaskEvent(db, taskId, event);
  liveEvents?.publish(record);
  return record;
}

export function getTask(db: Db, id: string): TaskRecord | null {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  return row ? parseTaskRow(row) : null;
}

export function listTasks(
  db: Db,
  params: {
    repos: readonly string[];
    repo?: string;
    status?: TaskRecord["status"];
    limit: number;
  }
): TaskRecord[] {
  if (params.repos.length === 0) {
    return [];
  }

  const repos = params.repo ? params.repos.filter((repo) => repo === params.repo) : [...params.repos];
  if (repos.length === 0) {
    return [];
  }

  const repoPlaceholders = repos.map((_, index) => `@repo${index}`).join(", ");
  const values: Record<string, string | number> = {
    limit: params.limit
  };
  repos.forEach((repo, index) => {
    values[`repo${index}`] = repo;
  });

  const filters = [`repo IN (${repoPlaceholders})`];
  if (params.status) {
    filters.push("status = @status");
    values.status = params.status;
  }

  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE ${filters.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT @limit`
    )
    .all(values) as TaskRow[];
  return rows.map(parseTaskRow);
}

export function failIncompleteTasksOnStartup(db: Db): number {
  const tasks = db
    .prepare("SELECT * FROM tasks WHERE status IN ('queued', 'pending') ORDER BY created_at ASC, id ASC")
    .all() as TaskRow[];
  if (tasks.length === 0) {
    return 0;
  }

  const completedAt = nowIso();
  const error = "Task did not complete before Gateway startup";
  const update = db.prepare(
    `UPDATE tasks
     SET status = 'failed',
         error = @error,
         completed_at = @completedAt
     WHERE id = @id AND status IN ('queued', 'pending')`
  );

  const failTask = db.transaction((rows: TaskRow[]) => {
    for (const row of rows) {
      update.run({ id: row.id, error, completedAt });
      appendTaskEvent(db, row.id, {
        type: "task.failed",
        payload: { error, recovery: "startup" }
      });
    }
  });

  failTask(tasks);
  return tasks.length;
}
