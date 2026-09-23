import { isLoopbackHost } from "../infrastructure/config.js";

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

export type McpAdapterConfig = {
  origin: URL;
  token: string;
  pollIntervalMs: number;
  timeoutMs: number;
};

const defaultOrigin = "http://127.0.0.1:8787";

export function loadMcpAdapterConfig(env: NodeJS.ProcessEnv): McpAdapterConfig {
  const token = env.CODEXGW_API_TOKEN ?? "";
  if (token.length < 32) {
    throw new McpConfigError("CODEXGW_API_TOKEN must contain at least 32 characters");
  }
  if (!/^[\x21-\x7E]+$/.test(token)) {
    throw new McpConfigError("CODEXGW_API_TOKEN contains characters that cannot be sent as a bearer token");
  }
  return {
    origin: parseLoopbackOrigin(env.CODEXGW_BASE_URL ?? defaultOrigin),
    token,
    pollIntervalMs: positiveInteger(env.CODEXGW_MCP_POLL_INTERVAL_MS, 500, "CODEXGW_MCP_POLL_INTERVAL_MS"),
    timeoutMs: positiveInteger(env.CODEXGW_MCP_TIMEOUT_MS, 120_000, "CODEXGW_MCP_TIMEOUT_MS")
  };
}

export function parseLoopbackOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpConfigError("CODEXGW_BASE_URL is not a valid URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new McpConfigError("CODEXGW_BASE_URL must not include userinfo");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpConfigError("CODEXGW_BASE_URL must use http or https");
  }
  if (!isLoopbackHost(gatewayHostname(url))) {
    throw new McpConfigError("CODEXGW_BASE_URL must be a loopback host (127.0.0.1, ::1, or localhost)");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    throw new McpConfigError("CODEXGW_BASE_URL must not include a path, query, or fragment");
  }
  return url;
}

export function gatewayHostname(url: URL): string {
  const hostname = url.hostname;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new McpConfigError(`${name} must be a positive integer`);
  }
  return parsed;
}
