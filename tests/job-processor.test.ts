import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseHandle } from "../src/infrastructure/database.js";
import { openDatabase } from "../src/infrastructure/database.js";
import { SecretBox } from "../src/infrastructure/crypto.js";
import { GatewayStore } from "../src/application/store.js";
import { JobProcessor } from "../src/application/job-processor.js";
import type { CodingRunner } from "../src/adapters/codex/runner.js";

const databases: DatabaseHandle[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const idleRunner: CodingRunner = {
  async run() {
    return { backendThreadId: "thread", result: "ok" };
  }
};

describe("JobProcessor", () => {
  it("sweeps orphaned inference workspaces on start", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexgw-sweep-"));
    directories.push(root);
    // Simulate a workspace left behind by a crash, plus an unrelated dir.
    const orphan = join(root, "inference-abc123");
    mkdirSync(orphan);
    writeFileSync(join(orphan, "leftover.txt"), "stale");
    const unrelated = join(root, "keep-me");
    mkdirSync(unrelated);

    const database = openDatabase(":memory:");
    databases.push(database);
    const store = new GatewayStore(database.db, new SecretBox(Buffer.alloc(32, 3)));
    const processor = new JobProcessor(store, idleRunner, new Map(), 1, root);
    await processor.start();
    await processor.stop();

    expect(existsSync(orphan)).toBe(false);
    // Only inference-* dirs are swept; anything else is left alone.
    expect(existsSync(unrelated)).toBe(true);
  });

  it("does not fail when the inference root does not yet exist", async () => {
    const root = join(tmpdir(), `codexgw-missing-${process.pid}-${Date.now()}`);
    const database = openDatabase(":memory:");
    databases.push(database);
    const store = new GatewayStore(database.db, new SecretBox(Buffer.alloc(32, 3)));
    const processor = new JobProcessor(store, idleRunner, new Map(), 1, root);
    await expect(processor.start()).resolves.toBeUndefined();
    await processor.stop();
  });
});
