import type { Db } from "../db/connection.js";
import type { TaskRecord } from "../db/schema.js";
import type { TaskRunner } from "../provider/task-runner.js";
import type { TaskMode } from "../policy/modes.js";
import { makeId, nowIso } from "../utils/ids.js";
import { sanitizePublicText } from "../utils/sanitize.js";
import { appendTaskEvent } from "./task-events.js";
import { captureTaskDiffArtifact } from "./diff-artifacts.js";

type TaskRow = {
  id: string;
  token_id: string;
  provider: string;
  backend: string;
  repo: string;
  mode: string;
  thread_id: string | null;
  status: "pending" | "completed" | "failed";
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
  params: {
    tokenId: string;
    repoId: string;
    cwd: string;
    prompt: string;
    mode: TaskMode;
    id?: string;
  }
): TaskRecord {
  const task = createPendingTask(db, params);
  void runTask(db, runner, task.id, params);
  return task;
}

function createPendingTask(
  db: Db,
  params: {
    tokenId: string;
    repoId: string;
    mode: TaskMode;
    id?: string;
  }
): TaskRecord {
  const id = params.id ?? makeId("task");
  const createdAt = nowIso();

  db.prepare(
    `INSERT INTO tasks (
      id, token_id, provider, backend, repo, mode, thread_id, status, summary, changed_files_json, error, created_at, completed_at
    ) VALUES (
      @id, @tokenId, 'codex', 'app-server', @repo, @mode, NULL, 'pending', '', '[]', NULL, @createdAt, NULL
    )`
  ).run({
    id,
    tokenId: params.tokenId,
    repo: params.repoId,
    mode: params.mode,
    createdAt
  });
  appendTaskEvent(db, id, { type: "task.started", payload: { repo: params.repoId, mode: params.mode } });

  return getTask(db, id) as TaskRecord;
}

async function runTask(
  db: Db,
  runner: TaskRunner,
  id: string,
  params: {
    repoId: string;
    cwd: string;
    prompt: string;
    mode: TaskMode;
  }
): Promise<void> {
  let sawAgentMessage = false;
  let sawDiffUpdate = false;

  try {
    const result = await runner.runTask({
      prompt: params.prompt,
      cwd: params.cwd,
      mode: params.mode,
      onEvent: (event) => {
        if (event.type === "agent.message.completed") {
          sawAgentMessage = true;
        }
        if (event.type === "diff.available") {
          sawDiffUpdate = true;
        }
        appendTaskEvent(db, id, event);
      }
    });
    const completedAt = nowIso();
    if (!sawAgentMessage) {
      appendTaskEvent(db, id, {
        type: "agent.message.completed",
        payload: { text: result.summary, phase: "final_answer" }
      });
    }
    if (!sawDiffUpdate && result.changedFiles.length > 0) {
      appendTaskEvent(db, id, { type: "diff.available", payload: { changedFiles: result.changedFiles } });
    }
    await captureTaskDiffArtifact(db, { taskId: id, repoId: params.repoId, changedFiles: result.changedFiles });
    appendTaskEvent(db, id, { type: "task.completed", payload: { summary: result.summary } });

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
  } catch (error) {
    const completedAt = nowIso();
    const publicError = error instanceof Error ? sanitizePublicText(error.message) : "Task failed";
    appendTaskEvent(db, id, {
      type: "task.failed",
      payload: { error: publicError }
    });
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
  }
}

export function getTask(db: Db, id: string): TaskRecord | null {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  return row ? parseTaskRow(row) : null;
}
