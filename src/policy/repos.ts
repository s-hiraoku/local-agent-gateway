import "dotenv/config";
import { ApiError } from "../utils/errors.js";
import { TASK_MODES, type TaskMode } from "./modes.js";
import { z } from "zod";

export type AllowedRepo = {
  id: string;
  path: string;
  defaultMode: TaskMode;
  allowedModes: readonly TaskMode[];
};

const repoConfigSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  path: z.string().min(1),
  defaultMode: z.enum(TASK_MODES),
  allowedModes: z.array(z.enum(TASK_MODES)).min(1)
}).superRefine((repo, ctx) => {
  if (!repo.allowedModes.includes(repo.defaultMode)) {
    ctx.addIssue({
      code: "custom",
      path: ["defaultMode"],
      message: "defaultMode must be included in allowedModes"
    });
  }
});

const allowedReposConfigSchema = z.array(repoConfigSchema).min(1);

const DEFAULT_ALLOWED_REPOS = {
  "local-agent-gateway": {
    id: "local-agent-gateway",
    path: process.cwd(),
    defaultMode: "read-only",
    allowedModes: ["read-only", "workspace-write"]
  },
  "readonly-example": {
    id: "readonly-example",
    path: process.cwd(),
    defaultMode: "read-only",
    allowedModes: ["read-only"]
  }
} as const satisfies Record<string, AllowedRepo>;

function loadAllowedRepos(): Record<string, AllowedRepo> {
  if (process.env.NODE_ENV === "test") {
    return DEFAULT_ALLOWED_REPOS;
  }

  const raw = process.env.CODEXGW_ALLOWED_REPOS_JSON;
  if (!raw?.trim()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CODEXGW_ALLOWED_REPOS_JSON must be configured in production");
    }
    return DEFAULT_ALLOWED_REPOS;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("CODEXGW_ALLOWED_REPOS_JSON must be valid JSON", { cause: error });
  }

  const repos = allowedReposConfigSchema.parse(parsed);
  const ids = new Set<string>();
  for (const repo of repos) {
    if (ids.has(repo.id)) {
      throw new Error(`Duplicate repo id in CODEXGW_ALLOWED_REPOS_JSON: ${repo.id}`);
    }
    ids.add(repo.id);
  }

  return Object.fromEntries(repos.map((repo) => [repo.id, repo]));
}

export const ALLOWED_REPOS = loadAllowedRepos();

export function getAllowedRepo(repoId: string): AllowedRepo {
  const repo = ALLOWED_REPOS[repoId];
  if (!repo) {
    throw new ApiError("REPO_NOT_ALLOWED");
  }
  return repo;
}

export function listAllowedRepos(): Array<Pick<AllowedRepo, "id" | "defaultMode">> {
  return Object.values(ALLOWED_REPOS).map((repo) => ({
    id: repo.id,
    defaultMode: repo.defaultMode
  }));
}

export function listAllowedReposForScopes(scopes: readonly string[]): Array<Pick<AllowedRepo, "id" | "defaultMode">> {
  return Object.values(ALLOWED_REPOS)
    .filter((repo) => scopes.includes(`repo:${repo.id}`))
    .map((repo) => ({
      id: repo.id,
      defaultMode: repo.defaultMode
    }));
}

export function allowedRepoIds(): string[] {
  return Object.keys(ALLOWED_REPOS);
}
