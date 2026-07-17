import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { type Generated, Kysely, SqliteDialect } from "kysely";

export type ConversationRow = {
  id: string;
  ownerId: string;
  repositoryId: string | null;
  backendThreadId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobKind = "coding.turn" | "inference.turn";

export type JobRow = {
  id: string;
  ownerId: string;
  conversationId: string;
  repositoryId: string | null;
  kind: JobKind;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  encryptedPrompt: string;
  encryptedOutputSchema: string | null;
  encryptedResult: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorRetryable: number;
  cancelRequested: number;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type JobEventRow = {
  id: Generated<number>;
  jobId: string;
  sequence: number;
  type: string;
  encryptedData: string;
  createdAt: string;
};

export type IdempotencyRow = {
  ownerId: string;
  key: string;
  requestHash: string;
  jobId: string;
  createdAt: string;
};

export type JobAttemptRow = {
  id: Generated<number>;
  jobId: string;
  attempt: number;
  status: "running" | "completed" | "failed" | "cancelled";
  errorCode: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type GatewayDatabase = {
  conversations: ConversationRow;
  jobs: JobRow;
  jobEvents: JobEventRow;
  idempotencyRecords: IdempotencyRow;
  jobAttempts: JobAttemptRow;
};

export type DatabaseHandle = {
  db: Kysely<GatewayDatabase>;
  close: () => Promise<void>;
};

function migrateV2ToV3(sqlite: Database.Database): void {
  const foreignKeys = sqlite.pragma("foreign_keys", { simple: true }) as number;
  sqlite.pragma("foreign_keys = OFF");
  // legacy_alter_table keeps RENAME TO from rewriting the FK references in
  // child tables (jobEvents/jobAttempts/idempotencyRecords) to point at the
  // temporary *_v2 name. With it ON, those references keep naming "jobs", so
  // recreating "jobs" under the same name leaves them valid.
  sqlite.pragma("legacy_alter_table = ON");
  try {
    sqlite.exec(`
      BEGIN;

      ALTER TABLE jobs RENAME TO jobs_v2;
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        conversationId TEXT NOT NULL REFERENCES conversations(id),
        repositoryId TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('coding.turn', 'inference.turn')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        encryptedPrompt TEXT NOT NULL,
        encryptedOutputSchema TEXT,
        encryptedResult TEXT,
        errorCode TEXT,
        errorMessage TEXT,
        errorRetryable INTEGER NOT NULL DEFAULT 0,
        cancelRequested INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        startedAt TEXT,
        completedAt TEXT,
        CHECK ((kind = 'inference.turn') = (repositoryId IS NULL))
      );
      INSERT INTO jobs SELECT
        id, ownerId, conversationId, repositoryId, kind, status, encryptedPrompt,
        encryptedOutputSchema, encryptedResult, errorCode, errorMessage, errorRetryable,
        cancelRequested, attempts, createdAt, startedAt, completedAt
      FROM jobs_v2;
      DROP TABLE jobs_v2;
      CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, createdAt);
      CREATE INDEX IF NOT EXISTS jobs_owner_idx ON jobs(ownerId, createdAt DESC);

      ALTER TABLE conversations RENAME TO conversations_v2;
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        repositoryId TEXT,
        backendThreadId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO conversations SELECT
        id, ownerId, repositoryId, backendThreadId, createdAt, updatedAt
      FROM conversations_v2;
      DROP TABLE conversations_v2;
      CREATE INDEX IF NOT EXISTS conversations_owner_idx
        ON conversations(ownerId, createdAt DESC);

      PRAGMA user_version = 3;
      COMMIT;
    `);
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  } finally {
    sqlite.pragma("legacy_alter_table = OFF");
    if (foreignKeys) sqlite.pragma("foreign_keys = ON");
  }
  const violations = sqlite.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("V2->V3 migration left dangling foreign keys");
  }
}

export function openDatabase(path: string): DatabaseHandle {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const sqlite = new Database(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const schemaVersion = sqlite.pragma("user_version", { simple: true }) as number;
  if (schemaVersion > 3) {
    sqlite.close();
    throw new Error(`Gateway database schema ${schemaVersion} is newer than this binary supports`);
  }
  if (schemaVersion === 0) {
    const existingTables = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all() as Array<{ name: string }>;
    if (existingTables.length > 0) {
      sqlite.close();
      throw new Error("Refusing to open an unversioned or V1 database as a V3 database");
    }
    sqlite.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      ownerId TEXT NOT NULL,
      repositoryId TEXT,
      backendThreadId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversations_owner_idx
      ON conversations(ownerId, createdAt DESC);

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      ownerId TEXT NOT NULL,
      conversationId TEXT NOT NULL REFERENCES conversations(id),
      repositoryId TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('coding.turn', 'inference.turn')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      encryptedPrompt TEXT NOT NULL,
      encryptedOutputSchema TEXT,
      encryptedResult TEXT,
      errorCode TEXT,
      errorMessage TEXT,
      errorRetryable INTEGER NOT NULL DEFAULT 0,
      cancelRequested INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      startedAt TEXT,
      completedAt TEXT,
      CHECK ((kind = 'inference.turn') = (repositoryId IS NULL))
    );
    CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, createdAt);
    CREATE INDEX IF NOT EXISTS jobs_owner_idx ON jobs(ownerId, createdAt DESC);

    CREATE TABLE IF NOT EXISTS jobEvents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      encryptedData TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      UNIQUE(jobId, sequence)
    );

    CREATE TABLE IF NOT EXISTS idempotencyRecords (
      ownerId TEXT NOT NULL,
      key TEXT NOT NULL,
      requestHash TEXT NOT NULL,
      jobId TEXT NOT NULL REFERENCES jobs(id),
      createdAt TEXT NOT NULL,
      PRIMARY KEY(ownerId, key)
    );

    CREATE TABLE IF NOT EXISTS jobAttempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      errorCode TEXT,
      startedAt TEXT NOT NULL,
      completedAt TEXT,
      UNIQUE(jobId, attempt)
    );

    PRAGMA user_version = 3;
  `);
  }
  if (schemaVersion === 1) {
    sqlite.exec(`
      ALTER TABLE jobs ADD COLUMN encryptedOutputSchema TEXT;
      PRAGMA user_version = 2;
    `);
  }
  if (schemaVersion === 1 || schemaVersion === 2) {
    // V2->V3: relax repositoryId to nullable and widen the kind CHECK to
    // admit 'inference.turn'. SQLite cannot ALTER a NOT NULL/CHECK away, so
    // the jobs and conversations tables are rebuilt. foreign_keys is toggled
    // off for the swap because the child tables (jobEvents, jobAttempts,
    // idempotencyRecords) reference jobs(id) and would otherwise cascade or
    // block the drop; the rename preserves those ids so the references stay
    // valid. Runs inside a single transaction.
    migrateV2ToV3(sqlite);
  }
  const db = new Kysely<GatewayDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
  return {
    db,
    close: async () => {
      await db.destroy();
    }
  };
}
