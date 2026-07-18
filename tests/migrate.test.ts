import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "../src/infrastructure/database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexgw-migrate-"));
  directories.push(directory);
  return join(directory, "gateway.sqlite");
}

// Seed a V2 database with a completed coding job, its conversation, events,
// attempts, and idempotency record, exactly as the V2 schema produced them.
function seedV2(path: string): void {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, repositoryId TEXT NOT NULL,
      backendThreadId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL,
      conversationId TEXT NOT NULL REFERENCES conversations(id),
      repositoryId TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'coding.turn'),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      encryptedPrompt TEXT NOT NULL, encryptedOutputSchema TEXT, encryptedResult TEXT,
      errorCode TEXT, errorMessage TEXT, errorRetryable INTEGER NOT NULL DEFAULT 0,
      cancelRequested INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL, startedAt TEXT, completedAt TEXT
    );
    CREATE TABLE jobEvents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, type TEXT NOT NULL, encryptedData TEXT NOT NULL,
      createdAt TEXT NOT NULL, UNIQUE(jobId, sequence)
    );
    CREATE TABLE idempotencyRecords (
      ownerId TEXT NOT NULL, key TEXT NOT NULL, requestHash TEXT NOT NULL,
      jobId TEXT NOT NULL REFERENCES jobs(id), createdAt TEXT NOT NULL,
      PRIMARY KEY(ownerId, key)
    );
    CREATE TABLE jobAttempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      errorCode TEXT, startedAt TEXT NOT NULL, completedAt TEXT, UNIQUE(jobId, attempt)
    );
    INSERT INTO conversations VALUES ('cnv1', 'owner', 'gateway', 'thread', 't', 't');
    INSERT INTO jobs (id, ownerId, conversationId, repositoryId, kind, status, encryptedPrompt, createdAt, completedAt)
      VALUES ('job1', 'owner', 'cnv1', 'gateway', 'coding.turn', 'completed', 'enc', 't', 't');
    INSERT INTO jobEvents (jobId, sequence, type, encryptedData, createdAt) VALUES ('job1', 1, 'job.completed', 'enc', 't');
    INSERT INTO idempotencyRecords VALUES ('owner', 'key1', 'hash', 'job1', 't');
    INSERT INTO jobAttempts (jobId, attempt, status, startedAt, completedAt) VALUES ('job1', 1, 'completed', 't', 't');
    PRAGMA user_version = 2;
  `);
  sqlite.close();
}

// Seed a V1 database: the jobs table predates encryptedOutputSchema, so the
// open path must chain V1->V2 (ADD COLUMN) then V2->V3 (rebuild).
function seedV1(path: string): void {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, repositoryId TEXT NOT NULL,
      backendThreadId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL,
      conversationId TEXT NOT NULL REFERENCES conversations(id),
      repositoryId TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'coding.turn'),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      encryptedPrompt TEXT NOT NULL, encryptedResult TEXT,
      errorCode TEXT, errorMessage TEXT, errorRetryable INTEGER NOT NULL DEFAULT 0,
      cancelRequested INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL, startedAt TEXT, completedAt TEXT
    );
    CREATE TABLE jobEvents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, type TEXT NOT NULL, encryptedData TEXT NOT NULL,
      createdAt TEXT NOT NULL, UNIQUE(jobId, sequence)
    );
    CREATE TABLE idempotencyRecords (
      ownerId TEXT NOT NULL, key TEXT NOT NULL, requestHash TEXT NOT NULL,
      jobId TEXT NOT NULL REFERENCES jobs(id), createdAt TEXT NOT NULL,
      PRIMARY KEY(ownerId, key)
    );
    CREATE TABLE jobAttempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      errorCode TEXT, startedAt TEXT NOT NULL, completedAt TEXT, UNIQUE(jobId, attempt)
    );
    INSERT INTO conversations VALUES ('cnv1', 'owner', 'gateway', 'thread', 't', 't');
    INSERT INTO jobs (id, ownerId, conversationId, repositoryId, kind, status, encryptedPrompt, createdAt, completedAt)
      VALUES ('job1', 'owner', 'cnv1', 'gateway', 'coding.turn', 'completed', 'enc', 't', 't');
    PRAGMA user_version = 1;
  `);
  sqlite.close();
}

