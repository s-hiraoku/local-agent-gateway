import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { TaskEventRecord, TaskEventType } from "../src/db/schema.js";
import { LiveTaskEvents } from "../src/tasks/live-events.js";
import { appendTaskEvent } from "../src/tasks/task-events.js";
import { TaskQueue } from "../src/tasks/task-queue.js";
import { authHeader, FakeTaskRunner, issueToken, makeTestApp, makeTestDb } from "./helpers.js";

async function waitForTask(app: FastifyInstance, token: string, taskId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}`,
      headers: authHeader(token)
    });
    const body = response.json();
    if (body.status === "completed" || body.status === "failed") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for task completion");
}

async function waitForCondition(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

class BlockingTaskRunner extends FakeTaskRunner {
  resolvers: Array<() => void> = [];
  interruptCount = 0;
  steeredMessages: string[] = [];

  override async runTask(params: Parameters<FakeTaskRunner["runTask"]>[0]) {
    this.calls.push(params);
    await new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
      params.onControlHandle?.({
        interrupt: () => {
          this.interruptCount += 1;
          resolve();
        },
        steer: (message) => {
          this.steeredMessages.push(message);
        }
      });
    });
    return {
      provider: "codex",
      backend: "app-server",
      threadId: "thr_test",
      summary: this.summary,
      changedFiles: this.changedFiles
    };
  }
}

class SubscribeInjectingLiveTaskEvents extends LiveTaskEvents {
  constructor(private readonly onSubscribe: (taskId: string) => TaskEventRecord | null) {
    super();
  }

  override subscribe(taskId: string, listener: (event: TaskEventRecord) => void): () => void {
    const unsubscribe = super.subscribe(taskId, listener);
    const event = this.onSubscribe(taskId);
    if (event) {
      listener(event);
    }
    return unsubscribe;
  }
}

class StatusObservingLiveTaskEvents extends LiveTaskEvents {
  terminalStatuses: string[] = [];

  constructor(private readonly readStatus: (taskId: string) => string) {
    super();
  }

  override publish(event: TaskEventRecord): void {
    if (isTerminalEventType(event.type)) {
      this.terminalStatuses.push(this.readStatus(event.taskId));
    }
    super.publish(event);
  }
}

function isTerminalEventType(type: TaskEventType): boolean {
  return type === "task.completed" || type === "task.failed";
}

describe("tasks", () => {
  it("accepts a read-only task and completes it in the background", async () => {
    const runner = new FakeTaskRunner();
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: "pending",
      provider: "codex",
      repo: "local-agent-gateway",
      mode: "read-only"
    });
    expect(response.json().threadId).toBeUndefined();
    expect(runner.calls[0]?.mode).toBe("read-only");
    expect(runner.calls[0]?.providerId).toBe("codex");

    const task = await waitForTask(app, token.token, response.json().taskId as string);
    expect(task).toMatchObject({
      status: "completed",
      provider: "codex",
      summary: "task completed",
      changedFiles: []
    });
  });

  it("accepts an explicit registered provider without exposing backend internals", async () => {
    const runner = new FakeTaskRunner();
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        provider: "codex",
        prompt: "Read README",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      provider: "codex",
      repo: "local-agent-gateway",
      mode: "read-only"
    });
    expect(JSON.stringify(response.json())).not.toContain("app-server");
    expect(runner.calls[0]?.providerId).toBe("codex");
  });

  it("runs a task with an output schema and exposes sanitized structured output", async () => {
    const runner = new FakeTaskRunner();
    runner.structuredOutput = {
      verdict: "revise",
      confidence: 0.8,
      summary: "needs a rewrite of /Users/name/project/outline.md",
      issues: [{ reason: "path in /tmp/scratch stays structural" }]
    };
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Review this artifact",
        mode: "read-only",
        outputSchema: schema
      }
    });

    expect(response.statusCode).toBe(202);
    expect(runner.calls[0]?.outputSchema).toEqual(schema);

    const task = await waitForTask(app, token.token, response.json().taskId as string);
    expect(task.status).toBe("completed");
    // String leaves are scrubbed; JSON structure and non-string values survive.
    expect(task.structuredOutput).toEqual({
      verdict: "revise",
      confidence: 0.8,
      summary: "needs a rewrite of [redacted-path]",
      issues: [{ reason: "path in [redacted-path] stays structural" }]
    });
  });

  it("returns null structured output for tasks created without a schema", async () => {
    const runner = new FakeTaskRunner();
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });

    expect(runner.calls[0]?.outputSchema).toBeUndefined();
    const task = await waitForTask(app, token.token, response.json().taskId as string);
    expect(task.structuredOutput).toBeNull();
  });

  it("rejects an outputSchema that is not an object", async () => {
    const { app, db } = makeTestApp({ taskRunner: new FakeTaskRunner() });
    const token = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);

    for (const outputSchema of ["not-an-object", 42, ["array"]]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        headers: authHeader(token.token),
        payload: {
          repo: "local-agent-gateway",
          prompt: "Review",
          mode: "read-only",
          outputSchema
        }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects an oversized outputSchema", async () => {
    const { app, db } = makeTestApp({ taskRunner: new FakeTaskRunner() });
    const token = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Review",
        mode: "read-only",
        outputSchema: { padding: "x".repeat(17_000) }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects workspace-write when token lacks workspace-write scope", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Change README",
        mode: "workspace-write"
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("creates an audit log for task creation without storing full prompt", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);
    const prompt = "A".repeat(250);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt,
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(202);
    const row = db.prepare("SELECT * FROM audit_logs WHERE action = 'tasks:create'").get() as {
      repo: string;
      mode: string;
      status: string;
      prompt_hash: string;
      prompt_preview: string;
    };

    expect(row.repo).toBe("local-agent-gateway");
    expect(row.mode).toBe("read-only");
    expect(row.status).toBe("success");
    expect(row.prompt_hash).toHaveLength(64);
    expect(row.prompt_preview).toBe(`[prompt omitted; length=${prompt.length}]`);
    expect(row.prompt_preview).not.toBe(prompt);
  });

  it("does not include local absolute paths in task responses", async () => {
    const runner = new FakeTaskRunner();
    runner.summary =
      "Read /Users/name/project/README.md, /home/runner/work/repo/file.ts, /workspace/app/secret, C:\\Users\\name\\secret.txt, \\\\server\\share\\secret.txt, and /tmp/project/secret";
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(202);
    const task = await waitForTask(app, token.token, response.json().taskId as string);
    expect(JSON.stringify(task)).not.toContain("/Users/name");
    expect(JSON.stringify(task)).not.toContain("/home/runner");
    expect(JSON.stringify(task)).not.toContain("/workspace/app");
    expect(JSON.stringify(task)).not.toContain("C:\\Users");
    expect(JSON.stringify(task)).not.toContain("\\\\server\\share");
    expect(JSON.stringify(task)).not.toContain("/tmp/project");
    expect(JSON.stringify(task)).toContain("[redacted-path]");
  });

  it("marks background task failures without leaking runner details through create", async () => {
    const runner = new FakeTaskRunner();
    runner.error = new Error("failed at /Users/name/project/secret.txt");
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("pending");

    const task = await waitForTask(app, token.token, response.json().taskId as string);
    expect(task.status).toBe("failed");
    expect(task.error).toContain("[redacted-path]");
    expect(task.error).not.toContain("/Users/name");
  });

  it("allows a creator without task:read to poll its own task", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });

    expect(createResponse.statusCode).toBe(202);

    const readResponse = await app.inject({
      method: "GET",
      url: `/v1/tasks/${createResponse.json().taskId as string}`,
      headers: authHeader(token.token)
    });

    expect(readResponse.statusCode).toBe(200);
  });

  it("lists authorized tasks without exposing internal ids", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });
    const taskId = created.json().taskId as string;
    await waitForTask(app, token.token, taskId);

    const response = await app.inject({
      method: "GET",
      url: "/v1/tasks?repo=local-agent-gateway&status=completed&limit=10",
      headers: authHeader(token.token)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tasks).toHaveLength(1);
    expect(response.json().tasks[0]).toMatchObject({
      taskId,
      status: "completed",
      repo: "local-agent-gateway"
    });
    expect(JSON.stringify(response.json())).not.toContain("thr_test");
  });

  it("requires task:read and repo scope for task listing", async () => {
    const { app, db } = makeTestApp();
    const withoutRead = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);
    const withoutRepo = issueToken(db, ["task:read"], { name: "reader" });

    const missingRead = await app.inject({
      method: "GET",
      url: "/v1/tasks",
      headers: authHeader(withoutRead.token)
    });
    expect(missingRead.statusCode).toBe(403);

    const missingRepo = await app.inject({
      method: "GET",
      url: "/v1/tasks?repo=local-agent-gateway",
      headers: authHeader(withoutRepo.token)
    });
    expect(missingRepo.statusCode).toBe(403);
  });

  it("rejects non-owners without task:read when reading a task", async () => {
    const { app, db } = makeTestApp();
    const owner = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);
    const other = issueToken(db, ["repo:local-agent-gateway", "mode:read-only"], { name: "other-token" });

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(owner.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });

    expect(createResponse.statusCode).toBe(202);

    const readResponse = await app.inject({
      method: "GET",
      url: `/v1/tasks/${createResponse.json().taskId as string}`,
      headers: authHeader(other.token)
    });

    expect(readResponse.statusCode).toBe(403);
  });

  it("records append-only task lifecycle events", async () => {
    const runner = new FakeTaskRunner();
    runner.changedFiles = ["README.md"];
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:workspace-write"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Change README",
        mode: "workspace-write"
      }
    });

    expect(response.statusCode).toBe(202);
    const taskId = response.json().taskId as string;
    await waitForTask(app, token.token, taskId);

    const rows = db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC").all(taskId) as Array<{
      type: string;
      payload_json: string;
    }>;

    expect(rows.map((row) => row.type)).toEqual([
      "task.started",
      "agent.message.completed",
      "diff.available",
      "task.completed"
    ]);
    expect(JSON.parse(rows[2]?.payload_json ?? "{}")).toEqual({ changedFiles: ["README.md"] });
  });

  it("queues workspace-write tasks per repo while allowing read-only tasks to run", async () => {
    const runner = new BlockingTaskRunner();
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only", "mode:workspace-write"]);

    const first = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "First write",
        mode: "workspace-write"
      }
    });
    await waitForCondition(() => runner.calls.length === 1, "first write task did not start");

    const second = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Second write",
        mode: "workspace-write"
      }
    });
    expect(second.statusCode).toBe(202);
    expect(second.json().status).toBe("queued");
    expect(runner.calls).toHaveLength(1);

    const readOnly = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read while write is active",
        mode: "read-only"
      }
    });
    expect(readOnly.statusCode).toBe(202);
    await waitForCondition(() => runner.calls.length === 2, "read-only task did not run while write was active");

    runner.resolvers[0]?.();
    await waitForCondition(() => runner.calls.length === 3, "queued write task did not start");
    const queuedTask = await app.inject({
      method: "GET",
      url: `/v1/tasks/${second.json().taskId as string}`,
      headers: authHeader(token.token)
    });
    expect(queuedTask.json().status).toBe("pending");

    runner.resolvers[1]?.();
    runner.resolvers[2]?.();
    await waitForTask(app, token.token, first.json().taskId as string);
    await waitForTask(app, token.token, second.json().taskId as string);
    await waitForTask(app, token.token, readOnly.json().taskId as string);
  });

  it("limits parallel read-only tasks with a queue", async () => {
    const runner = new BlockingTaskRunner();
    const { app, db } = makeTestApp({ taskRunner: runner, taskQueue: new TaskQueue(1) });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const first = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "First read",
        mode: "read-only"
      }
    });
    await waitForCondition(() => runner.calls.length === 1, "first read task did not start");

    const second = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Second read",
        mode: "read-only"
      }
    });
    expect(second.statusCode).toBe(202);
    expect(second.json().status).toBe("queued");
    expect(runner.calls).toHaveLength(1);

    runner.resolvers[0]?.();
    await waitForCondition(() => runner.calls.length === 2, "queued read task did not start");

    const queuedTask = await app.inject({
      method: "GET",
      url: `/v1/tasks/${second.json().taskId as string}`,
      headers: authHeader(token.token)
    });
    expect(queuedTask.json().status).toBe("pending");

    runner.resolvers[1]?.();
    await waitForTask(app, token.token, first.json().taskId as string);
    await waitForTask(app, token.token, second.json().taskId as string);
  });

  it("fails incomplete tasks on startup because prompts and runner handles are not persisted", async () => {
    const runner = new BlockingTaskRunner();
    const db = makeTestDb();
    const firstApp = makeTestApp({ db, taskRunner: runner }).app;
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:workspace-write"]);

    const created = await firstApp.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Long write",
        mode: "workspace-write"
      }
    });
    await waitForCondition(() => runner.calls.length === 1, "write task did not start");
    await firstApp.close();

    const secondApp = makeTestApp({ db, taskRunner: new FakeTaskRunner() }).app;
    const response = await secondApp.inject({
      method: "GET",
      url: `/v1/tasks/${created.json().taskId as string}`,
      headers: authHeader(token.token)
    });
    expect(response.json()).toMatchObject({
      status: "failed",
      error: "Task did not complete before Gateway startup"
    });

    const events = db
      .prepare("SELECT type, payload_json FROM task_events WHERE task_id = ? ORDER BY id ASC")
      .all(created.json().taskId) as Array<{ type: string; payload_json: string }>;
    expect(events.at(-1)?.type).toBe("task.failed");
    expect(JSON.parse(events.at(-1)?.payload_json ?? "{}")).toEqual({
      provider: "codex",
      error: "Task did not complete before Gateway startup",
      recovery: "startup"
    });
    await secondApp.close();
  });

  it("streams live task events until a pending task completes", async () => {
    const runner = new BlockingTaskRunner();
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Long read",
        mode: "read-only"
      }
    });
    const taskId = created.json().taskId as string;
    await waitForCondition(() => runner.calls.length === 1, "task did not start");

    const eventsPromise = app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}/events`,
      headers: authHeader(token.token)
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    runner.resolvers[0]?.();
    const response = await eventsPromise;

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: task.started");
    expect(response.body).toContain("event: task.completed");
    expect(response.body).toContain(`"taskId":"${taskId}"`);
  });

  it("keeps persisted replay events ordered when live events arrive during SSE replay", async () => {
    const runner = new BlockingTaskRunner();
    const db = makeTestDb();
    let injected = false;
    const liveTaskEvents = new SubscribeInjectingLiveTaskEvents((taskId) => {
      if (injected) {
        return null;
      }
      injected = true;
      return appendTaskEvent(db, taskId, {
        type: "agent.message.completed",
        payload: { text: "live during replay" }
      });
    });
    const { app } = makeTestApp({ db, taskRunner: runner, liveTaskEvents });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Long read",
        mode: "read-only"
      }
    });
    const taskId = created.json().taskId as string;
    await waitForCondition(() => runner.calls.length === 1, "task did not start");

    const eventsPromise = app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}/events`,
      headers: authHeader(token.token)
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    runner.resolvers[0]?.();
    const response = await eventsPromise;

    expect(response.statusCode).toBe(200);
    expect(response.body.indexOf("event: task.started")).toBeGreaterThan(-1);
    expect(response.body.indexOf("event: agent.message.completed")).toBeGreaterThan(
      response.body.indexOf("event: task.started")
    );
  });

  it("publishes terminal events only after the task row is terminal", async () => {
    const db = makeTestDb();
    const liveTaskEvents = new StatusObservingLiveTaskEvents((taskId) => {
      const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      return row.status;
    });
    const { app } = makeTestApp({ db, liveTaskEvents });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });
    await waitForTask(app, token.token, created.json().taskId as string);

    expect(liveTaskEvents.terminalStatuses).toEqual(["completed"]);
  });

  it("publishes failed events only after the task row is failed", async () => {
    const db = makeTestDb();
    const runner = new FakeTaskRunner();
    runner.error = new Error("failed");
    const liveTaskEvents = new StatusObservingLiveTaskEvents((taskId) => {
      const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      return row.status;
    });
    const { app } = makeTestApp({ db, taskRunner: runner, liveTaskEvents });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Fail",
        mode: "read-only"
      }
    });
    await waitForTask(app, token.token, created.json().taskId as string);

    expect(liveTaskEvents.terminalStatuses).toEqual(["failed"]);
  });

  it("records failed task events with sanitized public payloads", async () => {
    const runner = new FakeTaskRunner();
    runner.error = new Error("failed in /Users/name/project/secret.txt");
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Fail",
        mode: "read-only"
      }
    });

    expect(response.statusCode).toBe(202);
    await waitForTask(app, token.token, response.json().taskId as string);
    const rows = db.prepare("SELECT type, payload_json FROM task_events ORDER BY id ASC").all() as Array<{
      type: string;
      payload_json: string;
    }>;

    expect(rows.map((row) => row.type)).toEqual(["task.started", "task.failed"]);
    expect(rows[1]?.payload_json).not.toContain("/Users/name");
    expect(rows[1]?.payload_json).toContain("[redacted-path]");
  });

  it("replays task events as authorized SSE without internal ids or raw cwd", async () => {
    const runner = new FakeTaskRunner();
    runner.summary = "Read /Volumes/SSD/secret/repo/file.ts";
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });
    const taskId = created.json().taskId as string;
    await waitForTask(app, token.token, taskId);

    const response = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}/events`,
      headers: authHeader(token.token)
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: task.started");
    expect(response.body).toContain("event: task.completed");
    expect(response.body).toContain(`"taskId":"${taskId}"`);
    expect(response.body).not.toContain("thr_test");
    expect(response.body).not.toContain("/Volumes/SSD");
    const call = runner.calls[0];
    expect(call).toBeDefined();
    if (!call) {
      throw new Error("Fake runner was not called");
    }
    expect(call.cwd).toBeDefined();
    expect(response.body).not.toContain(call.cwd);
    expect(response.body).toContain("[redacted-path]");
  });

  it("supports Last-Event-ID for completed task event replay", async () => {
    const { app, db } = makeTestApp();
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });
    const taskId = created.json().taskId as string;
    await waitForTask(app, token.token, taskId);
    const firstEvent = db.prepare("SELECT id FROM task_events WHERE task_id = ? ORDER BY id ASC LIMIT 1").get(taskId) as {
      id: number;
    };

    const response = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}/events`,
      headers: { ...authHeader(token.token), "last-event-id": String(firstEvent.id) }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(`id: ${firstEvent.id}\n`);
    expect(response.body).toContain("event: task.completed");
  });

  it("requires task read authorization for task events", async () => {
    const { app, db } = makeTestApp();
    const owner = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);
    const other = issueToken(db, ["task:read"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(owner.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/tasks/${created.json().taskId}`,
      headers: authHeader(other.token)
    });

    expect(response.statusCode).toBe(403);

    const eventsResponse = await app.inject({
      method: "GET",
      url: `/v1/tasks/${created.json().taskId}/events`,
      headers: authHeader(other.token)
    });

    expect(eventsResponse.statusCode).toBe(403);
  });

  it("returns an authorized task diff artifact without internal ids or raw cwd", async () => {
    const runner = new FakeTaskRunner();
    runner.changedFiles = ["README.md", "/Users/name/project/secret.txt", "../outside.txt"];
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:workspace-write"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Change README",
        mode: "workspace-write"
      }
    });
    const taskId = created.json().taskId as string;
    await waitForTask(app, token.token, taskId);

    const response = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}/diff`,
      headers: authHeader(token.token)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      taskId,
      repo: "local-agent-gateway",
      status: "completed",
      changedFiles: ["README.md"],
      truncated: false
    });
    expect(response.json().threadId).toBeUndefined();
    expect(JSON.stringify(response.json())).not.toContain("thr_test");
    expect(JSON.stringify(response.json())).not.toContain("/Users/name");
    const call = runner.calls[0];
    expect(call).toBeDefined();
    if (!call) {
      throw new Error("Fake runner was not called");
    }
    expect(JSON.stringify(response.json())).not.toContain(call.cwd);
  });

  it("treats diff artifact changed files as literal paths", async () => {
    const runner = new FakeTaskRunner();
    runner.changedFiles = [":(glob)**/*.ts"];
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:workspace-write"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Change unusual file",
        mode: "workspace-write"
      }
    });
    const taskId = created.json().taskId as string;
    await waitForTask(app, token.token, taskId);

    const response = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}/diff`,
      headers: authHeader(token.token)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      taskId,
      changedFiles: [":(glob)**/*.ts"],
      patch: ""
    });
    expect(JSON.stringify(response.json())).not.toContain("src/tasks/diff-artifacts.ts");
  });

  it("serves stored diff artifacts instead of reading the live task row at request time", async () => {
    const runner = new FakeTaskRunner();
    runner.changedFiles = ["README.md"];
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:workspace-write"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Change README",
        mode: "workspace-write"
      }
    });
    const taskId = created.json().taskId as string;
    await waitForTask(app, token.token, taskId);

    db.prepare(
      `UPDATE task_diff_artifacts
       SET changed_files_json = ?, patch = ?, truncated = 0
       WHERE task_id = ?`
    ).run(JSON.stringify(["README.md"]), "stored patch snapshot", taskId);
    db.prepare("UPDATE tasks SET changed_files_json = ? WHERE id = ?").run(JSON.stringify(["docs/index.md"]), taskId);

    const response = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}/diff`,
      headers: authHeader(token.token)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      taskId,
      changedFiles: ["README.md"],
      patch: "stored patch snapshot"
    });
  });

  it("requires task read authorization for task diff artifacts", async () => {
    const { app, db } = makeTestApp();
    const owner = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);
    const other = issueToken(db, ["task:read"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(owner.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });
    const taskId = created.json().taskId as string;

    const ownerResponse = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}/diff`,
      headers: authHeader(owner.token)
    });
    expect(ownerResponse.statusCode).toBe(200);

    const otherResponse = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}/diff`,
      headers: authHeader(other.token)
    });
    expect(otherResponse.statusCode).toBe(403);
  });

  it("interrupts an active task through the process-local session registry", async () => {
    const runner = new BlockingTaskRunner();
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });
    expect(created.statusCode).toBe(202);
    const taskId = created.json().taskId as string;
    await waitForCondition(() => runner.calls.length === 1, "task did not start");

    const interruptResponse = await app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId}/interrupt`,
      headers: authHeader(token.token),
      payload: {}
    });

    expect(interruptResponse.statusCode).toBe(200);
    expect(interruptResponse.json()).toEqual({ taskId, interrupted: true });
    expect(runner.interruptCount).toBe(1);
    await waitForTask(app, token.token, taskId);

    const rows = db.prepare("SELECT type FROM task_events WHERE task_id = ? ORDER BY id ASC").all(taskId) as Array<{
      type: string;
    }>;
    expect(rows.map((row) => row.type)).toContain("task.interrupted");
  });

  it("steers an active task without storing the steering text in audit logs", async () => {
    const runner = new BlockingTaskRunner();
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:read-only"]);
    const message = "Please adjust course toward tests";

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });
    expect(created.statusCode).toBe(202);
    const taskId = created.json().taskId as string;
    await waitForCondition(() => runner.calls.length === 1, "task did not start");

    const steerResponse = await app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId}/steer`,
      headers: authHeader(token.token),
      payload: {
        message
      }
    });

    expect(steerResponse.statusCode).toBe(200);
    expect(steerResponse.json()).toEqual({ taskId, steered: true });
    expect(runner.steeredMessages).toEqual([message]);

    const event = db.prepare("SELECT payload_json FROM task_events WHERE task_id = ? AND type = 'task.steered'").get(taskId) as {
      payload_json: string;
    };
    expect(event.payload_json).toContain(`[prompt omitted; length=${message.length}]`);
    expect(event.payload_json).not.toContain(message);

    const audit = db.prepare("SELECT prompt_hash, prompt_preview FROM audit_logs WHERE action = 'tasks:steer'").get() as {
      prompt_hash: string;
      prompt_preview: string;
    };
    expect(audit.prompt_hash).toHaveLength(64);
    expect(audit.prompt_preview).toBe(`[prompt omitted; length=${message.length}]`);
    expect(audit.prompt_preview).not.toBe(message);

    runner.resolvers[0]?.();
    await waitForTask(app, token.token, taskId);
  });

  it("requires task control scope for non-owner task steering", async () => {
    const runner = new BlockingTaskRunner();
    const { app, db } = makeTestApp({ taskRunner: runner });
    const owner = issueToken(db, ["task:create", "repo:local-agent-gateway", "mode:read-only"]);
    const reader = issueToken(db, ["task:read", "repo:local-agent-gateway"], { name: "reader" });
    const controller = issueToken(db, ["task:read", "task:control", "repo:local-agent-gateway"], { name: "controller" });

    const created = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(owner.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Read README",
        mode: "read-only"
      }
    });
    const taskId = created.json().taskId as string;
    await waitForCondition(() => runner.calls.length === 1, "task did not start");

    const missingControl = await app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId}/steer`,
      headers: authHeader(reader.token),
      payload: { message: "No control scope" }
    });
    expect(missingControl.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId}/steer`,
      headers: authHeader(controller.token),
      payload: { message: "Allowed steering" }
    });
    expect(allowed.statusCode).toBe(200);
    expect(runner.steeredMessages).toEqual(["Allowed steering"]);

    runner.resolvers[0]?.();
    await waitForTask(app, owner.token, taskId);
  });

  it("rejects task control for queued or finished tasks", async () => {
    const runner = new BlockingTaskRunner();
    const { app, db } = makeTestApp({ taskRunner: runner });
    const token = issueToken(db, ["task:create", "task:read", "repo:local-agent-gateway", "mode:workspace-write"]);

    const first = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "First write",
        mode: "workspace-write"
      }
    });
    await waitForCondition(() => runner.calls.length === 1, "first task did not start");

    const queued = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: authHeader(token.token),
      payload: {
        repo: "local-agent-gateway",
        prompt: "Queued write",
        mode: "workspace-write"
      }
    });
    expect(queued.json().status).toBe("queued");

    const queuedInterrupt = await app.inject({
      method: "POST",
      url: `/v1/tasks/${queued.json().taskId as string}/interrupt`,
      headers: authHeader(token.token),
      payload: {}
    });
    expect(queuedInterrupt.statusCode).toBe(409);
    expect(queuedInterrupt.json().error.code).toBe("CONFLICT");

    runner.resolvers[0]?.();
    await waitForTask(app, token.token, first.json().taskId as string);
    await waitForCondition(() => runner.calls.length === 2, "queued task did not start");
    runner.resolvers[1]?.();
    await waitForTask(app, token.token, queued.json().taskId as string);

    const finishedInterrupt = await app.inject({
      method: "POST",
      url: `/v1/tasks/${first.json().taskId as string}/interrupt`,
      headers: authHeader(token.token),
      payload: {}
    });
    expect(finishedInterrupt.statusCode).toBe(409);
    expect(finishedInterrupt.json().error.code).toBe("CONFLICT");
  });
});
