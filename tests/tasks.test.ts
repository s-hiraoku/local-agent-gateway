import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { authHeader, FakeTaskRunner, issueToken, makeTestApp } from "./helpers.js";

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

  override async runTask(params: Parameters<FakeTaskRunner["runTask"]>[0]) {
    this.calls.push(params);
    await new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
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
      repo: "local-agent-gateway",
      mode: "read-only"
    });
    expect(response.json().threadId).toBeUndefined();
    expect(runner.calls[0]?.mode).toBe("read-only");

    const task = await waitForTask(app, token.token, response.json().taskId as string);
    expect(task).toMatchObject({
      status: "completed",
      summary: "task completed",
      changedFiles: []
    });
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

  it("does not expose task interrupt or steer endpoints before active session support exists", async () => {
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
    expect(created.statusCode).toBe(202);
    const taskId = created.json().taskId as unknown;
    expect(taskId).toEqual(expect.any(String));
    expect(taskId).not.toBe("");

    const interruptResponse = await app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId as string}/interrupt`,
      headers: authHeader(token.token),
      payload: {}
    });

    const steerResponse = await app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId as string}/steer`,
      headers: authHeader(token.token),
      payload: {
        message: "Please adjust course"
      }
    });

    expect(interruptResponse.statusCode).toBe(404);
    expect(steerResponse.statusCode).toBe(404);
  });
});
