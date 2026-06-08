import type { FastifyRequest } from "fastify";
import { requireScopes } from "../auth/authorize.js";
import { hasScope } from "../auth/scopes.js";
import { getAllowedRepo } from "./repos.js";
import { assertTaskMode, type TaskMode } from "./modes.js";
import { getWorkspaceTarget } from "./workspaces.js";
import { ApiError } from "../utils/errors.js";
import {
  DEFAULT_TASK_PROVIDER_ID,
  getTaskProviderDescriptor
} from "../provider/registry.js";

export type TaskPolicyResult = {
  repo: ReturnType<typeof getAllowedRepo>;
  workspace: ReturnType<typeof getWorkspaceTarget> | null;
  mode: TaskMode;
  provider: ReturnType<typeof getTaskProviderDescriptor>;
};

export type TaskTargetRequest = {
  repoId?: string;
  workspaceId?: string;
};

export function authorizeTaskCreate(
  request: FastifyRequest,
  target: TaskTargetRequest,
  requestedMode?: string,
  requestedProvider?: string
): TaskPolicyResult {
  requireScopes(request, ["task:create"]);

  const workspace = target.workspaceId ? getWorkspaceTarget(target.workspaceId) : null;
  const repoId = workspace?.repo ?? target.repoId;
  if (!repoId) {
    throw new ApiError("VALIDATION_ERROR");
  }

  if (!request.auth || !hasScope(request.auth.scopes, `repo:${repoId}`)) {
    throw new ApiError("FORBIDDEN");
  }
  if (workspace && !hasScope(request.auth.scopes, `workspace:${workspace.id}`)) {
    throw new ApiError("FORBIDDEN");
  }

  const repo = getAllowedRepo(repoId);
  const mode = requestedMode ? assertTaskMode(requestedMode) : (workspace?.defaultMode ?? repo.defaultMode);
  const provider = getTaskProviderDescriptor(requestedProvider ?? workspace?.defaultProvider ?? DEFAULT_TASK_PROVIDER_ID);

  if (!repo.allowedModes.includes(mode)) {
    throw new ApiError("MODE_NOT_ALLOWED");
  }
  if (workspace && !workspace.allowedModes.includes(mode)) {
    throw new ApiError("MODE_NOT_ALLOWED");
  }
  if (workspace && !workspace.allowedProviders.includes(provider.id)) {
    throw new ApiError("PROVIDER_NOT_ALLOWED");
  }
  if (mode === "read-only" && !provider.capabilities.readOnly) {
    throw new ApiError("MODE_NOT_ALLOWED");
  }
  if (mode === "workspace-write" && !provider.capabilities.workspaceWrite) {
    throw new ApiError("MODE_NOT_ALLOWED");
  }

  requireScopes(request, [`mode:${mode}`]);
  if (provider.id !== DEFAULT_TASK_PROVIDER_ID) {
    requireScopes(request, [`provider:${provider.id}`]);
  }

  return { repo, workspace, mode, provider };
}

export function authorizeTaskRead(request: FastifyRequest, task: { tokenId: string; repo: string }): void {
  if (request.auth?.id === task.tokenId) {
    return;
  }

  requireScopes(request, ["task:read"]);
  requireScopes(request, [`repo:${task.repo}`]);
}

export function authorizeTaskControl(request: FastifyRequest, task: { tokenId: string; repo: string }): void {
  if (request.auth?.id === task.tokenId) {
    return;
  }

  requireScopes(request, ["task:read", "task:control"]);
  requireScopes(request, [`repo:${task.repo}`]);
}
