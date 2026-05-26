import type { TaskControlHandle } from "../provider/task-runner.js";

type ActiveTaskSession = {
  taskId: string;
  tokenId: string;
  repo: string;
  mode: string;
  handle: TaskControlHandle | null;
};

export type ActiveTaskRegistration = {
  attachHandle: (handle: TaskControlHandle) => void;
  complete: () => void;
};

export class ActiveTaskSessions {
  private readonly sessions = new Map<string, ActiveTaskSession>();

  register(params: { taskId: string; tokenId: string; repo: string; mode: string }): ActiveTaskRegistration {
    const session: ActiveTaskSession = {
      ...params,
      handle: null
    };
    this.sessions.set(params.taskId, session);

    return {
      attachHandle: (handle) => {
        if (this.sessions.get(params.taskId) === session) {
          session.handle = handle;
        }
      },
      complete: () => {
        if (this.sessions.get(params.taskId) === session) {
          this.sessions.delete(params.taskId);
        }
      }
    };
  }

  hasActive(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  async interrupt(taskId: string): Promise<boolean> {
    const handle = this.sessions.get(taskId)?.handle;
    if (!handle) {
      return false;
    }
    await handle.interrupt();
    return true;
  }

  async steer(taskId: string, message: string): Promise<boolean> {
    const handle = this.sessions.get(taskId)?.handle;
    if (!handle) {
      return false;
    }
    await handle.steer(message);
    return true;
  }
}
