export type GatewayErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "IDEMPOTENCY_CONFLICT"
  | "QUEUE_FULL"
  | "JOB_NOT_CANCELLABLE"
  | "CODEX_NOT_CONFIGURED"
  | "CODEX_UNAUTHORIZED"
  | "CODEX_RATE_LIMITED"
  | "CODEX_OVERLOADED"
  | "CODEX_TIMEOUT"
  | "CODEX_EXECUTION_FAILED"
  | "INTERNAL_ERROR";

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly statusCode: number,
    readonly retryable = false
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function normalizeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) {
    return error;
  }
  return new GatewayError("INTERNAL_ERROR", "The gateway could not complete the request", 500);
}
