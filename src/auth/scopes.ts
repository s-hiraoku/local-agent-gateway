import { allowedRepoIds } from "../policy/repos.js";
import { TASK_MODES } from "../policy/modes.js";
import { taskProviderIds } from "../provider/registry.js";
import { workspaceIds } from "../policy/workspaces.js";

export const STATIC_SCOPES = [
  "task:create",
  "task:read",
  "task:control",
  "audit:read",
  "thread:create",
  "thread:write",
  "token:create",
  "token:read",
  "token:revoke",
  "codex:account:read",
  "codex:account:login",
  "codex:account:logout"
] as const;

export type StaticScope = (typeof STATIC_SCOPES)[number];
export type Scope = StaticScope | `repo:${string}` | `workspace:${string}` | `mode:${string}` | `provider:${string}`;

export function isValidScope(scope: string): boolean {
  if ((STATIC_SCOPES as readonly string[]).includes(scope)) {
    return true;
  }

  if (scope.startsWith("repo:")) {
    return allowedRepoIds().includes(scope.slice("repo:".length));
  }

  if (scope.startsWith("workspace:")) {
    return workspaceIds().includes(scope.slice("workspace:".length));
  }

  if (scope.startsWith("mode:")) {
    return (TASK_MODES as readonly string[]).includes(scope.slice("mode:".length));
  }

  if (scope.startsWith("provider:")) {
    return taskProviderIds().includes(scope.slice("provider:".length));
  }

  return false;
}

export function allBootstrapScopes(): string[] {
  return [
    ...STATIC_SCOPES,
    ...allowedRepoIds().map((id) => `repo:${id}`),
    ...workspaceIds().map((id) => `workspace:${id}`),
    ...TASK_MODES.map((mode) => `mode:${mode}`),
    ...taskProviderIds().map((id) => `provider:${id}`)
  ];
}

export function hasScope(scopes: readonly string[], scope: string): boolean {
  return scopes.includes(scope);
}
