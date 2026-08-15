import type { Kysely } from "kysely";
import { GatewayError } from "../domain/errors.js";
import {
  ENCRYPTION_SENTINEL_CONTEXT,
  ENCRYPTION_SENTINEL_PLAINTEXT,
  SecretBox
} from "./crypto.js";
import type { GatewayDatabase } from "./database.js";

export type RotationResult = {
  jobs: number;
  events: number;
};

export async function rotateEncryptedPayloads(
  db: Kysely<GatewayDatabase>,
  current: SecretBox,
  next: SecretBox
): Promise<RotationResult> {
  if (current.keyId === next.keyId) {
    throw new GatewayError("INVALID_REQUEST", "The new data encryption key must differ from the current key", 500);
  }
  const sentinel = (await db.selectFrom("gatewayMetadata").select("encryptionSentinel").where("id", "=", 1).executeTakeFirstOrThrow())
    .encryptionSentinel;
  if (sentinel && current.decrypt(sentinel, ENCRYPTION_SENTINEL_CONTEXT) !== ENCRYPTION_SENTINEL_PLAINTEXT) {
    throw new GatewayError("ENCRYPTION_KEY_MISMATCH", "The data encryption key cannot decrypt stored payloads", 500);
  }

  return db.transaction().execute(async (trx) => {
    const jobs = await trx.selectFrom("jobs")
      .select(["id", "encryptedPrompt", "encryptedOutputSchema", "encryptedResult"])
      .execute();
    let jobCount = 0;
    for (const job of jobs) {
      await trx.updateTable("jobs").set({
        encryptedPrompt: reencrypt(current, next, job.encryptedPrompt, `job:${job.id}:prompt`),
        encryptedOutputSchema: job.encryptedOutputSchema
          ? reencrypt(current, next, job.encryptedOutputSchema, `job:${job.id}:output-schema`)
          : null,
        encryptedResult: job.encryptedResult
          ? reencrypt(current, next, job.encryptedResult, `job:${job.id}:result`)
          : null
      }).where("id", "=", job.id).execute();
      jobCount += 1;
    }

    const events = await trx.selectFrom("jobEvents").select(["jobId", "sequence", "encryptedData"]).execute();
    let eventCount = 0;
    for (const event of events) {
      await trx.updateTable("jobEvents").set({
        encryptedData: reencrypt(current, next, event.encryptedData, `job:${event.jobId}:event:${event.sequence}`)
      }).where("jobId", "=", event.jobId).where("sequence", "=", event.sequence).execute();
      eventCount += 1;
    }

    await trx.updateTable("gatewayMetadata").set({
      encryptionSentinel: next.encrypt(ENCRYPTION_SENTINEL_PLAINTEXT, ENCRYPTION_SENTINEL_CONTEXT)
    }).where("id", "=", 1).execute();

    return { jobs: jobCount, events: eventCount };
  });
}

function reencrypt(current: SecretBox, next: SecretBox, payload: string, context: string): string {
  return next.encrypt(current.decrypt(payload, context), context);
}
