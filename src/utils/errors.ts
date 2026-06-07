import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export const ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "VALIDATION_ERROR",
  "TOKEN_EXPIRED",
  "TOKEN_REVOKED",
  "REPO_NOT_ALLOWED",
  "PROVIDER_NOT_ALLOWED",
  "MODE_NOT_ALLOWED",
  "CODEX_NOT_CONFIGURED",
  "CODEX_EXECUTION_FAILED",
  "INTERNAL_ERROR"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 400,
  TOKEN_EXPIRED: 401,
  TOKEN_REVOKED: 401,
  REPO_NOT_ALLOWED: 403,
  PROVIDER_NOT_ALLOWED: 403,
  MODE_NOT_ALLOWED: 403,
  CODEX_NOT_CONFIGURED: 501,
  CODEX_EXECUTION_FAILED: 500,
  INTERNAL_ERROR: 500
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? defaultMessage(code));
    this.name = "ApiError";
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
  }
}

export function defaultMessage(code: ErrorCode): string {
  switch (code) {
    case "UNAUTHORIZED":
      return "Unauthorized";
    case "FORBIDDEN":
      return "Forbidden";
    case "NOT_FOUND":
      return "Not found";
    case "CONFLICT":
      return "Conflict";
    case "VALIDATION_ERROR":
      return "Validation error";
    case "TOKEN_EXPIRED":
      return "Token expired";
    case "TOKEN_REVOKED":
      return "Token revoked";
    case "REPO_NOT_ALLOWED":
      return "Repository is not allowed";
    case "PROVIDER_NOT_ALLOWED":
      return "Provider is not allowed";
    case "MODE_NOT_ALLOWED":
      return "Mode is not allowed";
    case "CODEX_NOT_CONFIGURED":
      return "Codex is not configured";
    case "CODEX_EXECUTION_FAILED":
      return "Codex task execution failed";
    case "INTERNAL_ERROR":
      return "Internal error";
  }
}

export function installErrorHandler() {
  return (error: FastifyError | ApiError | ZodError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ZodError) {
      request.audit = { ...request.audit, error: "VALIDATION_ERROR" };
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation error"
        }
      });
    }

    if (error instanceof ApiError) {
      request.audit = { ...request.audit, error: error.code };
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message
        }
      });
    }

    request.log.error(error);
    request.audit = { ...request.audit, error: "INTERNAL_ERROR" };
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal error"
      }
    });
  };
}
