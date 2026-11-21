import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ProjectService } from "../services/projects.js";
import type { DeliveryService } from "../services/deliveries.js";
const idSchema = z.coerce.number().int().positive();
export function registerProjectRoutes(
  app: FastifyInstance,
  service: ProjectService,
  deliveries?: DeliveryService,
) {
  const id = (request: FastifyRequest) =>
    idSchema.parse((request.params as { id: string }).id);
  const key = (request: FastifyRequest) =>
    z
      .string()
      .min(1)
      .max(200)
      .optional()
      .parse(request.headers["idempotency-key"]);
  app.get("/api/projects", async (request) =>
    service.list(request.query ?? {}),
  );
  app.get("/api/projects/:id/overview", async (request) =>
    service.overview(id(request)),
  );
  app.post("/api/projects", async (request, reply) =>
    reply.status(201).send(service.create(request.body, key(request))),
  );
  app.get("/api/projects/:id", async (request) => service.get(id(request)));
  app.patch("/api/projects/:id", async (request) =>
    service.update(id(request), request.body),
  );
  app.patch("/api/projects/:id/leads", async (request) =>
    service.leads(id(request), request.body),
  );
  app.post("/api/projects/:id/lifecycle", async (request) =>
    (() => {
      const projectId = id(request);
      const body = request.body as { action?: unknown };
      if (deliveries && body && body.action === "close")
        return deliveries.lifecycle(projectId, request.body, key(request));
      if (deliveries && body && body.action === "reopen" && service.get(projectId).project.status === "closed")
        return deliveries.lifecycle(projectId, request.body, key(request));
      return service.lifecycle(projectId, request.body, key(request));
    })(),
  );
  app.get("/api/projects/:id/closure-check", async (request) => {
    if (!deliveries) throw new Error("Delivery service unavailable");
    return deliveries.closureCheck(id(request));
  });
  app.get("/api/projects/:id/closures", async (request) => {
    if (!deliveries) throw new Error("Delivery service unavailable");
    return deliveries.closures(id(request));
  });
  app.patch("/api/projects/:id/archive", async (request) =>
    service.archive(id(request), request.body, key(request)),
  );
  app.get("/api/projects/:id/member-candidates", async (request) =>
    service.candidates(id(request), request.query ?? {}),
  );
  app.post("/api/projects/:id/members", async (request) =>
    service.writeMember(id(request), request.body, undefined, key(request)),
  );
  app.patch("/api/projects/:id/members/:userId", async (request) =>
    service.writeMember(
      id(request),
      request.body,
      idSchema.parse((request.params as { userId: string }).userId),
      key(request),
    ),
  );
  app.delete("/api/projects/:id/members/:userId", async (request) =>
    service.removeMember(
      id(request),
      idSchema.parse((request.params as { userId: string }).userId),
      request.body,
      key(request),
    ),
  );
  app.post("/api/projects/:id/requirements/share-preview", async (request) =>
    service.sharePreview(id(request), request.body),
  );
  app.post("/api/projects/:id/requirements/share", async (request) =>
    service.share(id(request), request.body, key(request)),
  );
  app.get("/api/projects/:id/events", async (request) =>
    service.events(id(request), request.query ?? {}),
  );
}
