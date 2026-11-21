import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ProjectTaskService } from "../services/project-tasks.js";
import type { DailyTaskService } from "../services/daily-tasks.js";

const idSchema = z.coerce.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(1).max(200).optional();

export function registerProjectTaskRoutes(
  app: FastifyInstance,
  service: ProjectTaskService,
  dailyTasks: DailyTaskService,
) {
  const id = (request: FastifyRequest) => idSchema.parse((request.params as { id: string }).id);
  const key = (request: FastifyRequest) => idempotencyKeySchema.parse(request.headers["idempotency-key"]);
  app.get("/api/projects/:id/tasks", async (request) => service.list(id(request), request.query ?? {}));
  app.post("/api/projects/:id/tasks", async (request, reply) => reply.status(201).send(service.create(id(request), request.body, key(request))));
  app.get("/api/project-tasks/:id", async (request) => service.get(id(request)));
  app.patch("/api/project-tasks/:id", async (request) => service.update(id(request), request.body));
  app.post("/api/project-tasks/:id/actions", async (request) => service.action(id(request), request.body, key(request)));
  app.post("/api/project-tasks/:id/daily-plans", async (request, reply) =>
    reply
      .status(201)
      .send(dailyTasks.planProjectTask(id(request), request.body)),
  );
}
