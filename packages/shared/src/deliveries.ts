import { z } from "zod";
import { dateSchema } from "./dates.js";

export const deliveryStatuses = [
  "planning",
  "active",
  "awaiting_acceptance",
  "accepted",
  "cancelled",
] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

const nullableDate = dateSchema.nullable();

export const deliveryCreateSchema = z
  .object({
    name: z.string().trim().min(1, "请输入交付名称").max(200),
    plannedDeliveryDate: nullableDate.default(null),
    actualDeliveryDate: nullableDate.default(null),
    acceptanceOwnerUserId: z.number().int().positive().nullable().default(null),
    description: z.string().max(5000).default(""),
  })
  .strict();
export type DeliveryCreate = z.input<typeof deliveryCreateSchema>;
export type DeliveryCreateParsed = z.output<typeof deliveryCreateSchema>;

export const deliveryScopeChangeSchema = z
  .object({
    type: z.enum(["add", "remove", "postpone", "waive"]),
    requirementId: z.number().int().positive(),
    reason: z.string().trim().min(1, "请填写范围变更原因").max(2000),
    followUpDeliveryId: z.number().int().positive().nullable().default(null),
    followUpOwnerUserId: z.number().int().positive().nullable().default(null),
    followUpDate: nullableDate.default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      ["remove", "postpone", "waive"].includes(value.type) &&
      !value.followUpDeliveryId &&
      !(value.followUpOwnerUserId && value.followUpDate)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["followUpDate"],
        message: "移出范围必须填写后续交付，或责任人和跟进日期",
      });
    }
  });
export type DeliveryScopeChangeInput = z.input<
  typeof deliveryScopeChangeSchema
>;
export type DeliveryScopeChangeParsed = z.output<
  typeof deliveryScopeChangeSchema
>;

export const deliveryScopeConfirmationSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    requirementIds: z.array(z.number().int().positive()).max(500),
    changeReason: z.string().trim().max(2000).default(""),
    changes: z.array(deliveryScopeChangeSchema).max(500).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.requirementIds).size !== value.requirementIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requirementIds"],
        message: "需求不能重复",
      });
    }
  });
export type DeliveryScopeConfirmation = z.input<
  typeof deliveryScopeConfirmationSchema
>;
export type DeliveryScopeConfirmationParsed = z.output<
  typeof deliveryScopeConfirmationSchema
>;

export interface DeliveryScopeChange {
  id: number;
  type: "add" | "remove" | "postpone" | "waive";
  requirementId: number;
  reason: string;
  followUpDeliveryId: number | null;
  followUpOwnerUserId: number | null;
  followUpDate: string | null;
  createdBy: number;
  createdAt: string;
}

export interface DeliveryScopeItem {
  id: number;
  scopeVersionId: number;
  requirementId: number;
  requirementNo: string;
  requirementName: string;
  description: string;
  descriptionHtml: string;
  acceptanceCriteria: string;
  requirementVersion: number;
}

export interface DeliveryScopeVersion {
  id: number;
  deliveryId: number;
  version: number;
  confirmedBy: number;
  confirmedAt: string;
  changeReason: string;
  items: DeliveryScopeItem[];
  changes: DeliveryScopeChange[];
}

export interface Delivery extends DeliveryCreateParsed {
  id: number;
  projectId: number;
  isDefault: boolean;
  status: DeliveryStatus;
  version: number;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  currentScopeVersionId: number | null;
  scopeVersion: DeliveryScopeVersion | null;
}

export interface DeliveryListResult {
  items: Delivery[];
}

export const acceptanceEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      label: z.string().trim().min(1).max(200),
      content: z.string().trim().min(1).max(100_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("url"),
      label: z.string().trim().min(1).max(200),
      url: z.string().url().max(2048).refine((value) => /^https?:\/\//i.test(value)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      label: z.string().trim().min(1).max(200),
      sourceResourceId: z.number().int().positive(),
    })
    .strict(),
]);
export type AcceptanceEvidenceInput = z.input<typeof acceptanceEvidenceSchema>;

export const blockingIssueSchema = z
  .object({
    issueId: z.number().int().positive(),
    expectedVersion: z.number().int().positive(),
    impact: z.string().trim().max(2000).default(""),
  })
  .strict();
export type BlockingIssueInput = z.input<typeof blockingIssueSchema>;

