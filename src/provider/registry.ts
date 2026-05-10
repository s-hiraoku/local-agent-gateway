import { CODEX_PROVIDER_DESCRIPTOR } from "../codex/provider.js";
import type { TaskProviderDescriptor } from "./task-provider.js";

export const TASK_PROVIDER_DESCRIPTORS = [CODEX_PROVIDER_DESCRIPTOR] as const satisfies readonly TaskProviderDescriptor[];

export function listTaskProviderDescriptors(): TaskProviderDescriptor[] {
  return TASK_PROVIDER_DESCRIPTORS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    capabilities: { ...provider.capabilities }
  }));
}
