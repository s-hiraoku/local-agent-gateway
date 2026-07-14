import type { FastifyInstance } from "fastify";
import { PassThrough } from "node:stream";
import { z } from "zod";
import type { TaskEventType, TaskRecord } from "../db/schema.js";
import type { Db } from "../db/connection.js";
import type { TaskRunner } from "../provider/task-runner.js";
import { createTask, getTask, listTasks } from "../tasks/tasks.js";
import { appendTaskEvent, listTaskEvents, publicTaskEvent } from "../tasks/task-events.js";
import { getTaskDiffArtifact } from "../tasks/diff-artifacts.js";
import {
  assertStructuredOutputSupported,
  authorizeTaskControl,
  authorizeTaskCreate,
  authorizeTaskRead
} from "../policy/task-policy.js";
import { listAllowedReposForScopes } from "../policy/repos.js";
import { requireScopes } from "../auth/authorize.js";
import { ApiError } from "../utils/errors.js";
import { hashPrompt } from "../auth/hash.js";
import { makeId } from "../utils/ids.js";
import { sanitizePublicJson, sanitizePublicText } from "../utils/sanitize.js";
import type { LiveTaskEvents } from "../tasks/live-events.js";
import type { TaskQueue } from "../tasks/task-queue.js";
import type { ActiveTaskSessions } from "../tasks/active-sessions.js";

const MAX_OUTPUT_SCHEMA_LENGTH = 16_000;

const createTaskSchema = z.object({
  repo: z.string().min(1).max(100).optional(),
  workspaceId: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/).optional(),
  provider: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/).optional(),
  prompt: z.string().min(1).max(20_000),
  mode: z.enum(["read-only", "workspace-write"]).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional()
}).strict().superRefine((body, ctx) => {
  if (Boolean(body.repo) === Boolean(body.workspaceId)) {
    ctx.addIssue({
      code: "custom",
      path: ["repo"],
      message: "Specify exactly one of repo or workspaceId"
    });
  }
  if (body.outputSchema && JSON.stringify(body.outputSchema).length > MAX_OUTPUT_SCHEMA_LENGTH) {
    ctx.addIssue({
      code: "custom",
      path: ["outputSchema"],
      message: `outputSchema must serialize to at most ${MAX_OUTPUT_SCHEMA_LENGTH} characters`
    });
  }
});

