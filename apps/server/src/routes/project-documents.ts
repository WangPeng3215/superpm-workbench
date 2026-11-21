import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ProjectDocumentService } from "../services/project-documents.js";

const idSchema = z.coerce.number().int().positive();

export function registerProjectDocumentRoutes(
  app: FastifyInstance,
  service: ProjectDocumentService,
) {
  const projectId = (request: FastifyRequest) =>
    idSchema.parse((request.params as { id: string }).id);
  const documentId = (request: FastifyRequest) =>
    idSchema.parse((request.params as { documentId: string }).documentId);

  app.get("/api/projects/:id/documents", async (request) =>
    service.list(projectId(request), request.query ?? {}),
  );
  app.post("/api/projects/:id/documents", async (request, reply) =>
    reply.status(201).send(service.create(projectId(request), request.body)),
  );
  app.post("/api/projects/:id/documents/copy-meeting", async (request, reply) =>
    reply
      .status(201)
      .send(service.copyMeeting(projectId(request), request.body)),
  );
  app.get("/api/projects/:id/documents/:documentId", async (request) =>
    service.get(projectId(request), documentId(request)),
  );
  app.patch("/api/projects/:id/documents/:documentId", async (request) =>
    service.update(projectId(request), documentId(request), request.body),
  );
  app.delete("/api/projects/:id/documents/:documentId", async (request, reply) => {
    service.remove(projectId(request), documentId(request), request.body);
    return reply.status(204).send();
  });
  app.get("/api/projects/:id/artifacts", async (request) =>
    service.artifacts(projectId(request)),
  );
}
