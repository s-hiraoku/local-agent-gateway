import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "../db/connection.js";
import type { TaskDiffArtifactRecord, TaskRecord } from "../db/schema.js";
import { getAllowedRepo } from "../policy/repos.js";
import { nowIso } from "../utils/ids.js";
import { sanitizePublicText } from "../utils/sanitize.js";

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 256 * 1024;
const GIT_DIFF_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

type TaskDiffArtifactRow = {
  task_id: string;
  changed_files_json: string;
  patch: string;
  truncated: number;
  created_at: string;
};

export type TaskDiffArtifact = {
  taskId: string;
  repo: string;
  status: TaskRecord["status"];
  changedFiles: string[];
  patch: string;
  truncated: boolean;
  createdAt: string | null;
};

export async function captureTaskDiffArtifact(
  db: Db,
  params: {
    taskId: string;
    repoId: string;
    changedFiles: readonly string[];
  }
): Promise<void> {
  const changedFiles = safeChangedFiles(params.changedFiles);
  const patch = changedFiles.length > 0 ? await gitDiff(params.repoId, changedFiles) : { text: "", truncated: false };
  storeTaskDiffArtifact(db, {
    taskId: params.taskId,
    changedFiles,
    patch: patch.text,
    truncated: patch.truncated,
    createdAt: nowIso()
  });
}

export function getTaskDiffArtifact(db: Db, task: TaskRecord): TaskDiffArtifact {
  const artifact = getStoredTaskDiffArtifact(db, task.id);
  if (!artifact) {
    return {
      taskId: task.id,
      repo: task.repo,
      status: task.status,
      changedFiles: safeChangedFiles(task.changedFiles),
      patch: "",
      truncated: false,
      createdAt: null
    };
  }

  return {
    taskId: task.id,
    repo: task.repo,
    status: task.status,
    changedFiles: artifact.changedFiles,
    patch: artifact.patch,
    truncated: artifact.truncated,
    createdAt: artifact.createdAt
  };
}

function storeTaskDiffArtifact(db: Db, artifact: TaskDiffArtifactRecord): void {
  db.prepare(
    `INSERT INTO task_diff_artifacts (
      task_id, changed_files_json, patch, truncated, created_at
    ) VALUES (
      @taskId, @changedFilesJson, @patch, @truncated, @createdAt
    )
    ON CONFLICT(task_id) DO UPDATE SET
      changed_files_json = excluded.changed_files_json,
      patch = excluded.patch,
      truncated = excluded.truncated,
      created_at = excluded.created_at`
  ).run({
    taskId: artifact.taskId,
    changedFilesJson: JSON.stringify(artifact.changedFiles),
    patch: artifact.patch,
    truncated: artifact.truncated ? 1 : 0,
    createdAt: artifact.createdAt
  });
}

function getStoredTaskDiffArtifact(db: Db, taskId: string): TaskDiffArtifactRecord | null {
  const row = db.prepare("SELECT * FROM task_diff_artifacts WHERE task_id = ?").get(taskId) as
    | TaskDiffArtifactRow
    | undefined;
  return row ? parseTaskDiffArtifactRow(row) : null;
}

function parseTaskDiffArtifactRow(row: TaskDiffArtifactRow): TaskDiffArtifactRecord {
  return {
    taskId: row.task_id,
    changedFiles: JSON.parse(row.changed_files_json) as string[],
    patch: row.patch,
    truncated: row.truncated === 1,
    createdAt: row.created_at
  };
}

async function gitDiff(repoId: string, changedFiles: readonly string[]): Promise<{ text: string; truncated: boolean }> {
  try {
    const repo = getAllowedRepo(repoId);
    const result = await execFileAsync(
      "git",
      ["-C", repo.path, "diff", "--no-ext-diff", "--", ...changedFiles],
      {
        encoding: "utf8",
        maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES,
        env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" }
      }
    );
    const text = sanitizePublicText(result.stdout);
    const truncated = Buffer.byteLength(text, "utf8") > MAX_DIFF_BYTES;
    return {
      text: truncated ? text.slice(0, MAX_DIFF_BYTES) : text,
      truncated
    };
  } catch {
    return { text: "", truncated: false };
  }
}

function safeChangedFiles(files: readonly string[]): string[] {
  return files.filter(isSafeRepoRelativePath);
}

function isSafeRepoRelativePath(file: string): boolean {
  if (!file || file.includes("\0") || file.startsWith("/") || file.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(file)) {
    return false;
  }

  const parts = file.split(/[\\/]+/);
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}
