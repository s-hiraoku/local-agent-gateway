import { sql, type Kysely, type Transaction } from "kysely";
import { GatewayError } from "../domain/errors.js";
import type { JobStatus, PublicEvent, PublicJob } from "../domain/jobs.js";
import { newId } from "../domain/ids.js";
import type { GatewayDatabase, JobRow } from "../infrastructure/database.js";
import { SecretBox } from "../infrastructure/crypto.js";
import type { OutputSchema } from "../domain/structured-output.js";

type DatabaseExecutor = Kysely<GatewayDatabase> | Transaction<GatewayDatabase>;

export type SubmitTurnInput = {
  ownerId: string;
  conversationId: string;
  repositoryId: string;
  prompt: string;
  outputSchema?: OutputSchema;
  idempotencyKey: string;
  requestHash: string;
  maxQueuedJobs: number;
};

export type SubmitRunInput = Omit<SubmitTurnInput, "conversationId">;

type StoreLimits = {
  maxEventBytes: number;
  maxEventsPerJob: number;
  maxResultBytes: number;
};

const defaultLimits: StoreLimits = {
  maxEventBytes: 64 * 1024,
  maxEventsPerJob: 10_000,
  maxResultBytes: 1024 * 1024
};

export class GatewayStore {
  constructor(
    private readonly db: Kysely<GatewayDatabase>,
    private readonly secrets: SecretBox,
    private readonly limits: StoreLimits = defaultLimits
  ) {}

  async isReady(): Promise<boolean> {
    await sql`select 1`.execute(this.db);
    return true;
  }

  async recoverInterruptedJobs(): Promise<number> {
    const now = new Date().toISOString();
    return this.db.transaction().execute(async (trx) => {
      const cancellations = await trx.selectFrom("jobs").select("id")
        .where("status", "=", "running").where("cancelRequested", "=", 1).execute();
      for (const job of cancellations) await this.finalizeCancellation(trx, job.id, now);

      await trx.updateTable("jobAttempts").set({
        status: "failed",
        errorCode: "GATEWAY_RESTARTED",
        completedAt: now
      }).where("status", "=", "running").execute();
      const result = await trx.updateTable("jobs").set({ status: "queued", startedAt: null })
        .where("status", "=", "running").where("cancelRequested", "=", 0).executeTakeFirst();
      return Number(result.numUpdatedRows);
    });
  }

  async createConversation(ownerId: string, repositoryId: string): Promise<{ id: string; repositoryId: string; createdAt: string }> {
    const id = newId("cnv");
    const now = new Date().toISOString();
    await this.db.insertInto("conversations").values({
      id,
      ownerId,
      repositoryId,
      backendThreadId: null,
      createdAt: now,
      updatedAt: now
    }).execute();
    return { id, repositoryId, createdAt: now };
  }

  async getConversation(ownerId: string, id: string) {
    return this.db.selectFrom("conversations").selectAll().where("id", "=", id).where("ownerId", "=", ownerId).executeTakeFirst();
  }

