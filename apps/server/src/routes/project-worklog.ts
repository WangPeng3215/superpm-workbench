import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ProjectWorklogService } from "../services/project-worklog.js";

const projectIdSchema = z.coerce.number().int().positive();

export function registerProjectWorklogRoutes(
  app: FastifyInstance,
  service: ProjectWorklogService,
) {
  app.get(
    "/api/projects/:id/worklog",
    async (request: FastifyRequest) =>
      service.get(
        projectIdSchema.parse((request.params as { id: string }).id),
      ),
  );
}
