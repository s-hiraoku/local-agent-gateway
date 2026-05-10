import sensible from "@fastify/sensible";
import Fastify from "fastify";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/connection.js";
import { openDatabase } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { CodexClient, type CodexAccountClient } from "./codex/client.js";
import type { TaskRunner } from "./provider/task-runner.js";
import { authMiddleware } from "./auth/middleware.js";
import { writeAuditLog } from "./audit/audit-log.js";
import { ApiError, installErrorHandler } from "./utils/errors.js";
import { healthRoutes } from "./routes/health.js";
import { reposRoutes } from "./routes/repos.js";
import { tokenRoutes } from "./routes/tokens.js";
import { taskRoutes } from "./routes/tasks.js";
import { codexAccountRoutes } from "./routes/codex-account.js";

export type AppDeps = {
  config: AppConfig;
  db?: Db;
  taskRunner?: TaskRunner;
  codexRunner?: TaskRunner;
  codexAccountClient?: CodexAccountClient;
};

export function buildApp(deps: AppDeps) {
  const db = deps.db ?? openDatabase(deps.config.DATABASE_PATH);
  migrate(db);

  const app = Fastify({
    logger: {
      redact: {
        paths: ["req.headers.authorization"],
        censor: "[REDACTED]"
      }
    }
  });
  const providedTaskRunner = deps.taskRunner ?? deps.codexRunner;
  const defaultCodex = providedTaskRunner && deps.codexAccountClient ? null : new CodexClient(deps.config);
  const taskRunner = providedTaskRunner ?? (defaultCodex as CodexClient);
  const codexAccountClient = deps.codexAccountClient ?? (defaultCodex as CodexClient);

  void app.register(sensible);
  app.setErrorHandler(installErrorHandler());
  const authenticate = authMiddleware(db, deps.config);

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url === "/healthz" || request.url === "/healthz/") {
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Not found"
        }
      });
    }

    await authenticate(request, reply);
    request.audit = { ...request.audit, action: "not_found" };
    throw new ApiError("NOT_FOUND");
  });

  app.addHook("onResponse", async (request, reply) => {
    try {
      writeAuditLog(db, request, reply);
    } catch (error) {
      request.log.error(error, "failed to write audit log");
    }
  });

  void app.register(healthRoutes);

  void app.register(async (protectedApp) => {
    protectedApp.addHook("preHandler", authenticate);
    await protectedApp.register(reposRoutes);
    await protectedApp.register(tokenRoutes, { db, config: deps.config });
    await protectedApp.register(codexAccountRoutes, { codex: codexAccountClient });
    await protectedApp.register(taskRoutes, { db, taskRunner });
  });

  return app;
}
