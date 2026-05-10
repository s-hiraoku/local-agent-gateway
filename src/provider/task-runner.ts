import type { TaskMode } from "../policy/modes.js";
import type { NewTaskEvent } from "../tasks/task-events.js";

export type TaskRunResult = {
  provider: string;
  backend: string;
  threadId: string;
  summary: string;
  changedFiles: string[];
};

export interface TaskRunner {
  runTask(params: {
    prompt: string;
    cwd: string;
    threadId?: string;
    mode: TaskMode;
    onEvent?: (event: NewTaskEvent) => void | Promise<void>;
  }): Promise<TaskRunResult>;
}