// Seed a V3 database: the inference-era schema (nullable repositoryId, both
// kinds, paired CHECK) but WITHOUT the jobs_completed_idx that V4 adds. This
// is the pre-existing-live-DB case that the V3->V4 index migration must fix.
function seedV3(path: string): void {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, repositoryId TEXT,
      backendThreadId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL,
      conversationId TEXT NOT NULL REFERENCES conversations(id),
      repositoryId TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('coding.turn', 'inference.turn')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      encryptedPrompt TEXT NOT NULL, encryptedOutputSchema TEXT, encryptedResult TEXT,
      errorCode TEXT, errorMessage TEXT, errorRetryable INTEGER NOT NULL DEFAULT 0,
      cancelRequested INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL, startedAt TEXT, completedAt TEXT,
      CHECK ((kind = 'inference.turn') = (repositoryId IS NULL))
    );
    CREATE INDEX jobs_queue_idx ON jobs(status, createdAt);
    CREATE INDEX jobs_owner_idx ON jobs(ownerId, createdAt DESC);
    INSERT INTO conversations VALUES ('cnv1', 'owner', 'gateway', 'thread', 't', 't');
    INSERT INTO jobs (id, ownerId, conversationId, repositoryId, kind, status, encryptedPrompt, createdAt, completedAt)
      VALUES ('job1', 'owner', 'cnv1', 'gateway', 'coding.turn', 'completed', 'enc', 't', 't');
    PRAGMA user_version = 3;
  `);
  sqlite.close();
}

describe("V2 to V3 migration", () => {
  it("adds the metrics index when upgrading a pre-existing V3 database", async () => {
    const path = tempDatabasePath();
    seedV3(path);
    // Before the upgrade the percentile query cannot use an index.
    const before = new Database(path);
    const beforePlan = (before.prepare(
      "EXPLAIN QUERY PLAN SELECT completedAt FROM jobs WHERE status = 'completed' AND completedAt >= '2000-01-01'"
    ).all() as Array<{ detail: string }>).map((row) => row.detail).join(" ");
    before.close();
    expect(beforePlan).not.toContain("jobs_completed_idx");

    const handle = openDatabase(path);
    const raw = new Database(path);
    try {
      expect(raw.pragma("user_version", { simple: true })).toBe(4);
      // The existing row is untouched (index migration is additive).
      expect(raw.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
      const plan = raw.prepare(
        "EXPLAIN QUERY PLAN SELECT completedAt FROM jobs WHERE status = 'completed' AND completedAt >= '2000-01-01'"
      ).all() as Array<{ detail: string }>;
      expect(plan.some((row) => row.detail.includes("jobs_completed_idx"))).toBe(true);
    } finally {
      raw.close();
      await handle.close();
    }
  });

  it("preserves existing rows and relaxes the schema for inference", async () => {
    const path = tempDatabasePath();
    seedV2(path);

    const handle = openDatabase(path);
    const raw = new Database(path);
    try {
      expect(raw.pragma("user_version", { simple: true })).toBe(4);
      // Existing coding job and all of its children survived the table rebuild.
      expect(raw.prepare("SELECT repositoryId, kind FROM jobs WHERE id = 'job1'").get())
        .toEqual({ repositoryId: "gateway", kind: "coding.turn" });
      expect(raw.prepare("SELECT COUNT(*) AS n FROM jobEvents WHERE jobId = 'job1'").get()).toEqual({ n: 1 });
      expect(raw.prepare("SELECT COUNT(*) AS n FROM jobAttempts WHERE jobId = 'job1'").get()).toEqual({ n: 1 });
      expect(raw.prepare("SELECT jobId FROM idempotencyRecords WHERE key = 'key1'").get()).toEqual({ jobId: "job1" });
      // No dangling foreign keys after the rebuild.
      expect((raw.pragma("foreign_key_check") as unknown[]).length).toBe(0);
      // The V3->V4 metrics index is present, and the percentile window query uses it.
      const plan = raw.prepare(
        "EXPLAIN QUERY PLAN SELECT completedAt FROM jobs WHERE status = 'completed' AND completedAt >= '2000-01-01'"
      ).all() as Array<{ detail: string }>;
      expect(plan.some((row) => row.detail.includes("jobs_completed_idx"))).toBe(true);
      // The relaxed schema now admits a null-repository inference job.
      raw.pragma("foreign_keys = ON");
      raw.prepare(
        "INSERT INTO jobs (id, ownerId, conversationId, repositoryId, kind, status, encryptedPrompt, createdAt) " +
        "VALUES ('job2', 'owner', 'cnv1', NULL, 'inference.turn', 'queued', 'enc', 't')"
      ).run();
      expect(raw.prepare("SELECT repositoryId FROM jobs WHERE id = 'job2'").get()).toEqual({ repositoryId: null });
      // The paired CHECK still rejects an inconsistent row (inference with a repo).
      expect(() => raw.prepare(
        "INSERT INTO jobs (id, ownerId, conversationId, repositoryId, kind, status, encryptedPrompt, createdAt) " +
        "VALUES ('job3', 'owner', 'cnv1', 'gateway', 'inference.turn', 'queued', 'enc', 't')"
      ).run()).toThrow();
    } finally {
      raw.close();
      await handle.close();
    }
  });

  it("chains a V1 database through V2 to V3", async () => {
    const path = tempDatabasePath();
    seedV1(path);

    const handle = openDatabase(path);
    const raw = new Database(path);
    try {
      expect(raw.pragma("user_version", { simple: true })).toBe(4);
      // V1->V2 added the column; V2->V3 kept the row and relaxed the schema.
      expect(raw.prepare("SELECT repositoryId, kind, encryptedOutputSchema FROM jobs WHERE id = 'job1'").get())
        .toEqual({ repositoryId: "gateway", kind: "coding.turn", encryptedOutputSchema: null });
      expect((raw.pragma("foreign_key_check") as unknown[]).length).toBe(0);
      raw.pragma("foreign_keys = ON");
      raw.prepare(
        "INSERT INTO jobs (id, ownerId, conversationId, repositoryId, kind, status, encryptedPrompt, createdAt) " +
        "VALUES ('job2', 'owner', 'cnv1', NULL, 'inference.turn', 'queued', 'enc', 't')"
      ).run();
      expect(raw.prepare("SELECT repositoryId FROM jobs WHERE id = 'job2'").get()).toEqual({ repositoryId: null });
    } finally {
      raw.close();
      await handle.close();
    }
  });

  it("is idempotent when reopening an already-migrated database", async () => {
    const path = tempDatabasePath();
    seedV2(path);
    await openDatabase(path).close();
    const handle = openDatabase(path);
    const raw = new Database(path);
    try {
      expect(raw.pragma("user_version", { simple: true })).toBe(4);
      expect(raw.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
    } finally {
      raw.close();
      await handle.close();
    }
  });
});
