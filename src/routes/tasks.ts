import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/connection.js";
import type { TaskRunner } from "../provider/task-runner.js";
import { createTask, getTask } from "../codex/tasks.js";
import { listTaskEvents, publicTaskEvent } from "../codex/task-events.js";
import { getTaskDiffArtifact } from "../codex/diff-artifacts.js";
import { authorizeTaskCreate, authorizeTaskRead } from "../policy/task-policy.js";
import { ApiError } from "../utils/errors.js";
import { hashPrompt } from "../auth/hash.js";
import { makeId } from "../utils/ids.js";
import { sanitizePublicText } from "../utils/sanitize.js";

const createTaskSchema = z.object({
  repo: z.string().min(1).max(100),
  prompt: z.string().min(1).max(20_000),
  mode: z.enum(["read-only", "workspace-write"]).optional()
}).strict();

function previewPrompt(prompt: string): string {
  return `[prompt omitted; length=${prompt.length}]`;
}

function taskResponse(task: NonNullable<ReturnType<typeof getTask>>) {
  return {
    taskId: task.id,
    status: task.status,
    repo: task.repo,
    mode: task.mode,
    summary: sanitizePublicText(task.summary),
    changedFiles: task.changedFiles,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    error: task.error
  };
}

export async function taskRoutes(app: FastifyInstance, deps: { db: Db; taskRunner: TaskRunner }) {
  app.post("/v1/tasks", async (request, reply) => {
    request.audit = { ...request.audit, action: "tasks:create" };

    const body = createTaskSchema.parse(request.body);
    const { repo, mode } = authorizeTaskCreate(request, body.repo, body.mode);
    request.audit = {
      ...request.audit,
      repo: repo.id,
      mode,
      promptHash: hashPrompt(body.prompt),
      promptPreview: previewPrompt(body.prompt)
    };

    if (!request.auth) {
      throw new ApiError("UNAUTHORIZED");
    }

    const taskId = makeId("task");
    request.audit = { ...request.audit, taskId };

    const task = createTask(deps.db, deps.taskRunner, {
      id: taskId,
      tokenId: request.auth.id,
      repoId: repo.id,
      cwd: repo.path,
      prompt: body.prompt,
      mode
    });
    return reply.status(202).send(taskResponse(task));
  });

  app.get("/v1/tasks/:id/events", async (request, reply) => {
    request.audit = { ...request.audit, action: "tasks:events:read" };
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const lastEventId = parseLastEventId(request.headers["last-event-id"]);
    const task = getTask(deps.db, params.id);
    if (!task) {
      throw new ApiError("NOT_FOUND");
    }

    request.audit = { ...request.audit, repo: task.repo, mode: task.mode, taskId: task.id };
    authorizeTaskRead(request, task);

    const events = listTaskEvents(deps.db, task.id, lastEventId);
    const body = `retry: 2000\n\n${events.map((event) => formatSseEvent(publicTaskEvent(task.id, event))).join("")}`;
    return reply
      .header("cache-control", "no-cache")
      .header("connection", "keep-alive")
      .type("text/event-stream; charset=utf-8")
      .send(body);
  });

  app.get("/v1/tasks/:id/diff", async (request) => {
    request.audit = { ...request.audit, action: "tasks:diff:read" };
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const task = getTask(deps.db, params.id);
    if (!task) {
      throw new ApiError("NOT_FOUND");
    }

    request.audit = { ...request.audit, repo: task.repo, mode: task.mode, taskId: task.id };
    authorizeTaskRead(request, task);

    return getTaskDiffArtifact(deps.db, task);
  });

  app.get("/v1/tasks/:id", async (request) => {
    request.audit = { ...request.audit, action: "tasks:read" };
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const task = getTask(deps.db, params.id);
    if (!task) {
      throw new ApiError("NOT_FOUND");
    }

    request.audit = { ...request.audit, repo: task.repo, mode: task.mode, taskId: task.id };
    authorizeTaskRead(request, task);

    return taskResponse(task);
  });
}

function parseLastEventId(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function formatSseEvent(event: ReturnType<typeof publicTaskEvent>): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