  async submitTurn(input: SubmitTurnInput): Promise<{ job: PublicJob; replayed: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom("idempotencyRecords").selectAll()
        .where("ownerId", "=", input.ownerId).where("key", "=", input.idempotencyKey).executeTakeFirst();
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw new GatewayError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request", 409);
        }
        const row = await this.requireOwnedJob(input.ownerId, existing.jobId, trx);
        return { job: this.toPublicJob(row), replayed: true };
      }

      const conversation = await trx.selectFrom("conversations").selectAll()
        .where("id", "=", input.conversationId).where("ownerId", "=", input.ownerId).executeTakeFirst();
      if (!conversation || conversation.repositoryId !== input.repositoryId) {
        throw new GatewayError("NOT_FOUND", "Conversation not found", 404);
      }
      const queueCount = await trx.selectFrom("jobs").select((expression) => expression.fn.countAll<number>().as("count"))
        .where("status", "in", ["queued", "running"]).executeTakeFirstOrThrow();
      if (Number(queueCount.count) >= input.maxQueuedJobs) {
        throw new GatewayError("QUEUE_FULL", "The coding queue is full", 429, true);
      }

      const id = newId("job");
      const now = new Date().toISOString();
      const row = this.newJob(input, input.conversationId, id, now);
      await trx.insertInto("jobs").values(row).execute();
      await trx.updateTable("conversations").set({ updatedAt: now })
        .where("id", "=", input.conversationId).execute();
      await trx.insertInto("idempotencyRecords").values({
        ownerId: input.ownerId,
        key: input.idempotencyKey,
        requestHash: input.requestHash,
        jobId: id,
        createdAt: now
      }).execute();
      await this.appendEventWith(trx, id, "job.queued", { status: "queued" });
      return { job: this.toPublicJob(row), replayed: false };
    });
  }

  async submitRun(input: SubmitRunInput): Promise<{ job: PublicJob; replayed: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom("idempotencyRecords").selectAll()
        .where("ownerId", "=", input.ownerId).where("key", "=", input.idempotencyKey).executeTakeFirst();
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw new GatewayError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request", 409);
        }
        return { job: this.toPublicJob(await this.requireOwnedJob(input.ownerId, existing.jobId, trx)), replayed: true };
      }

      await this.requireQueueCapacity(trx, input.maxQueuedJobs);
      const conversationId = newId("cnv");
      const jobId = newId("job");
      const now = new Date().toISOString();
      await trx.insertInto("conversations").values({
        id: conversationId,
        ownerId: input.ownerId,
        repositoryId: input.repositoryId,
        backendThreadId: null,
        createdAt: now,
        updatedAt: now
      }).execute();
      const row = this.newJob(input, conversationId, jobId, now);
      await trx.insertInto("jobs").values(row).execute();
      await trx.insertInto("idempotencyRecords").values({
        ownerId: input.ownerId,
        key: input.idempotencyKey,
        requestHash: input.requestHash,
        jobId,
        createdAt: now
      }).execute();
      await this.appendEventWith(trx, jobId, "job.queued", { status: "queued" });
      return { job: this.toPublicJob(row), replayed: false };
    });
  }

  async getJob(ownerId: string, id: string): Promise<PublicJob> {
    return this.toPublicJob(await this.requireOwnedJob(ownerId, id, this.db));
  }

  async claimNextJob(): Promise<JobRow | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const candidate = await trx.selectFrom("jobs").selectAll()
        .where("status", "=", "queued").where("cancelRequested", "=", 0)
        .where("conversationId", "not in", trx.selectFrom("jobs as activeJobs")
          .select("activeJobs.conversationId").where("activeJobs.status", "=", "running"))
        .orderBy("createdAt", "asc").executeTakeFirst();
      if (!candidate) return undefined;
      const now = new Date().toISOString();
      const result = await trx.updateTable("jobs").set({
        status: "running",
        startedAt: now,
        attempts: candidate.attempts + 1
      }).where("id", "=", candidate.id).where("status", "=", "queued").executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) return undefined;
      await trx.insertInto("jobAttempts").values({
        jobId: candidate.id,
        attempt: candidate.attempts + 1,
        status: "running",
        errorCode: null,
        startedAt: now,
        completedAt: null
      }).execute();
      await this.appendEventWith(trx, candidate.id, "job.started", { status: "running" });
      return { ...candidate, status: "running", startedAt: now, attempts: candidate.attempts + 1 };
    });
  }

  decryptPrompt(job: JobRow): string {
    return this.secrets.decrypt(job.encryptedPrompt, `job:${job.id}:prompt`);
  }

  decryptOutputSchema(job: JobRow): OutputSchema | undefined {
    if (!job.encryptedOutputSchema) return undefined;
    return JSON.parse(this.secrets.decrypt(job.encryptedOutputSchema, `job:${job.id}:output-schema`)) as OutputSchema;
  }

  async updateBackendThread(conversationId: string, backendThreadId: string): Promise<void> {
    await this.db.updateTable("conversations").set({ backendThreadId, updatedAt: new Date().toISOString() })
      .where("id", "=", conversationId).execute();
  }

  async backendThreadId(conversationId: string): Promise<string | null> {
    const row = await this.db.selectFrom("conversations").select("backendThreadId").where("id", "=", conversationId).executeTakeFirstOrThrow();
    return row.backendThreadId;
  }

  async appendEvent(jobId: string, type: string, data: unknown): Promise<void> {
    await this.db.transaction().execute((trx) => this.appendEventWith(trx, jobId, type, data));
  }

  async completeJob(jobId: string, result: string): Promise<void> {
    if (Buffer.byteLength(result) > this.limits.maxResultBytes) {
      throw new GatewayError("CODEX_EXECUTION_FAILED", "Codex result exceeded the configured size limit", 502, false);
    }
    const now = new Date().toISOString();
    await this.db.transaction().execute(async (trx) => {
      const updated = await trx.updateTable("jobs").set({
        status: "completed",
        encryptedResult: this.secrets.encrypt(result, `job:${jobId}:result`),
        completedAt: now
      }).where("id", "=", jobId).where("status", "=", "running").where("cancelRequested", "=", 0).executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        await this.finalizeCancellation(trx, jobId, now);
        return;
      }
      await trx.updateTable("jobAttempts").set({ status: "completed", completedAt: now })
        .where("jobId", "=", jobId).where("status", "=", "running").execute();
      await this.appendEventWith(trx, jobId, "job.completed", { status: "completed" });
    });
  }

  async failJob(jobId: string, code: string, message: string, retryable: boolean): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction().execute(async (trx) => {
      const updated = await trx.updateTable("jobs").set({
        status: "failed",
        errorCode: code,
        errorMessage: message,
        errorRetryable: retryable ? 1 : 0,
        completedAt: now
      }).where("id", "=", jobId).where("status", "=", "running").where("cancelRequested", "=", 0).executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        await this.finalizeCancellation(trx, jobId, now);
        return;
      }
      await trx.updateTable("jobAttempts").set({ status: "failed", errorCode: code, completedAt: now })
        .where("jobId", "=", jobId).where("status", "=", "running").execute();
      await this.appendEventWith(trx, jobId, "job.failed", { code, message, retryable });
    });
  }

  async requestCancellation(ownerId: string, jobId: string): Promise<JobStatus> {
    return this.db.transaction().execute(async (trx) => {
      const job = await this.requireOwnedJob(ownerId, jobId, trx);
      if (job.status === "queued") {
        await trx.updateTable("jobs").set({ status: "cancelled", cancelRequested: 1, completedAt: new Date().toISOString() })
          .where("id", "=", jobId).execute();
        await this.appendEventWith(trx, jobId, "job.cancelled", { status: "cancelled" });
        return "cancelled";
      }
      if (job.status === "running") {
        await trx.updateTable("jobs").set({ cancelRequested: 1 }).where("id", "=", jobId).execute();
        return "running";
      }
      throw new GatewayError("JOB_NOT_CANCELLABLE", "The job is already in a terminal state", 409);
    });
  }

  async markCancelled(jobId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.finalizeCancellation(trx, jobId, new Date().toISOString());
    });
  }

  async pruneExpired(cutoff: string): Promise<{ jobs: number; conversations: number }> {
    return this.db.transaction().execute(async (trx) => {
      // Terminal jobs older than the cutoff. completedAt is set on every
      // terminal transition; createdAt is a defensive fallback so a row can
      // never become unprunable.
      const expiredJobs = trx.selectFrom("jobs").select("id")
        .where("status", "in", ["completed", "failed", "cancelled"])
        .where((eb) => eb(sql<string>`coalesce("completedAt", "createdAt")`, "<", cutoff));
      // idempotencyRecords.jobId has no ON DELETE CASCADE, so it goes first.
      // Reusing an Idempotency-Key after its record is pruned re-executes
      // instead of replaying; past the retention window that is accepted.
      await trx.deleteFrom("idempotencyRecords").where("jobId", "in", expiredJobs).execute();
      const jobs = await trx.deleteFrom("jobs")
        .where("status", "in", ["completed", "failed", "cancelled"])
        .where((eb) => eb(sql<string>`coalesce("completedAt", "createdAt")`, "<", cutoff))
        .executeTakeFirst();
      const conversations = await trx.deleteFrom("conversations")
        .where("updatedAt", "<", cutoff)
        .where("id", "not in", trx.selectFrom("jobs").select("conversationId"))
        .executeTakeFirst();
      return {
        jobs: Number(jobs.numDeletedRows),
        conversations: Number(conversations.numDeletedRows)
      };
    });
  }

  async events(ownerId: string, jobId: string, after = 0): Promise<PublicEvent[]> {
    await this.requireOwnedJob(ownerId, jobId, this.db);
    const rows = await this.db.selectFrom("jobEvents").selectAll().where("jobId", "=", jobId)
      .where("sequence", ">", after).orderBy("sequence", "asc").limit(500).execute();
    return rows.map((row) => ({
      sequence: row.sequence,
      type: row.type,
      data: JSON.parse(this.secrets.decrypt(row.encryptedData, `job:${jobId}:event:${row.sequence}`)) as unknown,
      createdAt: row.createdAt
    }));
  }

  private async appendEventWith(executor: DatabaseExecutor, jobId: string, type: string, data: unknown): Promise<void> {
    const last = await executor.selectFrom("jobEvents").select((expression) => expression.fn.max("sequence").as("sequence"))
      .where("jobId", "=", jobId).executeTakeFirst();
    const sequence = Number(last?.sequence ?? 0) + 1;
    if (sequence > this.limits.maxEventsPerJob && !type.startsWith("job.")) {
      throw new GatewayError("CODEX_EXECUTION_FAILED", "Codex produced too many events", 502, false);
    }
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > this.limits.maxEventBytes) {
      throw new GatewayError("CODEX_EXECUTION_FAILED", "Codex event exceeded the configured size limit", 502, false);
    }
    await executor.insertInto("jobEvents").values({
      jobId,
      sequence,
      type,
      encryptedData: this.secrets.encrypt(serialized, `job:${jobId}:event:${sequence}`),
      createdAt: new Date().toISOString()
    }).execute();
  }

  private async finalizeCancellation(executor: DatabaseExecutor, jobId: string, completedAt: string): Promise<boolean> {
    const updated = await executor.updateTable("jobs").set({
      status: "cancelled",
      cancelRequested: 1,
      completedAt
    }).where("id", "=", jobId).where("status", "=", "running").executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) return false;
    await executor.updateTable("jobAttempts").set({ status: "cancelled", completedAt })
      .where("jobId", "=", jobId).where("status", "=", "running").execute();
    await this.appendEventWith(executor, jobId, "job.cancelled", { status: "cancelled" });
    return true;
  }

  private async requireOwnedJob(ownerId: string, id: string, executor: DatabaseExecutor): Promise<JobRow> {
    const row = await executor.selectFrom("jobs").selectAll().where("id", "=", id).where("ownerId", "=", ownerId).executeTakeFirst();
    if (!row) throw new GatewayError("NOT_FOUND", "Job not found", 404);
    return row;
  }

  private async requireQueueCapacity(executor: DatabaseExecutor, maxQueuedJobs: number): Promise<void> {
    const queueCount = await executor.selectFrom("jobs").select((expression) => expression.fn.countAll<number>().as("count"))
      .where("status", "in", ["queued", "running"]).executeTakeFirstOrThrow();
    if (Number(queueCount.count) >= maxQueuedJobs) {
      throw new GatewayError("QUEUE_FULL", "The coding queue is full", 429, true);
    }
  }

  private newJob(
    input: Pick<SubmitTurnInput, "ownerId" | "repositoryId" | "prompt" | "outputSchema">,
    conversationId: string,
    id: string,
    now: string
  ): JobRow {
    return {
      id,
      ownerId: input.ownerId,
      conversationId,
      repositoryId: input.repositoryId,
      kind: "coding.turn",
      status: "queued",
      encryptedPrompt: this.secrets.encrypt(input.prompt, `job:${id}:prompt`),
      encryptedOutputSchema: input.outputSchema
        ? this.secrets.encrypt(JSON.stringify(input.outputSchema), `job:${id}:output-schema`)
        : null,
      encryptedResult: null,
      errorCode: null,
      errorMessage: null,
      errorRetryable: 0,
      cancelRequested: 0,
      attempts: 0,
      createdAt: now,
      startedAt: null,
      completedAt: null
    };
  }

  private toPublicJob(row: JobRow): PublicJob {
    const result = row.encryptedResult ? this.secrets.decrypt(row.encryptedResult, `job:${row.id}:result`) : null;
    let structuredOutput: unknown | null = null;
    if (result !== null && row.encryptedOutputSchema !== null) {
      try {
        structuredOutput = JSON.parse(result) as unknown;
      } catch {
        structuredOutput = null;
      }
    }
    return {
      id: row.id,
      conversationId: row.conversationId,
      repositoryId: row.repositoryId,
      kind: row.kind,
      status: row.status,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      result,
      structuredOutput,
      error: row.errorCode && row.errorMessage ? {
        code: row.errorCode,
        message: row.errorMessage,
        retryable: row.errorRetryable === 1
      } : null
    };
  }
}
