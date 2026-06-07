import { CODEX_PROVIDER_DESCRIPTOR } from "../codex/provider.js";
import type { TaskProviderDescriptor } from "./task-provider.js";
import { ApiError } from "../utils/errors.js";

export const TASK_PROVIDER_DESCRIPTORS = [CODEX_PROVIDER_DESCRIPTOR] as const satisfies readonly TaskProviderDescriptor[];
export const DEFAULT_TASK_PROVIDER_ID = CODEX_PROVIDER_DESCRIPTOR.id;

export function listTaskProviderDescriptors(): TaskProviderDescriptor[] {
  return TASK_PROVIDER_DESCRIPTORS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    capabilities: { ...provider.capabilities }
  }));
}

export function taskProviderIds(): string[] {
  return TASK_PROVIDER_DESCRIPTORS.map((provider) => provider.id);
}

export function getTaskProviderDescriptor(providerId: string): TaskProviderDescriptor {
  const provider = TASK_PROVIDER_DESCRIPTORS.find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new ApiError("PROVIDER_NOT_ALLOWED");
  }
  return {
    id: provider.id,
    label: provider.label,
    capabilities: { ...provider.capabilities }
  };
}