export const blockingIssueResolveSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type BlockingIssueResolveInput = z.input<typeof blockingIssueResolveSchema>;

export const riskAcceptanceSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(1, "请填写风险接受原因").max(2000),
    evidence: acceptanceEvidenceSchema,
  })
  .strict();
export type RiskAcceptanceInput = z.input<typeof riskAcceptanceSchema>;

export const acceptanceSubmissionSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    scopeVersionId: z.number().int().positive(),
    deliveryNotes: z.string().trim().max(5000).default(""),
    evidence: z.array(acceptanceEvidenceSchema).min(1).max(20),
    customerConfirmation: z
      .object({
        confirmedByName: z.string().trim().min(1).max(200),
        confirmedByRole: z.string().trim().min(1).max(200),
        confirmedAt: z.string().datetime({ offset: true }),
        evidence: acceptanceEvidenceSchema,
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type AcceptanceSubmission = z.input<typeof acceptanceSubmissionSchema>;
export type AcceptanceSubmissionParsed = z.output<typeof acceptanceSubmissionSchema>;

const acceptanceItemResultSchema = z
  .object({
    scopeItemId: z.number().int().positive(),
    result: z.enum(["passed", "failed"]),
    reason: z.string().trim().max(2000).default(""),
    issueId: z.number().int().positive().nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.result === "failed" && !value.reason)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "验收不通过时请填写原因",
      });
    if (value.result === "passed" && value.issueId !== null)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issueId"],
        message: "验收通过项不能关联阻断问题",
      });
  });

export const acceptanceResultsSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    scopeVersionId: z.number().int().positive(),
    results: z.array(acceptanceItemResultSchema).min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.results.map((result) => result.scopeItemId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["results"],
        message: "每个范围项只能提交一次结果",
      });
  });
export type AcceptanceResults = z.input<typeof acceptanceResultsSchema>;
export type AcceptanceResultsParsed = z.output<typeof acceptanceResultsSchema>;

export interface AcceptanceEvidence {
  id: number;
  kind: "text" | "url" | "file";
  sourceKind: "manual" | "external_url" | "requirement_file";
  sourceResourceId: number | null;
  label: string;
  content: string | null;
  url: string | null;
  immutable: boolean;
  contentHash: string | null;
  mimeType: string | null;
  createdBy: number;
  createdAt: string;
}

export interface AcceptanceRoundItem {
  id: number;
  scopeItemId: number;
  requirementId: number;
  requirementNo: string;
  requirementName: string;
  acceptanceCriteria: string;
  result: "passed" | "failed" | null;
  reason: string;
  issueId: number | null;
  issueVersion: number | null;
  recordedBy: number | null;
  recordedAt: string | null;
}

export interface AcceptanceCustomerConfirmation {
  confirmedByName: string;
  confirmedByRole: string;
  confirmedAt: string;
  evidence: AcceptanceEvidence;
}

export interface AcceptanceRound {
  id: number;
  deliveryId: number;
  round: number;
  scopeVersionId: number;
  deliveryVersion: number;
  status: "pending" | "passed" | "failed" | "superseded";
  deliveryNotes: string;
  submittedBy: number;
  submittedAt: string;
  completedBy: number | null;
  completedAt: string | null;
  customerConfirmation: AcceptanceCustomerConfirmation | null;
  evidence: AcceptanceEvidence[];
  items: AcceptanceRoundItem[];
}

export interface DeliveryBlockingIssue {
  id: number;
  version: number;
  deliveryId: number;
  issueId: number;
  issueVersion: number;
  impact: string;
  createdBy: number;
  createdAt: string;
  resolvedAt: string | null;
  riskAcceptance: DeliveryRiskAcceptance | null;
}

export interface DeliveryRiskAcceptance {
  id: number;
  blockingIssueId: number;
  issueVersion: number;
  reason: string;
  evidence: AcceptanceEvidence;
  acceptedBy: number;
  acceptedAt: string;
}

export interface DeliveryClosureCheck {
  canClose: boolean;
  blockers: Array<{
    kind: "acceptance" | "blocking_issue" | "scope_change";
    deliveryId: number | null;
    id: number;
    reason: string;
    issueId?: number;
  }>;
}

export const projectClosureSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(1, "请填写结项原因").max(2000),
  })
  .strict();
export type ProjectClosureInput = z.input<typeof projectClosureSchema>;
