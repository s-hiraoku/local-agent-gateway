import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_PATH: z.string().default("./data/local-agent-gateway.sqlite"),
  APP_BACKEND: z.enum(["codex-app-server"]).default("codex-app-server"),
  CODEX_APP_SERVER_COMMAND: z.string().min(1).default("codex"),
  CODEX_APP_SERVER_MODEL: z.string().min(1).optional(),
  CODEX_APP_SERVER_TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  CODEXGW_MAX_PARALLEL_READ_TASKS: z.coerce.number().int().positive().default(4),
  CODEXGW_ALLOWED_REPOS_JSON: z.string().optional(),
  CODEXGW_WORKSPACES_JSON: z.string().optional(),
  TOKEN_PEPPER: z.string().min(1).default("change-me-to-a-long-random-secret"),
  BOOTSTRAP_ADMIN_TOKEN: z.string().optional()
}).superRefine((config, ctx) => {
  if (config.NODE_ENV === "production" && config.TOKEN_PEPPER === "change-me-to-a-long-random-secret") {
    ctx.addIssue({
      code: "custom",
      path: ["TOKEN_PEPPER"],
      message: "TOKEN_PEPPER must be changed in production"
    });
  }

  if (config.NODE_ENV === "production" && config.BOOTSTRAP_ADMIN_TOKEN) {
    ctx.addIssue({
      code: "custom",
      path: ["BOOTSTRAP_ADMIN_TOKEN"],
      message: "BOOTSTRAP_ADMIN_TOKEN must not be configured in production"
    });
  }

  if (config.NODE_ENV === "production" && !config.CODEXGW_ALLOWED_REPOS_JSON?.trim()) {
    ctx.addIssue({
      code: "custom",
      path: ["CODEXGW_ALLOWED_REPOS_JSON"],
      message: "CODEXGW_ALLOWED_REPOS_JSON must be configured in production"
    });
  }
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(env);
}
