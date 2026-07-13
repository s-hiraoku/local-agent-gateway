import "dotenv/config";
import { z } from "zod";
import { ApiError } from "../utils/errors.js";
import { TASK_MODES, type TaskMode } from "./modes.js";
import { ALLOWED_REPOS, getAllowedRepo } from "./repos.js";
import { DEFAULT_TASK_PROVIDER_ID, taskProviderIds } from "../provider/registry.js";

export type WorkspaceTarget = {
  id: string;
  repo: string;
  defaultMode: TaskMode;
  allowedModes: readonly TaskMode[];
  defaultProvider: string;
  allowedProviders: readonly string[];
};

const workspaceConfigSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  repo: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  defaultMode: z.enum(TASK_MODES).optional(),
  allowedModes: z.array(z.enum(TASK_MODES)).min(1).optional(),
  defaultProvider: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/).optional(),
  allowedProviders: z.array(z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/)).min(1).optional()
}).strict();

const workspaceConfigListSchema = z.array(workspaceConfigSchema).min(1);

function deriveWorkspaceFromRepo(repoId: string): WorkspaceTarget {
  const repo = getAllowedRepo(repoId);
  return {
    id: repo.id,
    repo: repo.id,
    defaultMode: repo.defaultMode,
    allowedModes: [...repo.allowedModes],
    defaultProvider: DEFAULT_TASK_PROVIDER_ID,
    allowedProviders: [DEFAULT_TASK_PROVIDER_ID]
  };
}

function loadWorkspaceTargets(): Record<string, WorkspaceTarget> {
  const raw = process.env.CODEXGW_WORKSPACES_JSON;
  if (!raw?.trim()) {
    return Object.fromEntries(Object.keys(ALLOWED_REPOS).map((repoId) => [repoId, deriveWorkspaceFromRepo(repoId)]));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("CODEXGW_WORKSPACES_JSON must be valid JSON", { cause: error });
  }

  const providerIds = taskProviderIds();
  const ids = new Set<string>();
  const workspaces = workspaceConfigListSchema.parse(parsed).map((workspace): WorkspaceTarget => {
    if (ids.has(workspace.id)) {
      throw new Error(`Duplicate workspace id in CODEXGW_WORKSPACES_JSON: ${workspace.id}`);
    }
    ids.add(workspace.id);

    const repo = getAllowedRepo(workspace.repo);
    const allowedModes = workspace.allowedModes ?? [...repo.allowedModes];
    const defaultMode = workspace.defaultMode ?? repo.defaultMode;
    if (!allowedModes.includes(defaultMode)) {
      throw new Error(`Workspace ${workspace.id} defaultMode must be included in allowedModes`);
    }
    for (const mode of allowedModes) {
      if (!repo.allowedModes.includes(mode)) {
        throw new Error(`Workspace ${workspace.id} mode ${mode} is not allowed by repo ${repo.id}`);
      }
    }

    const allowedProviders = workspace.allowedProviders ?? [DEFAULT_TASK_PROVIDER_ID];
    const defaultProvider = workspace.defaultProvider ?? DEFAULT_TASK_PROVIDER_ID;
    if (!allowedProviders.includes(defaultProvider)) {
      throw new Error(`Workspace ${workspace.id} defaultProvider must be included in allowedProviders`);
    }
    for (const provider of allowedProviders) {
      if (!providerIds.includes(provider)) {
        throw new Error(`Workspace ${workspace.id} provider ${provider} is not registered`);
      }
    }

    return {
      id: workspace.id,
      repo: repo.id,
      defaultMode,
      allowedModes,
      defaultProvider,
      allowedProviders
    };
  });

  return Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace]));
}

export const WORKSPACE_TARGETS = loadWorkspaceTargets();

export function getWorkspaceTarget(workspaceId: string): WorkspaceTarget {
  const workspace = WORKSPACE_TARGETS[workspaceId];
  if (!workspace) {
    throw new ApiError("WORKSPACE_NOT_ALLOWED");
  }
  return workspace;
}

export function listWorkspaceTargetsForScopes(scopes: readonly string[]): WorkspaceTarget[] {
  return Object.values(WORKSPACE_TARGETS).filter(
    (workspace) => scopes.includes(`workspace:${workspace.id}`) && scopes.includes(`repo:${workspace.repo}`)
  );
}

export function workspaceIds(): string[] {
  return Object.keys(WORKSPACE_TARGETS);
}