const listTasksQuerySchema = z.object({
  repo: z.string().min(1).max(100).optional(),
  status: z.enum(["queued", "pending", "completed", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();

const steerTaskSchema = z.object({
  message: z.string().min(1).max(2_000)
}).strict();

function previewPrompt(prompt: string): string {
  return `[prompt omitted; length=${prompt.length}]`;
}

function taskResponse(task: TaskRecord) {
  return {
    taskId: task.id,
    status: task.status,
    provider: task.provider,
    repo: task.repo,
    mode: task.mode,
    summary: sanitizePublicText(task.summary),
    changedFiles: task.changedFiles,
    structuredOutput: task.structuredOutput === null ? null : sanitizePublicJson(task.structuredOutput),
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    error: task.error
  };
}

export async function taskRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    taskRunners: Record<string, TaskRunner>;
    taskQueue: TaskQueue;
    liveTaskEvents: LiveTaskEvents;
    activeTaskSessions: ActiveTaskSessions;
  }
) {
  app.post("/v1/tasks", async (request, reply) => {
    request.audit = { ...request.audit, action: "tasks:create" };

    const body = createTaskSchema.parse(request.body);
    const { repo, mode, provider } = authorizeTaskCreate(
      request,
      { ...(body.repo ? { repoId: body.repo } : {}), ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}) },
      body.mode,
      body.provider
    );
    const taskRunner = deps.taskRunners[provider.id];
    if (!taskRunner) {
      throw new ApiError("PROVIDER_NOT_ALLOWED");
    }
    assertStructuredOutputSupported(provider, body.outputSchema);
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

    const task = createTask(deps.db, taskRunner, deps.taskQueue, {
      id: taskId,
      tokenId: request.auth.id,
      repoId: repo.id,
      cwd: repo.path,
      prompt: body.prompt,
      mode,
      providerId: provider.id,
      ...(body.outputSchema ? { outputSchema: body.outputSchema } : {}),
      liveEvents: deps.liveTaskEvents,
      activeSessions: deps.activeTaskSessions
    });
    return reply.status(202).send(taskResponse(task));
  });

  app.get("/v1/tasks", async (request) => {
    request.audit = { ...request.audit, action: "tasks:list" };
    requireScopes(request, ["task:read"]);
    if (!request.auth) {
      throw new ApiError("UNAUTHORIZED");
    }

    const query = listTasksQuerySchema.parse(request.query);
    const repos = listAllowedReposForScopes(request.auth.scopes).map((repo) => repo.id);
    if (query.repo && !repos.includes(query.repo)) {
      throw new ApiError("FORBIDDEN");
    }
    request.audit = { ...request.audit, repo: query.repo ?? null };

    return {
      tasks: listTasks(deps.db, {
        repos,
        limit: query.limit,
        ...(query.repo ? { repo: query.repo } : {}),
        ...(query.status ? { status: query.status } : {})
      }).map(taskResponse)
    };
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
    if (!isTerminalTask(task)) {
      const stream = new PassThrough();
      let closed = false;
      let lastSeenId = lastEventId ?? 0;
      let unsubscribe = () => {};
      const bufferedLive: (typeof events)[number][] = [];
      let replaying = true;

      const close = () => {
        if (!closed) {
          closed = true;
          unsubscribe();
          stream.end();
        }
      };

      const writeEvent = (event: (typeof events)[number]) => {
        if (closed || event.id <= lastSeenId) {
          return;
        }
        lastSeenId = event.id;
        stream.write(formatSseEvent(publicTaskEvent(task.id, event)));
        if (isTerminalEventType(event.type)) {
          close();
        }
      };

      unsubscribe = deps.liveTaskEvents.subscribe(task.id, (event) => {
        if (replaying) {
          bufferedLive.push(event);
          return;
        }
        writeEvent(event);
      });
      stream.write("retry: 2000\n\n");
      for (const event of events) {
        writeEvent(event);
      }
      for (const event of listTaskEvents(deps.db, task.id, lastSeenId)) {
        writeEvent(event);
      }
      replaying = false;
      bufferedLive.sort((a, b) => a.id - b.id).forEach(writeEvent);
      const currentTask = getTask(deps.db, task.id);
      if (!currentTask || isTerminalTask(currentTask)) {
        close();
      }
      request.raw.on("close", close);

      return reply
        .header("cache-control", "no-cache")
        .header("connection", "keep-alive")
        .type("text/event-stream; charset=utf-8")
        .send(stream);
    }

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

  app.post("/v1/tasks/:id/interrupt", async (request) => {
    request.audit = { ...request.audit, action: "tasks:interrupt" };
    z.object({}).strict().parse(request.body ?? {});
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const task = getTask(deps.db, params.id);
    if (!task) {
      throw new ApiError("NOT_FOUND");
    }

    request.audit = { ...request.audit, repo: task.repo, mode: task.mode, taskId: task.id };
    authorizeTaskControl(request, task);
    assertTaskControlAvailable(task, deps.activeTaskSessions);

    const interrupted = await deps.activeTaskSessions.interrupt(task.id);
    if (!interrupted) {
      throw new ApiError("CONFLICT", "Task control is not available yet");
    }
    appendAndPublishControlEvent(deps, task.id, { type: "task.interrupted", payload: {} });

    return { taskId: task.id, interrupted: true };
  });

  app.post("/v1/tasks/:id/steer", async (request) => {
    request.audit = { ...request.audit, action: "tasks:steer" };
    const body = steerTaskSchema.parse(request.body);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const task = getTask(deps.db, params.id);
    if (!task) {
      throw new ApiError("NOT_FOUND");
    }

    request.audit = {
      ...request.audit,
      repo: task.repo,
      mode: task.mode,
      taskId: task.id,
      promptHash: hashPrompt(body.message),
      promptPreview: previewPrompt(body.message)
    };
    authorizeTaskControl(request, task);
    assertTaskControlAvailable(task, deps.activeTaskSessions);

    const steered = await deps.activeTaskSessions.steer(task.id, body.message);
    if (!steered) {
      throw new ApiError("CONFLICT", "Task control is not available yet");
    }
    appendAndPublishControlEvent(deps, task.id, {
      type: "task.steered",
      payload: { messagePreview: previewPrompt(body.message) }
    });

    return { taskId: task.id, steered: true };
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

function isTerminalTask(task: TaskRecord): boolean {
  return task.status === "completed" || task.status === "failed";
}

function isTerminalEventType(type: TaskEventType): boolean {
  return type === "task.completed" || type === "task.failed";
}

function assertTaskControlAvailable(task: TaskRecord, activeTaskSessions: ActiveTaskSessions): void {
  if (task.status !== "pending" || !activeTaskSessions.hasActive(task.id)) {
    throw new ApiError("CONFLICT", "Task is not active");
  }
}

function appendAndPublishControlEvent(
  deps: { db: Db; liveTaskEvents: LiveTaskEvents },
  taskId: string,
  event: Parameters<typeof appendTaskEvent>[2]
) {
  const record = appendTaskEvent(deps.db, taskId, event);
  deps.liveTaskEvents.publish(record);
}
