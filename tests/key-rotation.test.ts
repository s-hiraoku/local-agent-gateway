import { afterEach, describe, expect, it } from "vitest";
import { GatewayStore } from "../src/application/store.js";
import { SecretBox } from "../src/infrastructure/crypto.js";
import { openDatabase } from "../src/infrastructure/database.js";
import { rotateEncryptedPayloads } from "../src/infrastructure/key-rotation.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function seededStore(key: Buffer) {
  const database = openDatabase(":memory:");
  closers.push(database.close);
  const secrets = new SecretBox(key);
  const store = new GatewayStore(database.db, secrets);
  await store.assertEncryptionKey();
  const conversation = await store.createConversation("owner", "gateway");
  await store.submitTurn({
    ownerId: "owner",
    conversationId: conversation.id,
    repositoryId: "gateway",
    prompt: "review this",
    idempotencyKey: "rotate-1",
    requestHash: secrets.digest("rotate-1"),
    maxQueuedJobs: 10
  });
  return { database, store, secrets };
}

describe("encryption key rotation", () => {
  it("re-encrypts payloads in one transaction and refuses a mismatched key", async () => {
    const oldKey = Buffer.alloc(32, 3);
    const newKey = Buffer.alloc(32, 9);
    const { database } = await seededStore(oldKey);

    const result = await rotateEncryptedPayloads(database.db, new SecretBox(oldKey), new SecretBox(newKey));
    expect(result.jobs).toBe(1);
    expect(result.events).toBeGreaterThan(0);
    expect(await database.db.selectFrom("idempotencyRecords").selectAll().execute()).toEqual([]);

    const rotated = new GatewayStore(database.db, new SecretBox(newKey));
    await expect(rotated.assertEncryptionKey()).resolves.toBeUndefined();
    const job = await rotated.claimNextJob();
    expect(job).toBeDefined();
    expect(rotated.decryptPrompt(job!)).toBe("review this");

    const wrong = new GatewayStore(database.db, new SecretBox(Buffer.alloc(32, 1)));
    await expect(wrong.assertEncryptionKey()).rejects.toMatchObject({ code: "ENCRYPTION_KEY_MISMATCH" });
  });

  it("leaves the database unchanged when rotation fails", async () => {
    const oldKey = Buffer.alloc(32, 3);
    const { database, store } = await seededStore(oldKey);
    await expect(rotateEncryptedPayloads(
      database.db,
      new SecretBox(oldKey),
      new SecretBox(oldKey)
    )).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(store.assertEncryptionKey()).resolves.toBeUndefined();
    const job = await store.claimNextJob();
    expect(job).toBeDefined();
    expect(store.decryptPrompt(job!)).toBe("review this");
  });

  it("validates existing ciphertext before creating a missing sentinel", async () => {
    const oldKey = Buffer.alloc(32, 3);
    const { database } = await seededStore(oldKey);
    await database.db.updateTable("gatewayMetadata").set({ encryptionSentinel: null }).where("id", "=", 1).execute();

    const wrong = new GatewayStore(database.db, new SecretBox(Buffer.alloc(32, 1)));
    await expect(wrong.assertEncryptionKey()).rejects.toMatchObject({ code: "ENCRYPTION_KEY_MISMATCH" });
    expect((await database.db.selectFrom("gatewayMetadata").select("encryptionSentinel").where("id", "=", 1).executeTakeFirst())?.encryptionSentinel).toBeNull();

    const restored = new GatewayStore(database.db, new SecretBox(oldKey));
    await expect(restored.assertEncryptionKey()).resolves.toBeUndefined();
    expect((await database.db.selectFrom("gatewayMetadata").select("encryptionSentinel").where("id", "=", 1).executeTakeFirst())?.encryptionSentinel).toBeTruthy();
  });
});
