import type { TaskRunner } from "./task-runner.js";

export type TaskProviderCapabilities = {
  readOnly: boolean;
  workspaceWrite: boolean;
  streamEvents: boolean;
  diffArtifacts: boolean;
  accountAuth: boolean;
  cancel: boolean;
  steer: boolean;
  models: boolean;
};

export type TaskProviderDescriptor = {
  id: string;
  label: string;
  capabilities: TaskProviderCapabilities;
};

export type TaskProviderAdapter = {
  descriptor: TaskProviderDescriptor;
  runner: TaskRunner;
};
