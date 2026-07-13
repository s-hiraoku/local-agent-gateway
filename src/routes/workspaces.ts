import type { FastifyInstance } from "fastify";
import { requireScopes } from "../auth/authorize.js";
import { listWorkspaceTargetsForScopes } from "../policy/workspaces.js";

function workspaceResponse(workspace: ReturnType<typeof listWorkspaceTargetsForScopes>[number]) {
  return {
    workspaceId: workspace.id,
    repo: workspace.repo,
    defaultMode: workspace.defaultMode,
    allowedModes: workspace.allowedModes,
    defaultProvider: workspace.defaultProvider,
    allowedProviders: workspace.allowedProviders
  };
}

export async function workspacesRoutes(app: FastifyInstance) {
  app.get("/v1/workspaces", async (request) => {
    request.audit = { ...request.audit, action: "workspaces:list" };
    requireScopes(request, ["task:read"]);

    return {
      workspaces: listWorkspaceTargetsForScopes(request.auth?.scopes ?? []).map(workspaceResponse)
    };
  });
}
