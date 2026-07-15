import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { type Generated, Kysely, SqliteDialect } from "kysely";

export type ConversationRow = {
  id: string;
  ownerId: string;
  repositoryId: string;
  backendThreadId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobRow = {
  id: string;
  ownerId: string;
  conversationId: string;
  repositoryId: string;
  kind: "coding.turn";
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
  if (schemaVersion > 2) {
    sqlite.close();
    throw new Error(`Gateway database schema ${schemaVersion} is newer than this binary supports`);
  }
  if (schemaVersion === 0) {
    const existingTables = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all() as Array<{ name: string }>;
    if (existingTables.length > 0) {
      sqlite.close();
      throw new Error("Refusing to open an unversioned or V1 database as a V2 database");
    }
    sqlite.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      ownerId TEXT NOT NULL,
      repositoryId TEXT NOT NULL,
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
      repositoryId TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'coding.turn'),
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
      completedAt TEXT
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

    PRAGMA user_version = 2;
  `);
  }
  if (schemaVersion === 1) {
    sqlite.exec(`
      ALTER TABLE jobs ADD COLUMN encryptedOutputSchema TEXT;
      PRAGMA user_version = 2;
    `);
  }
  const db = new Kysely<GatewayDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
  return {
    db,
    close: async () => {
      await db.destroy();
    }
  };
}
