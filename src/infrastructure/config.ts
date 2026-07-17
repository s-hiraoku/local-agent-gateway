import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { GatewayError } from "../domain/errors.js";

export type RepositoryTarget = {
  id: string;
  path: string;
};

export type GatewayConfig = {
  host: string;
  port: number;
  databasePath: string;
  apiToken: string;
  encryptionKey: Buffer;
  repositories: ReadonlyMap<string, RepositoryTarget>;
  codexCommand: string;
  codexHome: string;
  inferenceWorkspaceRoot: string;
  codexModel?: string;
  maxQueuedJobs: number;
  maxConcurrentJobs: number;
  maxPromptBytes: number;
  maxResultBytes: number;
  maxEventBytes: number;
  maxEventsPerJob: number;
  rpcTimeoutMs: number;
  turnTimeoutMs: number;
  retentionDays: number;
};

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new GatewayError("INVALID_REQUEST", `${name} must be a positive integer`, 500);
  }
  return parsed;
}

function parseRepositories(raw: string | undefined): ReadonlyMap<string, RepositoryTarget> {
  if (!raw) {
    throw new GatewayError("INVALID_REQUEST", "CODEXGW_REPOSITORIES_JSON is required", 500);
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new GatewayError("INVALID_REQUEST", "CODEXGW_REPOSITORIES_JSON must be valid JSON", 500);
  }
  // An empty array is valid: a gateway that only serves inference runs needs
  // no repositories. The variable is still required so the operator opts into
  // that explicitly rather than by omission.
  if (!Array.isArray(input)) {
    throw new GatewayError("INVALID_REQUEST", "CODEXGW_REPOSITORIES_JSON must be a JSON array", 500);
  }

  const repositories = new Map<string, RepositoryTarget>();
  for (const item of input) {
    if (!item || typeof item !== "object") {
      throw new GatewayError("INVALID_REQUEST", "Repository entries must be objects", 500);
    }
    const { id, path } = item as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      throw new GatewayError("INVALID_REQUEST", "Repository IDs must use lowercase letters, digits, _ or -", 500);
    }
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new GatewayError("INVALID_REQUEST", `Repository ${id} must have an absolute path`, 500);
    }
    const canonicalPath = realpathSync(path);
    if (!statSync(canonicalPath).isDirectory()) {
      throw new GatewayError("INVALID_REQUEST", `Repository ${id} is not a directory`, 500);
    }
    if (repositories.has(id)) {
      throw new GatewayError("INVALID_REQUEST", `Repository ${id} is configured more than once`, 500);
    }
    repositories.set(id, { id, path: canonicalPath });
  }
  return repositories;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const apiToken = env.CODEXGW_API_TOKEN;
  if (!apiToken || apiToken.length < 32) {
    throw new GatewayError("INVALID_REQUEST", "CODEXGW_API_TOKEN must contain at least 32 characters", 500);
  }
  const encodedKey = env.CODEXGW_DATA_ENCRYPTION_KEY;
  if (!encodedKey) {
    throw new GatewayError("INVALID_REQUEST", "CODEXGW_DATA_ENCRYPTION_KEY is required", 500);
  }
  const encryptionKey = Buffer.from(encodedKey, "base64");
  if (encryptionKey.byteLength !== 32) {
    throw new GatewayError("INVALID_REQUEST", "CODEXGW_DATA_ENCRYPTION_KEY must be 32 bytes encoded as base64", 500);
  }

  const model = env.CODEXGW_CODEX_MODEL?.trim();
  const codexHome = env.CODEXGW_CODEX_HOME ?? join(homedir(), ".codex-gateway");
  if (existsSync(join(codexHome, "config.toml"))) {
    throw new GatewayError(
      "CODEX_NOT_CONFIGURED",
      "The dedicated CODEX_HOME must not contain config.toml; configure the Gateway through server settings",
      500
    );
  }
  // A dedicated directory that holds only single-use inference workspaces.
  // It is deliberately separate from codexHome so the read-only inference
  // cwd can never sit alongside Codex auth material.
  const inferenceWorkspaceRoot = env.CODEXGW_INFERENCE_WORKSPACE_ROOT
    ?? join(homedir(), ".codex-gateway-inference");
  if (!isAbsolute(inferenceWorkspaceRoot)) {
    throw new GatewayError("INVALID_REQUEST", "CODEXGW_INFERENCE_WORKSPACE_ROOT must be an absolute path", 500);
  }
  return {
    host: env.CODEXGW_HOST ?? "127.0.0.1",
    port: positiveInteger(env.CODEXGW_PORT, 8787, "CODEXGW_PORT"),
    databasePath: env.CODEXGW_DATABASE_PATH ?? join(process.cwd(), "data", "gateway-v2.sqlite"),
    apiToken,
    encryptionKey,
    repositories: parseRepositories(env.CODEXGW_REPOSITORIES_JSON),
    codexCommand: env.CODEXGW_CODEX_COMMAND ?? "codex",
    codexHome,
    inferenceWorkspaceRoot,
    ...(model ? { codexModel: model } : {}),
    maxQueuedJobs: positiveInteger(env.CODEXGW_MAX_QUEUED_JOBS, 100, "CODEXGW_MAX_QUEUED_JOBS"),
    maxConcurrentJobs: positiveInteger(env.CODEXGW_MAX_CONCURRENT_JOBS, 2, "CODEXGW_MAX_CONCURRENT_JOBS"),
    maxPromptBytes: positiveInteger(env.CODEXGW_MAX_PROMPT_BYTES, 64 * 1024, "CODEXGW_MAX_PROMPT_BYTES"),
    maxResultBytes: positiveInteger(env.CODEXGW_MAX_RESULT_BYTES, 1024 * 1024, "CODEXGW_MAX_RESULT_BYTES"),
    maxEventBytes: positiveInteger(env.CODEXGW_MAX_EVENT_BYTES, 64 * 1024, "CODEXGW_MAX_EVENT_BYTES"),
    maxEventsPerJob: positiveInteger(env.CODEXGW_MAX_EVENTS_PER_JOB, 10_000, "CODEXGW_MAX_EVENTS_PER_JOB"),
    rpcTimeoutMs: positiveInteger(env.CODEXGW_RPC_TIMEOUT_MS, 30_000, "CODEXGW_RPC_TIMEOUT_MS"),
    turnTimeoutMs: positiveInteger(env.CODEXGW_TURN_TIMEOUT_MS, 30 * 60_000, "CODEXGW_TURN_TIMEOUT_MS"),
    retentionDays: positiveInteger(env.CODEXGW_RETENTION_DAYS, 14, "CODEXGW_RETENTION_DAYS")
  };
}
