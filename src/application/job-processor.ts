import { GatewayError, normalizeError } from "../domain/errors.js";
import type { RepositoryTarget } from "../infrastructure/config.js";
import type { JobRow } from "../infrastructure/database.js";
import type { CodingRunner } from "../adapters/codex/runner.js";
import { GatewayStore } from "./store.js";

export class JobProcessor {
  private readonly active = new Map<string, AbortController>();
  private readonly activeRuns = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private pumping = false;
  private stopping = false;
  private failure: Error | undefined;

  constructor(
    private readonly store: GatewayStore,
    private readonly runner: CodingRunner,
    private readonly repositories: ReadonlyMap<string, RepositoryTarget>,
    private readonly maxConcurrent: number
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    await this.store.recoverInterruptedJobs();
    this.timer = setInterval(() => this.schedulePump(), 100);
    this.timer.unref();
    await this.pump();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) {
      controller.abort(new DOMException("Gateway is shutting down", "AbortError"));
    }
    await Promise.race([
      Promise.allSettled(this.activeRuns),
      new Promise((resolve) => setTimeout(resolve, 30_000))
    ]);
  }

  wake(): void {
    if (this.stopping) return;
    this.schedulePump();
  }

  isReady(): boolean {
    return !this.stopping && !this.failure;
  }

  async cancel(ownerId: string, jobId: string): Promise<void> {
    const status = await this.store.requestCancellation(ownerId, jobId);
    if (status === "running") {
      this.active.get(jobId)?.abort(new DOMException("Job was cancelled", "AbortError"));
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    try {
      while (this.active.size < this.maxConcurrent) {
        const job = await this.store.claimNextJob();
        if (!job) break;
        const controller = new AbortController();
        this.active.set(job.id, controller);
        const run = this.run(job, controller).catch((error: unknown) => {
          this.failure = error instanceof Error ? error : new Error("Job processor failed");
        }).finally(() => {
          this.active.delete(job.id);
          this.activeRuns.delete(run);
          this.wake();
        });
        this.activeRuns.add(run);
      }
    } finally {
      this.pumping = false;
    }
  }

  private schedulePump(): void {
    void this.pump().catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error("Job processor failed");
    });
  }

  private async run(job: JobRow, controller: AbortController): Promise<void> {
    const repository = this.repositories.get(job.repositoryId);
    if (!repository) {
      await this.store.failJob(job.id, "FORBIDDEN", "Repository is no longer available", false);
      return;
    }
    try {
      const result = await this.runner.run({
        repositoryPath: repository.path,
        backendThreadId: await this.store.backendThreadId(job.conversationId),
        prompt: this.store.decryptPrompt(job),
        signal: controller.signal,
        onEvent: async (event) => this.store.appendEvent(job.id, event.type, event.data)
      });
      if (controller.signal.aborted) {
        await this.store.markCancelled(job.id);
        return;
      }
      await this.store.updateBackendThread(job.conversationId, result.backendThreadId);
      await this.store.completeJob(job.id, result.result);
    } catch (error) {
      if (controller.signal.aborted) {
        await this.store.markCancelled(job.id);
        return;
      }
      const normalized = normalizeError(error);
      await this.store.failJob(job.id, normalized.code, normalized.message, normalized.retryable);
    }
  }
}

export function requireRepository(
  repositories: ReadonlyMap<string, RepositoryTarget>,
  repositoryId: string
): RepositoryTarget {
  const repository = repositories.get(repositoryId);
  if (!repository) throw new GatewayError("NOT_FOUND", "Repository not found", 404);
  return repository;
}
