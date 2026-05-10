import type { FastifyInstance } from "fastify";
import { requireScopes } from "../auth/authorize.js";
import { listTaskProviderDescriptors } from "../provider/registry.js";

export async function providersRoutes(app: FastifyInstance) {
  app.get("/v1/providers", async (request) => {
    request.audit = { ...request.audit, action: "providers:list" };
    requireScopes(request, ["task:read"]);

    return {
      providers: listTaskProviderDescriptors()
    };
  });
}
