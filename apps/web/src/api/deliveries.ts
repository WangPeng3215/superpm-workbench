import type {
  Delivery,
  DeliveryCreate,
  DeliveryListResult,
  DeliveryScopeConfirmation,
  AcceptanceRound,
  AcceptanceResults,
  AcceptanceSubmission,
  DeliveryBlockingIssue,
  DeliveryClosureCheck,
  ProjectDetail,
  ProjectClosureInput,
} from "@superpm/shared";
import { ApiError, request } from "./client";
import { authStore } from "../stores/auth";

const pendingCommands = new Map<string, string>();

async function command<T>(path: string, data: unknown, method: "POST" | "PATCH" = "POST"): Promise<T> {
  const body = JSON.stringify(data);
  const signature = String(authStore.user?.id ?? "") + "\n" + path + "\n" + body;
  const key = pendingCommands.get(signature) ?? crypto.randomUUID();
  pendingCommands.set(signature, key);
  try {
    const result = await request<T>(path, {
      method,
      body,
      headers: { "Idempotency-Key": key },
    });
    pendingCommands.delete(signature);
    return result;
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    )
      pendingCommands.delete(signature);
    throw error;
  }
}

export const deliveryApi = {
  list: (projectId: number) =>
    request<DeliveryListResult>("/projects/" + projectId + "/deliveries"),
  get: (deliveryId: number) => request<Delivery>("/deliveries/" + deliveryId),
  create: (projectId: number, input: DeliveryCreate) =>
    command<Delivery>("/projects/" + projectId + "/deliveries", input),
  confirmScope: (deliveryId: number, input: DeliveryScopeConfirmation) =>
    command<Delivery>(
      "/deliveries/" + deliveryId + "/scope-confirmations",
      input,
    ),
  acceptanceRounds: (deliveryId: number) =>
    request<AcceptanceRound[]>(
      "/deliveries/" + deliveryId + "/acceptance-rounds",
    ),
  submitAcceptance: (deliveryId: number, input: AcceptanceSubmission) =>
    command<AcceptanceRound>(
      "/deliveries/" + deliveryId + "/acceptance-rounds",
      input,
    ),
  recordAcceptanceResults: (roundId: number, input: AcceptanceResults) =>
    command<AcceptanceRound>(
      "/acceptance-rounds/" + roundId + "/results",
      input,
    ),
  blockingIssues: (deliveryId: number) =>
    request<DeliveryBlockingIssue[]>("/deliveries/" + deliveryId + "/blocking-issues"),
  addBlockingIssue: (deliveryId: number, input: { issueId: number; expectedVersion: number; impact?: string }) =>
    command<DeliveryBlockingIssue>("/deliveries/" + deliveryId + "/blocking-issues", input),
  resolveBlockingIssue: (deliveryId: number, blockingIssueId: number, input: { expectedVersion: number }) =>
    command<DeliveryBlockingIssue>("/deliveries/" + deliveryId + "/blocking-issues/" + blockingIssueId, input, "PATCH"),
  acceptRisk: (blockingIssueId: number, input: { expectedVersion: number; reason: string; evidence: AcceptanceSubmission["evidence"][number] }) =>
    command<DeliveryBlockingIssue>("/delivery-blockers/" + blockingIssueId + "/risk-acceptances", input),
  closureCheck: (projectId: number) =>
    request<DeliveryClosureCheck>("/projects/" + projectId + "/closure-check"),
  closures: (projectId: number) =>
    request<Array<{ id: number; projectId: number; action: string; fromStatus: string; toStatus: string; reason: string; checkSummary: string; actorUserId: number; actorName: string; createdAt: string }>>("/projects/" + projectId + "/closures"),
  closeProject: (projectId: number, input: ProjectClosureInput) =>
    command<ProjectDetail>("/projects/" + projectId + "/lifecycle", { action: "close", ...input }),
  reopenProject: (projectId: number, input: ProjectClosureInput) =>
    command<ProjectDetail>("/projects/" + projectId + "/lifecycle", { action: "reopen", ...input }),
  evidenceUrl: (roundId: number, evidenceId: number) =>
    "/api/acceptance-rounds/" + roundId + "/evidence/" + evidenceId,
  customerConfirmationEvidenceUrl: (roundId: number) =>
    "/api/acceptance-rounds/" + roundId + "/customer-confirmation/evidence",
};
