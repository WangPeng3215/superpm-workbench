import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DeliveryService } from "../services/deliveries.js";

const idSchema = z.coerce.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(1).max(200).optional();

export function registerDeliveryRoutes(
  app: FastifyInstance,
  service: DeliveryService,
) {
  const id = (request: FastifyRequest, field = "id") =>
    idSchema.parse((request.params as Record<string, string>)[field]);
  const key = (request: FastifyRequest) =>
    idempotencyKeySchema.parse(request.headers["idempotency-key"]);

  app.get("/api/projects/:id/deliveries", async (request) =>
    service.list(id(request)),
  );
  app.post("/api/projects/:id/deliveries", async (request, reply) =>
    reply
      .status(201)
      .send(service.create(id(request), request.body, key(request))),
  );
  app.get("/api/deliveries/:id", async (request) =>
    service.get(id(request)),
  );
  app.get("/api/deliveries/:id/blocking-issues", async (request) =>
    service.listBlockingIssues(id(request)),
  );
  app.post("/api/deliveries/:id/blocking-issues", async (request) =>
    service.addBlockingIssue(id(request), request.body, key(request)),
  );
  app.patch("/api/deliveries/:id/blocking-issues/:issueId", async (request) =>
    service.resolveBlockingIssue(id(request, "issueId"), request.body, key(request)),
  );
  app.post("/api/delivery-blockers/:id/risk-acceptances", async (request) =>
    service.acceptRisk(id(request), request.body, key(request)),
  );
  app.post("/api/deliveries/:id/scope-confirmations", async (request) =>
    service.confirmScope(id(request), request.body, key(request)),
  );
  app.get("/api/deliveries/:id/acceptance-rounds", async (request) =>
    service.acceptanceRounds(id(request)),
  );
  app.post("/api/deliveries/:id/acceptance-rounds", async (request, reply) =>
    reply
      .status(201)
      .send(service.submitAcceptance(id(request), request.body, key(request))),
  );
  app.post("/api/acceptance-rounds/:id/results", async (request) =>
    service.recordAcceptanceResults(id(request), request.body, key(request)),
  );
  app.get(
    "/api/acceptance-rounds/:id/customer-confirmation/evidence",
    async (request, reply) => {
      const snapshot = service.readCustomerConfirmationEvidence(id(request));
      return reply
        .type(snapshot.evidence.mimeType ?? "application/octet-stream")
        .header("Content-Disposition", 'attachment; filename="customer-confirmation-evidence"')
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(snapshot.content);
    },
  );
  app.get(
    "/api/acceptance-rounds/:id/evidence/:evidenceId",
    async (request, reply) => {
      const evidenceId = id(request, "evidenceId");
      const snapshot = service.readAcceptanceEvidence(id(request), evidenceId);
      return reply
        .type(snapshot.evidence.mimeType ?? "application/octet-stream")
        .header("Content-Disposition", 'attachment; filename="acceptance-evidence"')
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(snapshot.content);
    },
  );
}
