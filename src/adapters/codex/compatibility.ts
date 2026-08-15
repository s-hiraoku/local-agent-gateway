import { GatewayError } from "../../domain/errors.js";

// Inclusive range of Codex CLI versions this adapter was verified against.
// Bump the bounds only after fake-server contract tests and a live App Server
// probe succeed on the new CLI. Operators must pin the installed CLI inside
// this range; `/readyz` fails closed outside it or when the version is unreadable.
export const SUPPORTED_CODEX_CLI_RANGE = {
  minInclusive: "0.128.0",
  maxInclusive: "0.149.99"
} as const;

const SEMVER = /(\d+)\.(\d+)\.(\d+)/;

export function parseCodexVersion(text: string): string | undefined {
  const match = text.match(SEMVER);
  if (!match) return undefined;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function unsupportedCodexVersionError(): GatewayError {
  return new GatewayError(
    "CODEX_UNSUPPORTED_VERSION",
    "The installed Codex CLI is not a supported version",
    503,
    false
  );
}

export function assertSupportedCodexVersion(version: string): void {
  if (
    compareSemver(version, SUPPORTED_CODEX_CLI_RANGE.minInclusive) < 0
    || compareSemver(version, SUPPORTED_CODEX_CLI_RANGE.maxInclusive) > 0
  ) {
    throw unsupportedCodexVersionError();
  }
}

export const CODEX_INITIALIZE_PARAMS = {
  clientInfo: { name: "local-agent-gateway", title: "Local Agent Gateway", version: "2.0.0" },
  capabilities: { experimentalApi: false }
} as const;

export const CODEX_APP_SERVER_METHODS = {
  initialize: "initialize",
  initialized: "initialized",
  accountRead: "account/read",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt"
} as const;

export const CODEX_APP_SERVER_NOTIFICATIONS = {
  agentMessageDelta: "item/agentMessage/delta",
  itemCompleted: "item/completed",
  turnCompleted: "turn/completed"
} as const;
