import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ProjectTaskService } from "../services/project-tasks.js";

const idSchema = z.coerce.number().int().positive();
const querySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    includeId: z.coerce.number().int().positive().optional(),
  })
  .strict();

export function registerProjectTaskRequirementRoutes(
  app: FastifyInstance,
  service: ProjectTaskService,
) {
  app.get(
    "/api/projects/:id/task-requirements",
    async (request: FastifyRequest) => {
      const projectId = idSchema.parse((request.params as { id: string }).id);
      const query = querySchema.parse(request.query ?? {});
      return service.listRequirements(projectId, query);
    },
  );
}
