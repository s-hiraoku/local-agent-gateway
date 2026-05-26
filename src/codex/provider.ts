import type { TaskProviderDescriptor } from "../provider/task-provider.js";

export const CODEX_PROVIDER_DESCRIPTOR = {
  id: "codex",
  label: "Codex",
  capabilities: {
    readOnly: true,
    workspaceWrite: true,
    streamEvents: true,
    diffArtifacts: true,
    accountAuth: true,
    cancel: true,
    steer: true,
    models: false
  }
} as const satisfies TaskProviderDescriptor;
