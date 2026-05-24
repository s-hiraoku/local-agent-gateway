import type { TaskEventRecord } from "../db/schema.js";

type TaskEventListener = (event: TaskEventRecord) => void;

export class LiveTaskEvents {
  private readonly listeners = new Map<string, Set<TaskEventListener>>();

  subscribe(taskId: string, listener: TaskEventListener): () => void {
    const listeners = this.listeners.get(taskId) ?? new Set<TaskEventListener>();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(taskId);
      }
    };
  }

  publish(event: TaskEventRecord): void {
    const listeners = this.listeners.get(event.taskId);
    if (!listeners) {
      return;
    }

    for (const listener of [...listeners]) {
      listener(event);
    }
  }
}
