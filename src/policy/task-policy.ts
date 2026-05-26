import type { FastifyRequest } from "fastify";
import { requireScopes } from "../auth/authorize.js";
import { hasScope } from "../auth/scopes.js";
import { getAllowedRepo } from "./repos.js";
import { assertTaskMode, type TaskMode } from "./modes.js";
import { ApiError } from "../utils/errors.js";

export type TaskPolicyResult = {
  repo: ReturnType<typeof getAllowedRepo>;
  mode: TaskMode;
};

export function authorizeTaskCreate(request: FastifyRequest, repoId: string, requestedMode?: string): TaskPolicyResult {
  requireScopes(request, ["task:create"]);
  if (!request.auth || !hasScope(request.auth.scopes, `repo:${repoId}`)) {
    throw new ApiError("FORBIDDEN");
  }

  const repo = getAllowedRepo(repoId);
  const mode = requestedMode ? assertTaskMode(requestedMode) : repo.defaultMode;

  if (!repo.allowedModes.includes(mode)) {
    throw new ApiError("MODE_NOT_ALLOWED");
  }

  requireScopes(request, [`mode:${mode}`]);

  return { repo, mode };
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
