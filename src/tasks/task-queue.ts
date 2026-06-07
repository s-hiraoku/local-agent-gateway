import type { TaskMode } from "../policy/modes.js";

type TaskJob = () => Promise<void>;

export type InitialTaskStatus = "queued" | "pending";

export class TaskQueue {
  private readonly activeWriteRepos = new Set<string>();
  private readonly writeQueues = new Map<string, TaskJob[]>();
  private activeReadTasks = 0;
  private readonly readQueue: TaskJob[] = [];

  constructor(private readonly maxParallelReadTasks = 4) {}

  initialStatus(repoId: string, mode: TaskMode): InitialTaskStatus {
    if (mode === "workspace-write") {
      const queue = this.writeQueues.get(repoId);
      return this.activeWriteRepos.has(repoId) || (queue?.length ?? 0) > 0 ? "queued" : "pending";
    }

    return this.activeReadTasks >= this.maxParallelReadTasks || this.readQueue.length > 0 ? "queued" : "pending";
  }

  enqueue(params: { repoId: string; mode: TaskMode; run: TaskJob }): void {
    if (params.mode !== "workspace-write") {
      this.enqueueRead(params.run);
      return;
    }

    if (!this.activeWriteRepos.has(params.repoId)) {
      this.activeWriteRepos.add(params.repoId);
      queueMicrotask(() => {
        void this.runWriteJob(params.repoId, params.run);
      });
      return;
    }

    const queue = this.writeQueues.get(params.repoId) ?? [];
    queue.push(params.run);
    this.writeQueues.set(params.repoId, queue);
  }

  private enqueueRead(job: TaskJob): void {
    if (this.activeReadTasks < this.maxParallelReadTasks) {
      this.activeReadTasks += 1;
      queueMicrotask(() => {
        void this.runReadJob(job);
      });
      return;
    }

    this.readQueue.push(job);
  }

  private async runReadJob(job: TaskJob): Promise<void> {
    try {
      await job();
    } finally {
      const next = this.readQueue.shift();
      if (next) {
        queueMicrotask(() => {
          void this.runReadJob(next);
        });
      } else {
        this.activeReadTasks -= 1;
      }
    }
  }

  private async runWriteJob(repoId: string, job: TaskJob): Promise<void> {
    try {
      await job();
    } finally {
      const queue = this.writeQueues.get(repoId);
      const next = queue?.shift();
      if (queue && queue.length === 0) {
        this.writeQueues.delete(repoId);
      }

      if (next) {
        queueMicrotask(() => {
          void this.runWriteJob(repoId, next);
        });
      } else {
        this.activeWriteRepos.delete(repoId);
      }
    }
  }
}
