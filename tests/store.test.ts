import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseHandle } from "../src/infrastructure/database.js";
import { openDatabase } from "../src/infrastructure/database.js";
import { SecretBox } from "../src/infrastructure/crypto.js";
import { GatewayStore } from "../src/application/store.js";

const databases: DatabaseHandle[] = [];
const temporaryDirectories: string[] = [];
const futureCutoff = "9999-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore(limits = { maxEventBytes: 1024, maxEventsPerJob: 100, maxResultBytes: 1024 }) {
  const database = openDatabase(":memory:");
  databases.push(database);
  return {
    database,
    store: new GatewayStore(database.db, new SecretBox(Buffer.alloc(32, 5)), limits)
  };
}

async function queuedJob(store: GatewayStore) {
  return queuedJobWithKey(store, "store-request-1");
}

async function queuedJobWithKey(store: GatewayStore, idempotencyKey: string) {
  const conversation = await store.createConversation("owner", "gateway");
  return store.submitTurn({
    ownerId: "owner",
    conversationId: conversation.id,
    repositoryId: "gateway",
    prompt: "prompt",
    idempotencyKey,
    requestHash: idempotencyKey,
    maxQueuedJobs: 10
  });
}

describe("GatewayStore", () => {
  it("claims a committed queued run after the database is reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexgw-restart-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "gateway.sqlite");
    const key = Buffer.alloc(32, 8);
    const firstDatabase = openDatabase(path);
    const firstStore = new GatewayStore(firstDatabase.db, new SecretBox(key));
    const submitted = await firstStore.submitRun({
      ownerId: "owner",
      repositoryId: "gateway",
      prompt: "durable",
      idempotencyKey: "durable-run-1",
      requestHash: "hash",
      maxQueuedJobs: 10
    });
    await firstDatabase.close();

    const reopened = openDatabase(path);
    databases.push(reopened);
    const reopenedStore = new GatewayStore(reopened.db, new SecretBox(key));
    await reopenedStore.recoverInterruptedJobs();
    expect((await reopenedStore.claimNextJob())?.id).toBe(submitted.job.id);
  });

  it("records every crash recovery as a distinct at-least-once attempt", async () => {
    const { store, database } = createStore();
    const submitted = await queuedJob(store);
    expect((await store.claimNextJob())?.attempts).toBe(1);
    await store.recoverInterruptedJobs();
    expect((await store.claimNextJob())?.attempts).toBe(2);
    const attempts = await database.db.selectFrom("jobAttempts").selectAll().orderBy("attempt", "asc").execute();
    expect(attempts.map((attempt) => ({ attempt: attempt.attempt, status: attempt.status, error: attempt.errorCode }))).toEqual([
      { attempt: 1, status: "failed", error: "GATEWAY_RESTARTED" },
      { attempt: 2, status: "running", error: null }
    ]);
    expect((await store.getJob("owner", submitted.job.id)).status).toBe("running");
  });

  it("emits a terminal cancellation event when recovery finishes a cancelled run", async () => {
    const { store, database } = createStore();
    const submitted = await queuedJob(store);
    await store.claimNextJob();
    expect(await store.requestCancellation("owner", submitted.job.id)).toBe("running");

    expect(await store.recoverInterruptedJobs()).toBe(0);

    expect((await store.getJob("owner", submitted.job.id)).status).toBe("cancelled");
    expect((await store.events("owner", submitted.job.id)).map((event) => event.type)).toEqual([
      "job.queued", "job.started", "job.cancelled"
    ]);
    const attempt = await database.db.selectFrom("jobAttempts").selectAll().executeTakeFirstOrThrow();
    expect(attempt.status).toBe("cancelled");
  });

  it("enforces event and result resource limits", async () => {
    const { store } = createStore({ maxEventBytes: 32, maxEventsPerJob: 100, maxResultBytes: 3 });
    const submitted = await queuedJob(store);
    await store.claimNextJob();
    await expect(store.appendEvent(submitted.job.id, "agent.message.delta", { delta: "a message that is too large" }))
      .rejects.toThrow(/event exceeded/);
    await expect(store.completeJob(submitted.job.id, "long"))
      .rejects.toThrow(/result exceeded/);
  });

  it("lets cancellation win atomically over completion and failure", async () => {
    const { store } = createStore();
    const completing = await queuedJob(store);
    await store.claimNextJob();
    expect(await store.requestCancellation("owner", completing.job.id)).toBe("running");
    await store.completeJob(completing.job.id, "too late");
    expect((await store.getJob("owner", completing.job.id)).status).toBe("cancelled");
    expect((await store.events("owner", completing.job.id)).map((event) => event.type)).toEqual([
      "job.queued", "job.started", "job.cancelled"
    ]);

    const failing = await queuedJobWithKey(store, "store-request-2");
    await store.claimNextJob();
    expect(await store.requestCancellation("owner", failing.job.id)).toBe("running");
    await store.failJob(failing.job.id, "CODEX_EXECUTION_FAILED", "too late", true);
    expect((await store.getJob("owner", failing.job.id)).status).toBe("cancelled");
  });

  it("does not let late cancellation overwrite completion", async () => {
    const { store } = createStore();
    const submitted = await queuedJob(store);
    await store.claimNextJob();
    await store.completeJob(submitted.job.id, "done");
    await store.markCancelled(submitted.job.id);
    expect((await store.getJob("owner", submitted.job.id)).status).toBe("completed");
    expect((await store.events("owner", submitted.job.id)).map((event) => event.type)).toEqual([
      "job.queued", "job.started", "job.completed"
    ]);
  });

  it("replays persisted events after a sequence cursor", async () => {
    const { store } = createStore();
    const submitted = await queuedJob(store);
    await store.claimNextJob();
    await store.appendEvent(submitted.job.id, "agent.message.delta", { delta: "safe" });
    const events = await store.events("owner", submitted.job.id, 2);
    expect(events).toHaveLength(1);
    expect(events[0]?.sequence).toBe(3);
  });

  it("prunes terminal jobs with their events, attempts, and idempotency records", async () => {
    const { store, database } = createStore();
    const submitted = await queuedJob(store);
    await store.claimNextJob();
    await store.completeJob(submitted.job.id, "ok");

    expect(await store.pruneExpired(futureCutoff)).toEqual({ jobs: 1, conversations: 1 });
    for (const table of ["jobs", "jobEvents", "jobAttempts", "idempotencyRecords", "conversations"] as const) {
      expect(await database.db.selectFrom(table).selectAll().execute()).toEqual([]);
    }
  });

  it("prunes failed and cancelled jobs too", async () => {
    const { store } = createStore();
    const failing = await queuedJobWithKey(store, "retention-fail");
    await store.claimNextJob();
    await store.failJob(failing.job.id, "CODEX_EXECUTION_FAILED", "boom", false);
    const cancelling = await queuedJobWithKey(store, "retention-cancel");
    await store.requestCancellation("owner", cancelling.job.id);

    expect((await store.pruneExpired(futureCutoff)).jobs).toBe(2);
  });

  it("never prunes queued or running jobs or their conversations", async () => {
    const { store, database } = createStore();
    await queuedJobWithKey(store, "retention-queued");
    await queuedJobWithKey(store, "retention-running");
    await store.claimNextJob();

    expect(await store.pruneExpired(futureCutoff)).toEqual({ jobs: 0, conversations: 0 });
    expect(await database.db.selectFrom("jobs").selectAll().execute()).toHaveLength(2);
    expect(await database.db.selectFrom("conversations").selectAll().execute()).toHaveLength(2);
  });

  it("keeps everything newer than the cutoff", async () => {
    const { store } = createStore();
    const submitted = await queuedJob(store);
    await store.claimNextJob();
    await store.completeJob(submitted.job.id, "ok");

    expect(await store.pruneExpired("1970-01-01T00:00:00.000Z")).toEqual({ jobs: 0, conversations: 0 });
    expect((await store.getJob("owner", submitted.job.id)).status).toBe("completed");
  });

  it("prunes strictly before the cutoff", async () => {
    const { store, database } = createStore();
    const submitted = await queuedJob(store);
    await store.claimNextJob();
    await store.completeJob(submitted.job.id, "ok");
    const boundary = "2001-01-01T00:00:00.000Z";
    await database.db.updateTable("jobs").set({ completedAt: boundary }).where("id", "=", submitted.job.id).execute();

    expect((await store.pruneExpired(boundary)).jobs).toBe(0);
    expect((await store.pruneExpired("2001-01-01T00:00:00.001Z")).jobs).toBe(1);
  });

  it("re-executes rather than replays an idempotency key after pruning", async () => {
    const { store } = createStore();
    const first = await queuedJobWithKey(store, "retention-replay");
    await store.claimNextJob();
    await store.completeJob(first.job.id, "ok");
    await store.pruneExpired(futureCutoff);

    const second = await queuedJobWithKey(store, "retention-replay");
    expect(second.replayed).toBe(false);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it("bumps a conversation's updatedAt when a turn is submitted", async () => {
    const { store, database } = createStore();
    const conversation = await store.createConversation("owner", "gateway");
    const stale = "2000-01-01T00:00:00.000Z";
    await database.db.updateTable("conversations").set({ updatedAt: stale }).where("id", "=", conversation.id).execute();
    await store.submitTurn({
      ownerId: "owner",
      conversationId: conversation.id,
      repositoryId: "gateway",
      prompt: "prompt",
      idempotencyKey: "retention-bump",
      requestHash: "retention-bump",
      maxQueuedJobs: 10
    });

    const row = await database.db.selectFrom("conversations").selectAll()
      .where("id", "=", conversation.id).executeTakeFirstOrThrow();
    expect(row.updatedAt > stale).toBe(true);
  });

  it("serializes turns in one conversation while allowing other conversations", async () => {
    const { store } = createStore();
    const firstConversation = await store.createConversation("owner", "gateway");
    const secondConversation = await store.createConversation("owner", "gateway");
    const submit = (conversationId: string, key: string) => store.submitTurn({
      ownerId: "owner",
      conversationId,
      repositoryId: "gateway",
      prompt: key,
      idempotencyKey: key,
      requestHash: key,
      maxQueuedJobs: 10
    });
    const first = await submit(firstConversation.id, "serial-request-1");
    await submit(firstConversation.id, "serial-request-2");
    const other = await submit(secondConversation.id, "parallel-request-1");

    expect((await store.claimNextJob())?.id).toBe(first.job.id);
    expect((await store.claimNextJob())?.id).toBe(other.job.id);
    expect(await store.claimNextJob()).toBeUndefined();
  });
});
