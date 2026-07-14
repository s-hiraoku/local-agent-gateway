import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "../src/infrastructure/database.js";
import { openDatabase } from "../src/infrastructure/database.js";
import { SecretBox } from "../src/infrastructure/crypto.js";
import { GatewayStore } from "../src/application/store.js";

const databases: DatabaseHandle[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
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
  const conversation = await store.createConversation("owner", "gateway");
  return store.submitTurn({
    ownerId: "owner",
    conversationId: conversation.id,
    repositoryId: "gateway",
    prompt: "prompt",
    idempotencyKey: "store-request-1",
    requestHash: "hash",
    maxQueuedJobs: 10
  });
}

describe("GatewayStore", () => {
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

  it("enforces event and result resource limits", async () => {
    const { store } = createStore({ maxEventBytes: 32, maxEventsPerJob: 100, maxResultBytes: 3 });
    const submitted = await queuedJob(store);
    await store.claimNextJob();
    await expect(store.appendEvent(submitted.job.id, "agent.message.delta", { delta: "a message that is too large" }))
      .rejects.toThrow(/event exceeded/);
    await expect(store.completeJob(submitted.job.id, "long"))
      .rejects.toThrow(/result exceeded/);
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
