import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { RequirementFileService } from "./requirement-files.js";
import {
  acceptanceResultsSchema,
  acceptanceSubmissionSchema,
  blockingIssueSchema,
  blockingIssueResolveSchema,
  deliveryCreateSchema,
  deliveryScopeConfirmationSchema,
  projectClosureSchema,
  projectLifecycleSchema,
  riskAcceptanceSchema,
  type AcceptanceEvidence,
  type AcceptanceRound,
  type AcceptanceRoundItem,
  type AcceptanceResultsParsed,
  type AcceptanceSubmissionParsed,
  type Delivery,
  type DeliveryCreateParsed,
  type DeliveryListResult,
  type DeliveryScopeChangeParsed,
  type DeliveryScopeConfirmationParsed,
  type DeliveryScopeItem,
  type DeliveryScopeVersion,
  type DeliveryBlockingIssue,
  type DeliveryClosureCheck,
  type ProjectClosureInput,
  type ProjectDetail,
} from "@superpm/shared";
import {
  assertProjectAccess,
  assertProjectVersion,
  currentActor,
  projectRolesFor,
  capabilitiesFor,
} from "./project-access.js";
import { DomainError } from "./domain-error.js";

type EvidenceReader = Pick<RequirementFileService, "content" | "raw">;

type DeliveryRow = {
  id: number;
  project_id: number;
  name: string;
  is_default: number;
  status: Delivery["status"];
  version: number;
  planned_delivery_date: string | null;
  actual_delivery_date: string | null;
  acceptance_owner_user_id: number | null;
  current_scope_version_id: number | null;
  description: string;
  created_by: number;
  created_at: string;
  updated_at: string;
};

type ScopeVersionRow = {
  id: number;
  delivery_id: number;
  scope_version: number;
  confirmed_by: number;
  confirmed_at: string;
  change_reason: string;
};

type AcceptanceRoundRow = {
  id: number;
  delivery_id: number;
  scope_version_id: number;
  round_no: number;
  delivery_version: number;
  status: AcceptanceRound["status"];
  delivery_notes: string;
  submitted_by: number;
  submitted_at: string;
  completed_by: number | null;
  completed_at: string | null;
};

type AcceptanceEvidenceRow = {
  id: number;
  kind: AcceptanceEvidence["kind"];
  source_kind: AcceptanceEvidence["sourceKind"];
  source_resource_id: number | null;
  label: string;
  content: string | null;
  url: string | null;
  mime_type: string | null;
  immutable: number;
  content_hash: string | null;
  created_by: number;
  created_at: string;
};

type AcceptanceEvidenceSnapshotRow = AcceptanceEvidenceRow & {
  snapshot_content: Buffer | Uint8Array | null;
};

const now = () => new Date().toISOString();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}

const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

const normalizeEvidenceText = (value: string) =>
  value.replace(/\r\n?/g, "\n").normalize("NFC").trim();

export class DeliveryService {
  constructor(
    private readonly db: Database.Database,
    private readonly files?: EvidenceReader,
  ) {}

  list(projectId: number): DeliveryListResult {
    assertProjectAccess(this.db, projectId, "read", true);
    const rows = this.db
      .prepare(
        "SELECT * FROM deliveries WHERE project_id=? ORDER BY is_default DESC,id ASC",
      )
      .all(projectId) as DeliveryRow[];
    return { items: rows.map((row) => this.detail(row)) };
  }

  get(deliveryId: number): Delivery {
    const row = this.row(deliveryId);
    if (!row) throw new DomainError("NOT_FOUND", "交付不存在", 404);
    assertProjectAccess(this.db, row.project_id, "read", true);
    return this.detail(row);
  }

  acceptanceRounds(deliveryId: number): AcceptanceRound[] {
    const delivery = this.row(deliveryId);
    if (!delivery) throw new DomainError("NOT_FOUND", "交付不存在", 404);
    assertProjectAccess(this.db, delivery.project_id, "read", true);
    return (
      this.db
        .prepare(
          "SELECT * FROM delivery_acceptance_rounds WHERE delivery_id=? ORDER BY round_no",
        )
        .all(deliveryId) as AcceptanceRoundRow[]
    ).map((round) => this.acceptanceRoundDetail(round));
  }

  addBlockingIssue(deliveryId: number, input: unknown, key?: string): DeliveryBlockingIssue {
    const data = blockingIssueSchema.parse(input);
    const delivery = this.row(deliveryId);
    if (!delivery) throw new DomainError("NOT_FOUND", "交付不存在", 404);
    return this.runCommand("delivery.blocking_issue_add", delivery.project_id, { deliveryId, ...data }, key, () => {
      const current = this.row(deliveryId);
      if (!current) throw new DomainError("NOT_FOUND", "交付不存在", 404);
      const access = assertProjectAccess(this.db, current.project_id, "read", false);
      if (!access.roles.some((role) => role === "owner" || role === "product_owner"))
        throw new DomainError("FORBIDDEN", "只有项目负责人或产品负责人可以标记交付阻断", 403);
      assertProjectVersion(current.version, data.expectedVersion, this.detail(current));
      this.assertProjectWritable(access.project);
      const issue = this.db
        .prepare("SELECT i.version,r.project_id FROM issues i JOIN requirements r ON r.id=i.requirement_id WHERE i.id=? AND i.is_deleted=0 AND r.deleted_at IS NULL")
        .get(data.issueId) as { version: number; project_id: number | null } | undefined;
      if (!issue || issue.project_id !== current.project_id)
        throw new DomainError("INVALID_ISSUE", "问题必须属于当前项目", 400);
      const timestamp = now();
      const result = this.db
        .prepare("INSERT INTO delivery_blocking_issues(delivery_id,issue_id,issue_version,impact,created_by,created_at) VALUES(?,?,?,?,?,?)")
        .run(deliveryId, data.issueId, issue.version, data.impact, access.actor.id, timestamp);
      const deliveryUpdate = this.db.prepare("UPDATE deliveries SET version=version+1,updated_at=? WHERE id=? AND version=?")
        .run(timestamp, deliveryId, current.version);
      if (deliveryUpdate.changes !== 1)
        throw new DomainError("VERSION_CONFLICT", "交付已被其他成员更新，请刷新后重试", 409);
      this.db.prepare("UPDATE projects SET version=version+1,updated_at=? WHERE id=?").run(timestamp, current.project_id);
      this.db.prepare("INSERT INTO project_events(project_id,action,actor_user_id,actor_name_snapshot,payload,created_at) VALUES(?,?,?,?,?,?)")
        .run(current.project_id, "delivery_blocking_issue_added", access.actor.id, access.actor.display_name || access.actor.username, JSON.stringify({ deliveryId, issueId: data.issueId, issueVersion: issue.version }), timestamp);
      return this.blockingIssueDetail(Number(result.lastInsertRowid));
    });
  }

  listBlockingIssues(deliveryId: number): DeliveryBlockingIssue[] {
    const delivery = this.row(deliveryId);
    if (!delivery) throw new DomainError("NOT_FOUND", "交付不存在", 404);
    assertProjectAccess(this.db, delivery.project_id, "read", true);
    const rows = this.db
      .prepare("SELECT id FROM delivery_blocking_issues WHERE delivery_id=? ORDER BY id")
      .all(deliveryId) as { id: number }[];
    return rows.map((row) => this.blockingIssueDetail(row.id));
  }

  resolveBlockingIssue(blockingIssueId: number, input: unknown, key?: string): DeliveryBlockingIssue {
    const data = blockingIssueResolveSchema.parse(input);
    const blocker = this.db
      .prepare("SELECT b.id,b.delivery_id,d.project_id FROM delivery_blocking_issues b JOIN deliveries d ON d.id=b.delivery_id WHERE b.id=?")
      .get(blockingIssueId) as { id: number; delivery_id: number; project_id: number } | undefined;
    if (!blocker) throw new DomainError("NOT_FOUND", "交付阻断问题不存在", 404);
    const access = assertProjectAccess(this.db, blocker.project_id, "read", true);
    if (!access.roles.some((role) => role === "owner" || role === "product_owner"))
      throw new DomainError("FORBIDDEN", "只有项目负责人或产品负责人可以解除交付阻断", 403);
    return this.runCommand("delivery.blocking_issue_resolve", blocker.project_id, { blockingIssueId, ...data }, key, () => {
      const current = this.db
        .prepare("SELECT b.*,d.project_id,d.version AS delivery_version FROM delivery_blocking_issues b JOIN deliveries d ON d.id=b.delivery_id WHERE b.id=?")
        .get(blockingIssueId) as { id: number; delivery_id: number; project_id: number; delivery_version: number; resolved_at: string | null } | undefined;
      if (!current) throw new DomainError("NOT_FOUND", "交付阻断问题不存在", 404);
      const currentAccess = assertProjectAccess(this.db, current.project_id, "read", false);
      if (!currentAccess.roles.some((role) => role === "owner" || role === "product_owner"))
        throw new DomainError("FORBIDDEN", "只有项目负责人或产品负责人可以解除交付阻断", 403);
      assertProjectVersion(current.delivery_version, data.expectedVersion, this.get(current.delivery_id));
      this.assertProjectWritable(currentAccess.project);
      if (current.resolved_at) throw new DomainError("BLOCKER_RESOLVED", "交付阻断问题已解除", 409);
      const timestamp = now();
      this.db.prepare("UPDATE delivery_blocking_issues SET resolved_at=? WHERE id=? AND resolved_at IS NULL").run(timestamp, blockingIssueId);
      this.db.prepare("UPDATE deliveries SET version=version+1,updated_at=? WHERE id=? AND version=?").run(timestamp, current.delivery_id, current.delivery_version);
      this.db.prepare("UPDATE projects SET version=version+1,updated_at=? WHERE id=?").run(timestamp, current.project_id);
      this.db.prepare("INSERT INTO project_events(project_id,action,actor_user_id,actor_name_snapshot,payload,created_at) VALUES(?,?,?,?,?,?)")
        .run(current.project_id, "delivery_blocking_issue_resolved", currentAccess.actor.id, currentAccess.actor.display_name || currentAccess.actor.username, JSON.stringify({ blockingIssueId }), timestamp);
      return this.blockingIssueDetail(blockingIssueId);
    });
  }

  acceptRisk(blockingIssueId: number, input: unknown, key?: string): DeliveryBlockingIssue {
    const data = riskAcceptanceSchema.parse(input);
    const blocker = this.db.prepare("SELECT b.*,d.project_id,d.version AS delivery_version,i.version AS current_issue_version FROM delivery_blocking_issues b JOIN deliveries d ON d.id=b.delivery_id JOIN issues i ON i.id=b.issue_id WHERE b.id=?")
      .get(blockingIssueId) as { id:number; delivery_id:number; issue_id:number; issue_version:number; impact:string; created_by:number; created_at:string; resolved_at:string|null; project_id:number; delivery_version:number; current_issue_version:number } | undefined;
    if (!blocker) throw new DomainError("NOT_FOUND", "交付阻断问题不存在", 404);
    const access = assertProjectAccess(this.db, blocker.project_id, "read", false);
    if (!access.roles.includes("owner"))
      throw new DomainError("FORBIDDEN", "只有项目负责人可以接受交付风险", 403);
    return this.runCommand("delivery.risk_accept", blocker.project_id, { blockingIssueId, ...data }, key, () => {
      const current = this.db.prepare("SELECT b.*,d.project_id,d.version AS delivery_version,i.version AS current_issue_version FROM delivery_blocking_issues b JOIN deliveries d ON d.id=b.delivery_id JOIN issues i ON i.id=b.issue_id WHERE b.id=?")
        .get(blockingIssueId) as typeof blocker | undefined;
      if (!current) throw new DomainError("NOT_FOUND", "交付阻断问题不存在", 404);
      const currentAccess = assertProjectAccess(this.db, current.project_id, "lifecycle", false);
      if (!currentAccess.roles.includes("owner"))
        throw new DomainError("FORBIDDEN", "只有项目负责人可以接受交付风险", 403);
      assertProjectVersion(current.delivery_version, data.expectedVersion, this.get(current.delivery_id));
      this.assertProjectWritable(currentAccess.project);
      if (current.resolved_at) throw new DomainError("BLOCKER_RESOLVED", "已解决的阻断问题不能接受风险", 409);
      if (current.current_issue_version !== current.issue_version)
        throw new DomainError("ISSUE_VERSION_CHANGED", "问题已更新，请重新标记阻断后再接受风险", 409);
      this.insertRiskAcceptance(current, data, currentAccess.actor.id);
      const timestamp = now();
      this.db.prepare("UPDATE deliveries SET version=version+1,updated_at=? WHERE id=? AND version=?")
        .run(timestamp, current.delivery_id, current.delivery_version);
      this.db.prepare("UPDATE projects SET version=version+1,updated_at=? WHERE id=?").run(timestamp, current.project_id);
      this.db.prepare("INSERT INTO project_events(project_id,action,actor_user_id,actor_name_snapshot,payload,created_at) VALUES(?,?,?,?,?,?)")
        .run(current.project_id, "delivery_risk_accepted", currentAccess.actor.id, currentAccess.actor.display_name || currentAccess.actor.username, JSON.stringify({ blockingIssueId, issueId: current.issue_id, issueVersion: current.issue_version, reason: data.reason }), timestamp);
      return this.blockingIssueDetail(blockingIssueId);
    });
  }

  closureCheck(projectId: number): DeliveryClosureCheck {
    assertProjectAccess(this.db, projectId, "read", true);
    const blockers: DeliveryClosureCheck["blockers"] = [];
    const deliveries = this.db.prepare("SELECT id,name,status,current_scope_version_id FROM deliveries WHERE project_id=? AND status<>'cancelled' ORDER BY id").all(projectId) as { id:number; name:string; status:string; current_scope_version_id:number|null }[];
    for (const delivery of deliveries) {
      if (!delivery.current_scope_version_id) {
        blockers.push({ kind: "acceptance", deliveryId: delivery.id, id: delivery.id, reason: "尚未确认交付范围" });
        continue;
      }
      const scope = this.db.prepare("SELECT id,requirement_id FROM delivery_scope_items WHERE scope_version_id=? ORDER BY id").all(delivery.current_scope_version_id) as { id:number; requirement_id:number }[];
      const latestRound = this.db.prepare("SELECT id,status FROM delivery_acceptance_rounds WHERE delivery_id=? AND scope_version_id=? AND status IN ('passed','failed') ORDER BY round_no DESC LIMIT 1").get(delivery.id, delivery.current_scope_version_id) as { id:number; status:string } | undefined;
      if (scope.length && (!latestRound || latestRound.status !== "passed"))
        blockers.push({ kind: "acceptance", deliveryId: delivery.id, id: latestRound?.id ?? delivery.id, reason: latestRound?.status === "failed" ? "当前范围验收未通过" : "当前范围尚未验收通过" });
      const changes = this.db.prepare("SELECT id,change_type,follow_up_delivery_id,follow_up_owner_user_id,follow_up_date FROM delivery_scope_changes WHERE delivery_id=? AND scope_version_id=? AND change_type IN ('remove','postpone','waive')").all(delivery.id, delivery.current_scope_version_id) as { id:number; change_type:string; follow_up_delivery_id:number|null; follow_up_owner_user_id:number|null; follow_up_date:string|null }[];
      for (const change of changes) if (!change.follow_up_delivery_id && !(change.follow_up_owner_user_id && change.follow_up_date))
        blockers.push({ kind: "scope_change", deliveryId: delivery.id, id: change.id, reason: "延期或豁免范围缺少后续去向" });
    }
    const active = this.db.prepare("SELECT b.id,b.delivery_id,b.issue_id,b.issue_version,b.impact,i.version AS current_issue_version,ra.issue_version AS accepted_version FROM delivery_blocking_issues b JOIN deliveries d ON d.id=b.delivery_id JOIN issues i ON i.id=b.issue_id LEFT JOIN delivery_risk_acceptances ra ON ra.blocking_issue_id=b.id WHERE d.project_id=? AND d.status<>'cancelled' AND b.resolved_at IS NULL ORDER BY b.id").all(projectId) as { id:number; delivery_id:number; issue_id:number; issue_version:number; impact:string; current_issue_version:number; accepted_version:number|null }[];
    for (const issue of active) if (issue.accepted_version !== issue.current_issue_version)
      blockers.push({ kind: "blocking_issue", deliveryId: issue.delivery_id, id: issue.id, issueId: issue.issue_id, reason: issue.impact || "存在未接受的交付阻断问题" });
    return { canClose: blockers.length === 0, blockers };
  }

  closures(projectId: number) {
    assertProjectAccess(this.db, projectId, "read", true);
    return this.db.prepare("SELECT id,project_id AS projectId,action,from_status AS fromStatus,to_status AS toStatus,reason,check_summary AS checkSummary,actor_user_id AS actorUserId,actor_name_snapshot AS actorName,created_at AS createdAt FROM project_closures WHERE project_id=? ORDER BY id").all(projectId);
  }

  closeProject(projectId: number, input: unknown, key?: string) {
    const data = projectClosureSchema.parse(input);
    const access = assertProjectAccess(this.db, projectId, "read", true);
    if (!access.roles.includes("owner")) throw new DomainError("FORBIDDEN", "只有项目负责人可以结项", 403);
    return this.runCommand("project.close", projectId, data, key, () => {
      const currentAccess = assertProjectAccess(this.db, projectId, "lifecycle", false);
      if (!currentAccess.roles.includes("owner")) throw new DomainError("FORBIDDEN", "只有项目负责人可以结项", 403);
      assertProjectVersion(currentAccess.project.version, data.expectedVersion, currentAccess.project);
      if (["closed", "cancelled", "paused"].includes(currentAccess.project.status)) throw new DomainError("INVALID_TRANSITION", "当前项目不能结项，请先恢复已暂停项目", 409);
      const check = this.closureCheck(projectId);
      if (!check.canClose) throw new DomainError("CLOSURE_BLOCKED", "项目仍有未完成的结项条件", 409, check);
      const latest = this.db.prepare("SELECT status,version FROM projects WHERE id=?").get(projectId) as { status:string; version:number };
      assertProjectVersion(latest.version, data.expectedVersion, latest);
      const timestamp = now();
      const actor = currentAccess.actor;
      this.db.prepare("UPDATE projects SET status='closed',version=version+1,updated_at=? WHERE id=? AND version=?").run(timestamp, projectId, latest.version);
      this.db.prepare("INSERT INTO project_closures(project_id,action,from_status,to_status,reason,check_summary,actor_user_id,actor_name_snapshot,created_at) VALUES(?,'close',?,'closed',?,?,?,?,?)")
        .run(projectId, latest.status, data.reason, JSON.stringify(check), actor.id, actor.display_name || actor.username, timestamp);
      this.db.prepare("INSERT INTO project_events(project_id,action,actor_user_id,actor_name_snapshot,payload,created_at) VALUES(?,?,?,?,?,?)")
        .run(projectId, "project_closed", actor.id, actor.display_name || actor.username, JSON.stringify({ reason: data.reason, check }), timestamp);
      return this.projectDetail(projectId);
    });
  }

  lifecycle(projectId: number, input: unknown, key?: string) {
    const data = projectLifecycleSchema.parse(input);
    if (data.action === "close")
      return this.closeProject(
        projectId,
        { expectedVersion: data.expectedVersion, reason: data.reason },
        key,
      );
    if (data.action !== "reopen")
      throw new DomainError("INVALID_TRANSITION", "交付服务只处理结项和重开", 409);
    const access = assertProjectAccess(this.db, projectId, "read", true);
    if (!access.roles.includes("owner"))
      throw new DomainError("FORBIDDEN", "只有项目负责人可以重开项目", 403);
    return this.runCommand("project.reopen", projectId, data, key, () => {
      const currentAccess = assertProjectAccess(this.db, projectId, "lifecycle", true);
      if (!currentAccess.roles.includes("owner"))
        throw new DomainError("FORBIDDEN", "只有项目负责人可以重开项目", 403);
      if (currentAccess.project.archived_at)
        throw new DomainError("PROJECT_READ_ONLY", "请先解除归档，再重新开启项目", 409);
      assertProjectVersion(currentAccess.project.version, data.expectedVersion, currentAccess.project);
      if (!["closed", "cancelled"].includes(currentAccess.project.status))
        throw new DomainError("INVALID_TRANSITION", "只有已结项或已取消项目可以重开", 409);
      const actor = currentAccess.actor;
      const timestamp = now();
      const current = this.db.prepare("SELECT status,version FROM projects WHERE id=?").get(projectId) as { status:string; version:number };
      assertProjectVersion(current.version, data.expectedVersion, current);
      this.db.prepare("UPDATE projects SET status='active',previous_status=NULL,version=version+1,updated_at=? WHERE id=? AND version=?").run(timestamp, projectId, current.version);
      this.db.prepare("INSERT INTO project_closures(project_id,action,from_status,to_status,reason,check_summary,actor_user_id,actor_name_snapshot,created_at) VALUES(?,'reopen',?,'active',?,?,?,?,?)")
        .run(projectId, current.status, data.reason, "{}", actor.id, actor.display_name || actor.username, timestamp);
      this.db.prepare("INSERT INTO project_events(project_id,action,actor_user_id,actor_name_snapshot,payload,created_at) VALUES(?,?,?,?,?,?)")
        .run(projectId, "project_reopen", actor.id, actor.display_name || actor.username, JSON.stringify({ reason: data.reason, fromStatus: current.status, toStatus: "active" }), timestamp);
      return this.projectDetail(projectId);
    });
  }

  readAcceptanceEvidence(roundId: number, evidenceId: number) {
    const round = this.acceptanceRow(roundId);
    if (!round) throw new DomainError("NOT_FOUND", "验收轮次不存在", 404);
    const delivery = this.row(round.delivery_id);
    if (!delivery) throw new DomainError("NOT_FOUND", "交付不存在", 404);
    assertProjectAccess(this.db, delivery.project_id, "read", true);
    const evidence = this.db
      .prepare(
        "SELECT id,kind,source_kind,source_resource_id,label,content,url,mime_type,immutable,content_hash,created_by,created_at,snapshot_content FROM delivery_acceptance_evidence WHERE id=? AND round_id=?",
      )
      .get(evidenceId, roundId) as AcceptanceEvidenceSnapshotRow | undefined;
    if (!evidence) throw new DomainError("NOT_FOUND", "验收证据不存在", 404);
    if (!evidence.immutable || !evidence.snapshot_content)
      throw new DomainError("EVIDENCE_NOT_IMMUTABLE", "外部链接没有不可变内容快照", 409);
    return {
      evidence: {
        id: evidence.id,
        kind: evidence.kind,
        sourceKind: evidence.source_kind,
        sourceResourceId: evidence.source_resource_id,
        label: evidence.label,
        content: evidence.content,
        url: evidence.url,
        immutable: true,
        contentHash: evidence.content_hash,
        mimeType: evidence.mime_type,
        createdBy: evidence.created_by,
        createdAt: evidence.created_at,
      } satisfies AcceptanceEvidence,
      content: Buffer.from(evidence.snapshot_content),
    };
  }

  readCustomerConfirmationEvidence(roundId: number) {
    const round = this.acceptanceRow(roundId);
    if (!round) throw new DomainError("NOT_FOUND", "验收轮次不存在", 404);
    const delivery = this.row(round.delivery_id);
    if (!delivery) throw new DomainError("NOT_FOUND", "交付不存在", 404);
    assertProjectAccess(this.db, delivery.project_id, "read", true);
    const evidence = this.acceptanceRoundDetail(round).customerConfirmation?.evidence;
    if (!evidence) throw new DomainError("NOT_FOUND", "客户确认凭证不存在", 404);
    const snapshot = this.db.prepare("SELECT evidence_snapshot_content FROM delivery_acceptance_customer_confirmations WHERE round_id=?").get(roundId) as { evidence_snapshot_content: Buffer | Uint8Array | null };
    if (!evidence.immutable || !snapshot.evidence_snapshot_content)
      throw new DomainError("EVIDENCE_NOT_IMMUTABLE", "外部链接没有不可变内容快照", 409);
    return { evidence, content: Buffer.from(snapshot.evidence_snapshot_content) };
  }

  submitAcceptance(
    deliveryId: number,
    input: unknown,
    key?: string,
  ): AcceptanceRound {
    const data = acceptanceSubmissionSchema.parse(input);
    const delivery = this.row(deliveryId);
    if (!delivery) throw new DomainError("NOT_FOUND", "交付不存在", 404);
    const access = assertProjectAccess(
      this.db,
      delivery.project_id,
      "requirements",
      false,
    );
    if (!access.roles.some((role) => ["owner", "product_owner"].includes(role)))
      throw new DomainError("FORBIDDEN", "当前项目角色不能提交交付验收", 403);
    return this.acceptanceCommand(
      "delivery.acceptance_submit",
      delivery.project_id,
      { deliveryId, ...data },
      key,
      () => this.submitAcceptanceInTransaction(deliveryId, data),
    );
  }

  recordAcceptanceResults(
    roundId: number,
    input: unknown,
    key?: string,
  ): AcceptanceRound {
    const data = acceptanceResultsSchema.parse(input);
    const round = this.acceptanceRow(roundId);
    if (!round) throw new DomainError("NOT_FOUND", "验收轮次不存在", 404);
    const delivery = this.row(round.delivery_id);
    if (!delivery) throw new DomainError("NOT_FOUND", "交付不存在", 404);
    const access = assertProjectAccess(
      this.db,
      delivery.project_id,
      "read",
      false,
    );
    if (delivery.acceptance_owner_user_id !== access.actor.id)
      throw new DomainError("FORBIDDEN", "只有指定验收人可以记录验收结果", 403);
    if (
      !projectRolesFor(this.db, delivery.project_id, access.actor.id).some(
        (role) => role !== "viewer",
      )
    )
      throw new DomainError("FORBIDDEN", "指定验收人必须是当前项目的可操作成员", 403);
    return this.acceptanceCommand(
      "delivery.acceptance_results",
      delivery.project_id,
      { roundId, ...data },
      key,
      () => this.recordAcceptanceResultsInTransaction(roundId, data),
    );
  }

  create(projectId: number, input: unknown, key?: string): Delivery {
    const data = deliveryCreateSchema.parse(input);
    const access = assertProjectAccess(this.db, projectId, "requirements");
    this.assertProjectWritable(access.project);
    return this.command("delivery.create", projectId, data, key, () => {
      const access = assertProjectAccess(
        this.db,
        projectId,
        "requirements",
        false,
      );
      this.assertProjectWritable(access.project);
      this.assertMember(projectId, data.acceptanceOwnerUserId);
      const timestamp = now();
      const result = this.db
        .prepare(
          "INSERT INTO deliveries(project_id,name,is_default,status,version,planned_delivery_date,actual_delivery_date,acceptance_owner_user_id,description,created_by,created_at,updated_at) VALUES(?,?,0,'planning',1,?,?,?,?,?,?,?)",
        )
        .run(
          projectId,
          data.name,
          data.plannedDeliveryDate,
          data.actualDeliveryDate,
          data.acceptanceOwnerUserId ?? access.project.product_owner_user_id,
          data.description,
          access.actor.id,
          timestamp,
          timestamp,
        );
      return this.get(Number(result.lastInsertRowid));
    });
  }

  confirmScope(
    deliveryId: number,
    input: unknown,
    key?: string,
  ): Delivery {
    const data = deliveryScopeConfirmationSchema.parse(input);
    const row = this.row(deliveryId);
    if (!row) throw new DomainError("NOT_FOUND", "交付不存在", 404);
    const access = assertProjectAccess(this.db, row.project_id, "read", false);
    if (!access.roles.includes("owner"))
      throw new DomainError("FORBIDDEN", "只有项目负责人可以确认交付范围", 403);
    return this.command(
      "delivery.scope_confirm",
      row.project_id,
      { deliveryId, ...data },
      key,
      () => this.confirmScopeInTransaction(deliveryId, data),
    );
  }

  private confirmScopeInTransaction(
    deliveryId: number,
    data: DeliveryScopeConfirmationParsed,
  ): Delivery {
    const row = this.row(deliveryId);
    if (!row) throw new DomainError("NOT_FOUND", "交付不存在", 404);
    const access = assertProjectAccess(this.db, row.project_id, "read", false);
    if (!access.roles.includes("owner"))
      throw new DomainError("FORBIDDEN", "只有项目负责人可以确认交付范围", 403);
    this.assertProjectWritable(access.project);
    assertProjectVersion(row.version, data.expectedVersion, this.detail(row));

    const requirements = this.requirements(row.project_id, data.requirementIds);
    const requirementMap = new Map(requirements.map((item) => [item.id, item]));
    if (requirementMap.size !== data.requirementIds.length)
      throw new DomainError("INVALID_REQUIREMENT", "需求不存在或不属于当前项目", 400);
    for (const item of requirements) {
      const child = this.db
        .prepare(
          "SELECT 1 FROM requirements WHERE project_id=? AND parent_id=? AND deleted_at IS NULL LIMIT 1",
        )
        .get(row.project_id, item.id);
      if (child)
        throw new DomainError("INVALID_REQUIREMENT", "交付范围只能选择叶子需求", 400);
    }

    const current = row.current_scope_version_id
      ? (this.db
          .prepare("SELECT * FROM delivery_scope_versions WHERE id=?")
          .get(row.current_scope_version_id) as ScopeVersionRow | undefined)
      : undefined;
    const previousItems = current
      ? (this.db
          .prepare(
            "SELECT id,requirement_id,requirement_no,requirement_name FROM delivery_scope_items WHERE scope_version_id=? ORDER BY id",
          )
          .all(current.id) as {
          id: number;
          requirement_id: number;
          requirement_no: string;
          requirement_name: string;
        }[])
      : [];
    const previousIds = new Set(previousItems.map((item) => item.requirement_id));
    const nextIds = new Set(data.requirementIds);
    const added = data.requirementIds.filter((id) => !previousIds.has(id));
    const removed = previousItems
      .map((item) => item.requirement_id)
      .filter((id) => !nextIds.has(id));
    if (current && !data.changeReason)
      throw new DomainError("SCOPE_CHANGE_REASON_REQUIRED", "范围修订必须填写变更原因", 400);
    if (current && (added.length || removed.length) && !data.changes.length)
      throw new DomainError("SCOPE_CHANGE_RECORD_REQUIRED", "范围修订必须记录处置方式", 400);
    this.validateChanges(
      row,
      data.changes,
      current ? added : [],
      current ? removed : [],
    );

    for (const requirementId of data.requirementIds) {
      const active = this.db
        .prepare(
          "SELECT delivery_id FROM delivery_assignments WHERE requirement_id=? AND released_at IS NULL",
        )
        .get(requirementId) as { delivery_id: number } | undefined;
      if (active && active.delivery_id !== deliveryId)
        throw new DomainError(
          "REQUIREMENT_ALREADY_COMMITTED",
          "需求已被其他交付批次承诺",
          409,
        );
    }

    const actor = access.actor;
    const timestamp = now();
    const nextScopeVersion = (current?.scope_version ?? 0) + 1;
    const pendingRounds = this.db
      .prepare(
        "SELECT id,round_no,scope_version_id FROM delivery_acceptance_rounds WHERE delivery_id=? AND status='pending' ORDER BY id",
      )
      .all(deliveryId) as { id: number; round_no: number; scope_version_id: number }[];
    this.db
      .prepare(
        "UPDATE delivery_acceptance_rounds SET status='superseded',completed_by=?,completed_at=? WHERE delivery_id=? AND status='pending'",
      )
      .run(actor.id, timestamp, deliveryId);
    for (const pending of pendingRounds)
      this.db
        .prepare(
          "INSERT INTO project_events(project_id,action,actor_user_id,actor_name_snapshot,payload,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          row.project_id,
          "delivery_acceptance_superseded",
          actor.id,
          actor.display_name || actor.username,
          JSON.stringify({
            deliveryId,
            round: pending.round_no,
            roundId: pending.id,
            scopeVersionId: pending.scope_version_id,
            reason: data.changeReason,
          }),
          timestamp,
        );
    const versionResult = this.db
      .prepare(
        "INSERT INTO delivery_scope_versions(delivery_id,scope_version,confirmed_by,confirmed_at,change_reason) VALUES(?,?,?,?,?)",
      )
      .run(deliveryId, nextScopeVersion, actor.id, timestamp, data.changeReason);
    const scopeVersionId = Number(versionResult.lastInsertRowid);
    const itemIds = new Map<number, number>();
    const insertItem = this.db.prepare(
      "INSERT INTO delivery_scope_items(scope_version_id,requirement_id,requirement_no,requirement_name,description,description_html,acceptance_criteria,requirement_version) VALUES(?,?,?,?,?,?,?,?)",
    );
    for (const item of requirements) {
      const result = insertItem.run(
        scopeVersionId,
        item.id,
        item.requirement_no,
        item.name,
        item.description,
        item.description_html,
        item.acceptance_criteria,
        item.version,
      );
      itemIds.set(item.id, Number(result.lastInsertRowid));
    }
    const previousItemIds = new Map(
      previousItems.map((item) => [item.requirement_id, item.id]),
    );
    const insertChange = this.db.prepare(
      "INSERT INTO delivery_scope_changes(delivery_id,scope_version_id,change_type,requirement_id,original_scope_item_id,reason,follow_up_delivery_id,follow_up_owner_user_id,follow_up_date,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const change of data.changes) {
      insertChange.run(
        deliveryId,
        scopeVersionId,
        change.type,
        change.requirementId,
        previousItemIds.get(change.requirementId) ?? null,
        change.reason,
        change.followUpDeliveryId,
        change.followUpOwnerUserId,
        change.followUpDate,
        actor.id,
        timestamp,
      );
    }
    this.db
      .prepare(
        "UPDATE delivery_assignments SET released_at=? WHERE delivery_id=? AND released_at IS NULL",
      )
      .run(timestamp, deliveryId);
    const insertAssignment = this.db.prepare(
      "INSERT INTO delivery_assignments(project_id,delivery_id,requirement_id,scope_item_id,created_at) VALUES(?,?,?,?,?)",
    );
    for (const requirementId of data.requirementIds)
      insertAssignment.run(
        row.project_id,
        deliveryId,
        requirementId,
        itemIds.get(requirementId),
        timestamp,
      );
    const update = this.db
      .prepare(
        "UPDATE deliveries SET version=version+1,current_scope_version_id=?,status='active',updated_at=? WHERE id=? AND version=?",
      )
      .run(scopeVersionId, timestamp, deliveryId, data.expectedVersion);
    if (update.changes !== 1)
      throw new DomainError("VERSION_CONFLICT", "交付已被其他成员更新，请刷新后重试", 409);
    this.db
      .prepare(
        "INSERT INTO project_events(project_id,action,actor_user_id,actor_name_snapshot,payload,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        row.project_id,
        "delivery_scope_confirmed",
        actor.id,
        actor.display_name || actor.username,
        JSON.stringify({ deliveryId, scopeVersion: nextScopeVersion }),
        timestamp,
      );
    return this.get(deliveryId);
  }

  private validateChanges(
    row: DeliveryRow,
    changes: DeliveryScopeChangeParsed[],
    added: number[],
    removed: number[],
  ) {
    const changed = new Set([...added, ...removed]);
    const seen = new Set<number>();
    for (const change of changes) {
      if (seen.has(change.requirementId))
        throw new DomainError("INVALID_SCOPE_CHANGE", "同一需求只能记录一次范围变更", 400);
      seen.add(change.requirementId);
      if (!changed.has(change.requirementId))
        throw new DomainError("INVALID_SCOPE_CHANGE", "范围变更必须对应新增或移出需求", 400);
      const isAdded = added.includes(change.requirementId);
      if (isAdded && change.type !== "add")
        throw new DomainError("INVALID_SCOPE_CHANGE", "新增需求的变更类型必须为 add", 400);
      if (!isAdded && !["remove", "postpone", "waive"].includes(change.type))
        throw new DomainError("INVALID_SCOPE_CHANGE", "移出需求必须记录 remove、postpone 或 waive", 400);
      if (change.followUpDeliveryId) {
        const followUp = this.row(change.followUpDeliveryId);
        if (!followUp || followUp.project_id !== row.project_id)
          throw new DomainError("INVALID_SCOPE_CHANGE", "后续交付必须属于同一项目", 400);
      }
      this.assertMember(row.project_id, change.followUpOwnerUserId);
    }
    if (seen.size !== changed.size)
      throw new DomainError("SCOPE_CHANGE_RECORD_REQUIRED", "每个范围变化都必须记录处置方式", 400);
  }

  private requirements(projectId: number, ids: number[]) {
    if (!ids.length) return [] as {
      id: number;
      requirement_no: string;
      name: string;
      description: string;
      description_html: string;
      acceptance_criteria: string;
      version: number;
    }[];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare(
        "SELECT id,requirement_no,name,description,description_html,acceptance_criteria,version FROM requirements WHERE project_id=? AND deleted_at IS NULL AND id IN (" +
          placeholders +
          ")",
      )
      .all(projectId, ...ids) as {
      id: number;
      requirement_no: string;
      name: string;
      description: string;
      description_html: string;
      acceptance_criteria: string;
      version: number;
    }[];
  }

  private detail(row: DeliveryRow): Delivery {
    const scope = row.current_scope_version_id
      ? (this.db
          .prepare("SELECT * FROM delivery_scope_versions WHERE id=?")
          .get(row.current_scope_version_id) as ScopeVersionRow | undefined)
      : undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      isDefault: Boolean(row.is_default),
      status: row.status,
      version: row.version,
      plannedDeliveryDate: row.planned_delivery_date,
      actualDeliveryDate: row.actual_delivery_date,
      acceptanceOwnerUserId: row.acceptance_owner_user_id,
      description: row.description,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      currentScopeVersionId: row.current_scope_version_id,
      scopeVersion: scope ? this.scopeDetail(scope) : null,
    };
  }

  private acceptanceRow(roundId: number) {
    return this.db
      .prepare("SELECT * FROM delivery_acceptance_rounds WHERE id=?")
      .get(roundId) as AcceptanceRoundRow | undefined;
  }

  private acceptanceRoundDetail(row: AcceptanceRoundRow): AcceptanceRound {
    const evidence = this.db
      .prepare(
        "SELECT id,kind,source_kind,source_resource_id,label,content,url,mime_type,immutable,content_hash,created_by,created_at FROM delivery_acceptance_evidence WHERE round_id=? ORDER BY id",
      )
      .all(row.id) as AcceptanceEvidenceRow[];
    const items = this.db
      .prepare(
        "SELECT s.id AS scope_item_id,s.requirement_id,s.requirement_no,s.requirement_name,s.acceptance_criteria,a.result,a.reason,a.issue_id,a.issue_version,a.recorded_by,a.recorded_at FROM delivery_scope_items s LEFT JOIN delivery_acceptance_items a ON a.round_id=? AND a.scope_item_id=s.id WHERE s.scope_version_id=? ORDER BY s.id",
      )
      .all(row.id, row.scope_version_id) as {
      scope_item_id: number;
      requirement_id: number;
      requirement_no: string;
      requirement_name: string;
      acceptance_criteria: string;
      result: AcceptanceRoundItem["result"] | null;
      reason: string | null;
      issue_id: number | null;
      issue_version: number | null;
      recorded_by: number | null;
      recorded_at: string | null;
    }[];
    const confirmation = this.db.prepare("SELECT * FROM delivery_acceptance_customer_confirmations WHERE round_id=?").get(row.id) as {
      confirmed_by_name:string; confirmed_by_role:string; confirmed_at:string;
      evidence_kind:AcceptanceEvidence["kind"]; evidence_label:string; evidence_content:string|null;
      evidence_url:string|null; evidence_mime_type:string|null; evidence_snapshot_content:Buffer|Uint8Array|null;
      evidence_content_hash:string|null; recorded_by:number; recorded_at:string;
    } | undefined;
    return {
      id: row.id,
      deliveryId: row.delivery_id,
      round: row.round_no,
      scopeVersionId: row.scope_version_id,
      deliveryVersion: row.delivery_version,
      status: row.status,
      deliveryNotes: row.delivery_notes,
      submittedBy: row.submitted_by,
      submittedAt: row.submitted_at,
      completedBy: row.completed_by,
      completedAt: row.completed_at,
      customerConfirmation: confirmation ? {
        confirmedByName: confirmation.confirmed_by_name,
        confirmedByRole: confirmation.confirmed_by_role,
        confirmedAt: confirmation.confirmed_at,
        evidence: {
          id: 0,
          kind: confirmation.evidence_kind,
          sourceKind: confirmation.evidence_kind === "url" ? "external_url" : confirmation.evidence_kind === "file" ? "requirement_file" : "manual",
          sourceResourceId: null,
          label: confirmation.evidence_label,
          content: confirmation.evidence_content,
          url: confirmation.evidence_url,
          immutable: confirmation.evidence_kind !== "url",
          contentHash: confirmation.evidence_content_hash,
          mimeType: confirmation.evidence_mime_type,
          createdBy: confirmation.recorded_by,
          createdAt: confirmation.recorded_at,
        },
      } : null,
      evidence: evidence.map((item) => ({
        id: item.id,
        kind: item.kind,
        sourceKind: item.source_kind,
        sourceResourceId: item.source_resource_id,
        label: item.label,
        content: item.content,
        url: item.url,
        immutable: Boolean(item.immutable),
        contentHash: item.content_hash,
        mimeType: item.mime_type,
        createdBy: item.created_by,
        createdAt: item.created_at,
      })),
      items: items.map((item) => ({
        id: item.scope_item_id,
        scopeItemId: item.scope_item_id,
        requirementId: item.requirement_id,
        requirementNo: item.requirement_no,
        requirementName: item.requirement_name,
        acceptanceCriteria: item.acceptance_criteria,
        result: item.result,
        reason: item.reason ?? "",
        issueId: item.issue_id,
        issueVersion: item.issue_version,
        recordedBy: item.recorded_by,
        recordedAt: item.recorded_at,
      })),
    };
  }

  private submitAcceptanceInTransaction(
    deliveryId: number,
    data: AcceptanceSubmissionParsed,
  ): AcceptanceRound {
    const row = this.row(deliveryId);
    if (!row) throw new DomainError("NOT_FOUND", "交付不存在", 404);
    const access = assertProjectAccess(this.db, row.project_id, "read", false);
    this.assertProjectWritable(access.project);
    assertProjectVersion(row.version, data.expectedVersion, this.detail(row));
    if (row.current_scope_version_id !== data.scopeVersionId)
      throw new DomainError("STALE_SCOPE", "验收提交必须使用当前范围版本", 409);
    if (row.status === "awaiting_acceptance")
      throw new DomainError("ACCEPTANCE_PENDING", "当前交付已有待验收轮次", 409);
    if (row.status !== "active")
      throw new DomainError("DELIVERY_NOT_READY", "请先确认交付范围后再提交验收", 409);

    const scopeItems = this.db
      .prepare(
        "SELECT id,requirement_id,requirement_no,requirement_name,acceptance_criteria FROM delivery_scope_items WHERE scope_version_id=? ORDER BY id",
      )
      .all(data.scopeVersionId) as {
      id: number;
      requirement_id: number;
      requirement_no: string;
      requirement_name: string;
      acceptance_criteria: string;
    }[];
    if (!scopeItems.length)
      throw new DomainError("EMPTY_SCOPE", "交付范围为空，无法提交验收", 409);
    if (!data.evidence.some((item) => item.kind !== "url"))
      throw new DomainError(
        "IMMUTABLE_EVIDENCE_REQUIRED",
        "至少需要一项文本或附件快照，外部链接不能单独作为验收证据",
        400,
      );

    const scopeRequirementIds = new Set(scopeItems.map((item) => item.requirement_id));
    const actor = access.actor;
    const timestamp = now();
    const roundNo =
      ((this.db
        .prepare(
          "SELECT MAX(round_no) AS round_no FROM delivery_acceptance_rounds WHERE delivery_id=?",
        )
        .get(deliveryId) as { round_no: number | null }).round_no ?? 0) + 1;
    const inserted = this.db
      .prepare(
        "INSERT INTO delivery_acceptance_rounds(delivery_id,scope_version_id,round_no,delivery_version,status,delivery_notes,submitted_by,submitted_at) VALUES(?,?,?,?, 'pending',?,?,?)",
      )
      .run(
        deliveryId,
        data.scopeVersionId,
        roundNo,
        row.version + 1,
        data.deliveryNotes,
        actor.id,
        timestamp,
      );
    const roundId = Number(inserted.lastInsertRowid);
    const insertEvidence = this.db.prepare(
      "INSERT INTO delivery_acceptance_evidence(round_id,kind,source_kind,source_resource_id,label,content,url,mime_type,snapshot_content,immutable,content_hash,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const item of data.evidence) {
      if (item.kind === "url") {
        insertEvidence.run(
          roundId,
          item.kind,
          "external_url",
          null,
          item.label,
          null,
          item.url,
          null,
          null,
          0,
          null,
          actor.id,
          timestamp,
        );
        continue;
      }
      let content: string | null = null;
      let snapshot: Buffer;
      let mimeType: string;
      let sourceResourceId: number | null = null;
      let sourceKind: AcceptanceEvidence["sourceKind"] = "manual";
      if (item.kind === "text") {
        content = normalizeEvidenceText(item.content);
        snapshot = Buffer.from(content, "utf8");
        mimeType = "text/plain; charset=utf-8";
      } else {
        const source = this.db
          .prepare("SELECT requirement_id,resource_type FROM requirement_files WHERE id=? AND is_deleted=0")
          .get(item.sourceResourceId) as
          | { requirement_id: number; resource_type: string }
          | undefined;
        if (!source || !scopeRequirementIds.has(source.requirement_id))
          throw new DomainError(
            "INVALID_EVIDENCE_FILE",
            "验收附件必须来自当前范围内的需求",
            400,
          );
        if (!this.files)
          throw new DomainError(
            "EVIDENCE_UNAVAILABLE",
            "当前服务未配置受保护的需求附件读取器",
            500,
          );
        if (source.resource_type === "text") {
          const result = this.files.content(source.requirement_id, item.sourceResourceId);
          snapshot = Buffer.from(result.content, "utf8");
          mimeType = result.file.mimeType ?? "text/plain; charset=utf-8";
        } else {
          const result = this.files.raw(source.requirement_id, item.sourceResourceId);
          snapshot = Buffer.from(result.data);
          mimeType = result.mime;
        }
        sourceResourceId = item.sourceResourceId;
        sourceKind = "requirement_file";
      }
      insertEvidence.run(
        roundId,
        item.kind,
        sourceKind,
        sourceResourceId,
        item.label,
        content,
        null,
        mimeType,
        snapshot,
        1,
        createHash("sha256").update(snapshot).digest("hex"),
        actor.id,
        timestamp,
      );
    }
    if (data.customerConfirmation) {
      const confirmation = data.customerConfirmation;
      const snapshot = this.snapshotEvidence(confirmation.evidence, scopeRequirementIds, actor.id, timestamp);
      this.db.prepare("INSERT INTO delivery_acceptance_customer_confirmations(round_id,confirmed_by_name,confirmed_by_role,confirmed_at,evidence_kind,evidence_label,evidence_content,evidence_url,evidence_mime_type,evidence_snapshot_content,evidence_content_hash,recorded_by,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(roundId, confirmation.confirmedByName, confirmation.confirmedByRole, confirmation.confirmedAt, snapshot.kind, snapshot.label, snapshot.content, snapshot.url, snapshot.mimeType, snapshot.snapshot, snapshot.contentHash, actor.id, timestamp);
    }
    const deliveryUpdate = this.db
      .prepare("UPDATE deliveries SET status='awaiting_acceptance',version=version+1,updated_at=? WHERE id=? AND version=?")
      .run(timestamp, deliveryId, row.version);
    if (deliveryUpdate.changes !== 1)
      throw new DomainError("VERSION_CONFLICT", "交付已被其他成员更新，请刷新后重试", 409);
    this.db
      .prepare(
        "INSERT INTO project_events(project_id,action,actor_user_id,actor_name_snapshot,payload,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        row.project_id,
        "delivery_acceptance_submitted",
        actor.id,
        actor.display_name || actor.username,
        JSON.stringify({ deliveryId, round: roundNo, scopeVersionId: data.scopeVersionId }),
        timestamp,
      );
    const round = this.acceptanceRow(roundId);
    if (!round) throw new DomainError("NOT_FOUND", "验收轮次不存在", 404);
    return this.acceptanceRoundDetail(round);
  }

  private recordAcceptanceResultsInTransaction(
    roundId: number,
    data: AcceptanceResultsParsed,
  ): AcceptanceRound {
    const round = this.acceptanceRow(roundId);
    if (!round) throw new DomainError("NOT_FOUND", "验收轮次不存在", 404);
    if (round.status === "superseded")
      throw new DomainError("ACCEPTANCE_SUPERSEDED", "该验收轮次已因范围修订失效", 409);
    if (round.status !== "pending")
      throw new DomainError("ACCEPTANCE_ALREADY_COMPLETED", "该验收轮次已完成", 409);
    if (round.scope_version_id !== data.scopeVersionId)
      throw new DomainError("STALE_SCOPE", "验收结果必须匹配提交时的范围版本", 409);
    const delivery = this.row(round.delivery_id);
    if (!delivery) throw new DomainError("NOT_FOUND", "交付不存在", 404);
    if (delivery.current_scope_version_id !== round.scope_version_id)
      throw new DomainError("ACCEPTANCE_SUPERSEDED", "该验收轮次已因范围修订失效", 409);
    const access = assertProjectAccess(this.db, delivery.project_id, "read", false);
    assertProjectVersion(delivery.version, data.expectedVersion, this.detail(delivery));
    this.assertProjectWritable(access.project);
    if (delivery.acceptance_owner_user_id !== access.actor.id)
      throw new DomainError("FORBIDDEN", "只有指定验收人可以记录验收结果", 403);
    if (!access.roles.some((role) => role !== "viewer"))
      throw new DomainError("FORBIDDEN", "指定验收人必须是当前项目的可操作成员", 403);
    // The round keeps its submission version for audit; blocker changes use the
    // current delivery CAS above without changing the immutable scope snapshot.
    const items = this.db
      .prepare("SELECT id,requirement_id,requirement_no,requirement_name,acceptance_criteria FROM delivery_scope_items WHERE scope_version_id=? ORDER BY id")
      .all(round.scope_version_id) as {
      id: number;
      requirement_id: number;
      requirement_no: string;
      requirement_name: string;
      acceptance_criteria: string;
    }[];
    const resultMap = new Map(data.results.map((item) => [item.scopeItemId, item]));
    if (resultMap.size !== items.length || items.some((item) => !resultMap.has(item.id)))
      throw new DomainError(
        "ACCEPTANCE_RESULTS_INCOMPLETE",
        "每项当前范围需求都必须且只能记录一个验收结果",
        400,
      );
    const timestamp = now();
    const insert = this.db.prepare(
      "INSERT INTO delivery_acceptance_items(round_id,scope_item_id,requirement_id,requirement_no,requirement_name,acceptance_criteria,result,reason,issue_id,issue_version,recorded_by,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const item of items) {
      const result = resultMap.get(item.id)!;
      let issueVersion: number | null = null;
      if (result.issueId !== null) {
        if (result.result !== "failed")
          throw new DomainError("INVALID_ISSUE", "验收通过项不能关联问题", 400);
        const issue = this.db.prepare("SELECT i.version,r.project_id FROM issues i JOIN requirements r ON r.id=i.requirement_id WHERE i.id=? AND i.requirement_id=? AND i.is_deleted=0 AND r.deleted_at IS NULL")
          .get(result.issueId, item.requirement_id) as { version:number; project_id:number|null } | undefined;
        if (!issue || issue.project_id !== delivery.project_id)
          throw new DomainError("INVALID_ISSUE", "验收问题必须关联同一项目、同一范围需求中的有效问题", 400);
        issueVersion = issue.version;
      }
      insert.run(
        roundId,
        item.id,
        item.requirement_id,
        item.requirement_no,
        item.requirement_name,
        item.acceptance_criteria,
        result.result,
        result.reason,
        result.issueId,
        issueVersion,
        access.actor.id,
        timestamp,
      );
    }
    const status: AcceptanceRound["status"] = data.results.some(
      (item) => item.result === "failed",
    )
      ? "failed"
      : "passed";
    this.db
      .prepare("UPDATE delivery_acceptance_rounds SET status=?,completed_by=?,completed_at=? WHERE id=? AND status='pending'")
      .run(status, access.actor.id, timestamp, roundId);
    const deliveryUpdate = this.db
      .prepare("UPDATE deliveries SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?")
      .run(status === "passed" ? "accepted" : "active", timestamp, delivery.id, delivery.version);
    if (deliveryUpdate.changes !== 1)
      throw new DomainError("VERSION_CONFLICT", "交付已被其他成员更新，请刷新后重试", 409);
    this.db
      .prepare(
        "INSERT INTO project_events(project_id,action,actor_user_id,actor_name_snapshot,payload,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        delivery.project_id,
        "delivery_acceptance_recorded",
        access.actor.id,
        access.actor.display_name || access.actor.username,
        JSON.stringify({ deliveryId: delivery.id, round: round.round_no, status }),
        timestamp,
      );
    const completed = this.acceptanceRow(roundId);
    if (!completed) throw new DomainError("NOT_FOUND", "验收轮次不存在", 404);
    return this.acceptanceRoundDetail(completed);
  }

  private acceptanceCommand(
    command: string,
    projectId: number,
    input: unknown,
    key: string | undefined,
    fn: () => AcceptanceRound,
  ): AcceptanceRound {
    return this.db.transaction(() => {
      const actor = currentActor(this.db);
      assertProjectAccess(this.db, projectId, "read", true);
      const normalizedKey = key ?? randomUUID();
      if (!normalizedKey.trim() || normalizedKey.length > 200)
        throw new DomainError("VALIDATION_ERROR", "幂等键格式不正确", 400);
      const requestHash = hash({ projectId, input });
      const existing = this.db
        .prepare(
          "SELECT request_hash,response FROM project_commands WHERE actor_user_id=? AND command=? AND idempotency_key=?",
        )
        .get(actor.id, command, normalizedKey) as
        | { request_hash: string; response: string }
        | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new DomainError("IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同请求", 409);
        const parsed = JSON.parse(existing.response) as { acceptanceRoundId: number };
        const row = this.acceptanceRow(parsed.acceptanceRoundId);
        if (!row) throw new DomainError("NOT_FOUND", "验收轮次不存在", 404);
        return this.acceptanceRoundDetail(row);
      }
      const slot = this.db
        .prepare("INSERT INTO project_commands(project_id,actor_user_id,command,idempotency_key,request_hash,created_at) VALUES(?,?,?,?,?,?)")
        .run(projectId, actor.id, command, normalizedKey, requestHash, now());
      const result = fn();
      this.db
        .prepare("UPDATE project_commands SET response=? WHERE id=?")
        .run(JSON.stringify({ acceptanceRoundId: result.id }), slot.lastInsertRowid);
      return result;
    }).immediate();
  }

  private snapshotEvidence(
    item: AcceptanceSubmissionParsed["customerConfirmation"] extends infer T
      ? T extends { evidence: infer E }
        ? E
        : never
      : never,
    scopeRequirementIds: Set<number>,
    actorId: number,
    _timestamp: string,
  ) {
    if (item.kind === "url") {
      return {
        kind: item.kind,
        label: item.label,
        content: null,
        url: item.url,
        mimeType: null,
        snapshot: null,
        contentHash: null,
      };
    }
    if (item.kind === "text") {
      const content = normalizeEvidenceText(item.content);
      const snapshot = Buffer.from(content, "utf8");
      return {
        kind: item.kind,
        label: item.label,
        content,
        url: null,
        mimeType: "text/plain; charset=utf-8",
        snapshot,
        contentHash: createHash("sha256").update(snapshot).digest("hex"),
      };
    }
    const source = this.db
      .prepare("SELECT requirement_id,resource_type FROM requirement_files WHERE id=? AND is_deleted=0")
      .get(item.sourceResourceId) as { requirement_id:number; resource_type:string } | undefined;
    if (!source || !scopeRequirementIds.has(source.requirement_id))
      throw new DomainError("INVALID_EVIDENCE_FILE", "客户确认附件必须来自当前范围内的需求", 400);
    if (!this.files)
      throw new DomainError("EVIDENCE_UNAVAILABLE", "当前服务未配置受保护的需求附件读取器", 500);
    let snapshot: Buffer;
    let mimeType: string;
    if (source.resource_type === "text") {
      const result = this.files.content(source.requirement_id, item.sourceResourceId);
      snapshot = Buffer.from(result.content, "utf8");
      mimeType = result.file.mimeType ?? "text/plain; charset=utf-8";
    } else {
      const result = this.files.raw(source.requirement_id, item.sourceResourceId);
      snapshot = Buffer.from(result.data);
      mimeType = result.mime;
    }
    void actorId;
    return {
      kind: item.kind,
      label: item.label,
      content: null,
      url: null,
      mimeType,
      snapshot,
      contentHash: createHash("sha256").update(snapshot).digest("hex"),
    };
  }

  private blockingIssueDetail(blockingIssueId: number): DeliveryBlockingIssue {
    const row = this.db.prepare("SELECT b.*,d.version AS delivery_version,ra.id AS risk_id,ra.issue_version AS risk_issue_version,ra.reason AS risk_reason,ra.evidence_kind AS risk_evidence_kind,ra.evidence_label AS risk_evidence_label,ra.evidence_content AS risk_evidence_content,ra.evidence_url AS risk_evidence_url,ra.evidence_mime_type AS risk_evidence_mime_type,ra.evidence_content_hash AS risk_evidence_content_hash,ra.accepted_by AS risk_accepted_by,ra.accepted_at AS risk_accepted_at FROM delivery_blocking_issues b JOIN deliveries d ON d.id=b.delivery_id LEFT JOIN delivery_risk_acceptances ra ON ra.blocking_issue_id=b.id WHERE b.id=?")
      .get(blockingIssueId) as { id:number; delivery_id:number; issue_id:number; issue_version:number; impact:string; created_by:number; created_at:string; resolved_at:string|null; delivery_version:number; risk_id:number|null; risk_issue_version:number|null; risk_reason:string|null; risk_evidence_kind:AcceptanceEvidence["kind"]|null; risk_evidence_label:string|null; risk_evidence_content:string|null; risk_evidence_url:string|null; risk_evidence_mime_type:string|null; risk_evidence_content_hash:string|null; risk_accepted_by:number|null; risk_accepted_at:string|null } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "交付阻断问题不存在", 404);
    return {
      id: row.id,
      version: row.delivery_version,
      deliveryId: row.delivery_id,
      issueId: row.issue_id,
      issueVersion: row.issue_version,
      impact: row.impact,
      createdBy: row.created_by,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      riskAcceptance: row.risk_id === null ? null : {
        id: row.risk_id,
        blockingIssueId: row.id,
        issueVersion: row.risk_issue_version!,
        reason: row.risk_reason!,
        evidence: {
          id: row.risk_id,
          kind: row.risk_evidence_kind!,
          sourceKind: row.risk_evidence_kind === "url" ? "external_url" : row.risk_evidence_kind === "file" ? "requirement_file" : "manual",
          sourceResourceId: null,
          label: row.risk_evidence_label!,
          content: row.risk_evidence_content,
          url: row.risk_evidence_url,
          immutable: row.risk_evidence_kind !== "url",
          contentHash: row.risk_evidence_content_hash,
          mimeType: row.risk_evidence_mime_type,
          createdBy: row.risk_accepted_by!,
          createdAt: row.risk_accepted_at!,
        },
        acceptedBy: row.risk_accepted_by!,
        acceptedAt: row.risk_accepted_at!,
      },
    };
  }

  private insertRiskAcceptance(
    blocker: { id:number; issue_version:number },
    data: { reason:string; evidence: AcceptanceSubmissionParsed["evidence"][number] },
    actorId: number,
  ) {
    const timestamp = now();
    const source = this.db
      .prepare("SELECT i.requirement_id,r.project_id FROM delivery_blocking_issues b JOIN deliveries d ON d.id=b.delivery_id JOIN issues i ON i.id=b.issue_id JOIN requirements r ON r.id=i.requirement_id WHERE b.id=? AND i.is_deleted=0 AND r.deleted_at IS NULL")
      .get(blocker.id) as { requirement_id: number; project_id: number | null } | undefined;
    if (!source || source.project_id === null)
      throw new DomainError("INVALID_ISSUE", "阻断问题已不属于当前项目", 409);
    const snapshot = this.snapshotEvidence(data.evidence as never, new Set([source.requirement_id]), actorId, timestamp);
    this.db.prepare("INSERT INTO delivery_risk_acceptances(blocking_issue_id,issue_version,reason,evidence_kind,evidence_label,evidence_content,evidence_url,evidence_mime_type,evidence_snapshot_content,evidence_content_hash,accepted_by,accepted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(blocker.id, blocker.issue_version, data.reason, snapshot.kind, snapshot.label, snapshot.content, snapshot.url, snapshot.mimeType, snapshot.snapshot, snapshot.contentHash, actorId, timestamp);
  }

  private runCommand<T>(
    command: string,
    projectId: number,
    input: unknown,
    key: string | undefined,
    fn: () => T,
  ): T {
    return this.db.transaction(() => {
      const actor = currentActor(this.db);
      const normalizedKey = key ?? randomUUID();
      if (!normalizedKey.trim() || normalizedKey.length > 200)
        throw new DomainError("VALIDATION_ERROR", "幂等键格式不正确", 400);
      const requestHash = hash({ projectId, input });
      assertProjectAccess(this.db, projectId, "read", true);
      const existing = this.db.prepare("SELECT request_hash,response FROM project_commands WHERE actor_user_id=? AND command=? AND idempotency_key=?")
        .get(actor.id, command, normalizedKey) as { request_hash:string; response:string } | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new DomainError("IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同请求", 409);
        return JSON.parse(existing.response) as T;
      }
      this.db.prepare("INSERT INTO project_commands(project_id,actor_user_id,command,idempotency_key,request_hash,created_at,response) VALUES(?,?,?,?,?,?,?)")
        .run(projectId, actor.id, command, normalizedKey, requestHash, now(), "{}");
      const result = fn();
      this.db
        .prepare("UPDATE project_commands SET response=? WHERE actor_user_id=? AND command=? AND idempotency_key=?")
        .run(JSON.stringify(result), actor.id, command, normalizedKey);
      return result;
    }).immediate();
  }

  private projectDetail(projectId: number): ProjectDetail {
    const project = this.db
      .prepare(
        "SELECT id,project_no AS projectNo,name,goal,scope_summary AS scopeSummary,customer_name AS customerName,customer_contact AS customerContact,planned_start_date AS plannedStartDate,target_delivery_date AS targetDeliveryDate,owner_user_id AS ownerUserId,product_owner_user_id AS productOwnerUserId,status,previous_status AS previousStatus,version,archived_at AS archivedAt,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt FROM projects WHERE id=?",
      )
      .get(projectId) as ProjectDetail["project"] | undefined;
    if (!project) throw new DomainError("NOT_FOUND", "项目不存在", 404);
    const members = this.db
      .prepare(
        "SELECT m.project_id AS projectId,m.user_id AS userId,u.username,u.display_name AS displayName,m.status,u.status AS accountStatus,m.joined_at AS joinedAt,m.removed_at AS removedAt,group_concat(r.role) AS roles FROM project_members m JOIN users u ON u.id=m.user_id LEFT JOIN project_member_roles r ON r.project_id=m.project_id AND r.user_id=m.user_id WHERE m.project_id=? AND m.status='active' GROUP BY m.project_id,m.user_id ORDER BY m.joined_at,m.user_id",
      )
      .all(projectId) as Array<ProjectDetail["members"][number] & { roles: string | null }>;
    const roles = projectRolesFor(this.db, projectId, currentActor(this.db).id);
    const readonly = Boolean(project.archivedAt) || ["closed", "cancelled"].includes(project.status);
    return {
      project,
      members: members.map((member) => ({
        ...member,
        roles: (member.roles?.split(",") ?? []) as ProjectDetail["members"][number]["roles"],
      })),
      capabilities: capabilitiesFor(roles, readonly),
    };
  }

  private scopeDetail(row: ScopeVersionRow): DeliveryScopeVersion {
    const items = this.db
      .prepare(
        "SELECT id,scope_version_id,requirement_id,requirement_no,requirement_name,description,description_html,acceptance_criteria,requirement_version FROM delivery_scope_items WHERE scope_version_id=? ORDER BY id",
      )
      .all(row.id) as {
      id: number;
      scope_version_id: number;
      requirement_id: number;
      requirement_no: string;
      requirement_name: string;
      description: string;
      description_html: string;
      acceptance_criteria: string;
      requirement_version: number;
    }[];
    const changes = this.db
      .prepare(
        "SELECT id,change_type,requirement_id,reason,follow_up_delivery_id,follow_up_owner_user_id,follow_up_date,created_by,created_at FROM delivery_scope_changes WHERE scope_version_id=? ORDER BY id",
      )
      .all(row.id) as {
      id: number;
      change_type: DeliveryScopeChangeParsed["type"];
      requirement_id: number;
      reason: string;
      follow_up_delivery_id: number | null;
      follow_up_owner_user_id: number | null;
      follow_up_date: string | null;
      created_by: number;
      created_at: string;
    }[];
    return {
      id: row.id,
      deliveryId: row.delivery_id,
      version: row.scope_version,
      confirmedBy: row.confirmed_by,
      confirmedAt: row.confirmed_at,
      changeReason: row.change_reason,
      items: items.map((item): DeliveryScopeItem => ({
        id: item.id,
        scopeVersionId: item.scope_version_id,
        requirementId: item.requirement_id,
        requirementNo: item.requirement_no,
        requirementName: item.requirement_name,
        description: item.description,
        descriptionHtml: item.description_html,
        acceptanceCriteria: item.acceptance_criteria,
        requirementVersion: item.requirement_version,
      })),
      changes: changes.map((change) => ({
        id: change.id,
        type: change.change_type,
        requirementId: change.requirement_id,
        reason: change.reason,
        followUpDeliveryId: change.follow_up_delivery_id,
        followUpOwnerUserId: change.follow_up_owner_user_id,
        followUpDate: change.follow_up_date,
        createdBy: change.created_by,
        createdAt: change.created_at,
      })),
    };
  }

  private row(deliveryId: number) {
    return this.db
      .prepare("SELECT * FROM deliveries WHERE id=?")
      .get(deliveryId) as DeliveryRow | undefined;
  }

  private assertMember(projectId: number, userId: number | null | undefined) {
    if (userId === null || userId === undefined) return;
    const member = this.db
      .prepare(
        "SELECT 1 FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? AND m.user_id=? AND m.status='active' AND u.status='active' LIMIT 1",
      )
      .get(projectId, userId);
    if (!member)
      throw new DomainError("INVALID_MEMBER", "验收人或跟进责任人不是当前项目成员", 400);
  }

  private assertProjectWritable(project: { status: string; archived_at: string | null }) {
    if (
      project.archived_at ||
      ["closed", "cancelled", "paused"].includes(project.status)
    )
      throw new DomainError("PROJECT_READ_ONLY", "项目当前为只读或暂停状态", 409);
  }

  private command(
    command: string,
    projectId: number,
    input: unknown,
    key: string | undefined,
    fn: () => Delivery,
  ): Delivery {
    return this.db.transaction(() => {
      const actor = currentActor(this.db);
      assertProjectAccess(this.db, projectId, "read", true);
      const normalizedKey = key ?? randomUUID();
      if (!normalizedKey.trim() || normalizedKey.length > 200)
        throw new DomainError("VALIDATION_ERROR", "幂等键格式不正确", 400);
      const requestHash = hash({ projectId, input });
      const existing = this.db
        .prepare(
          "SELECT id,project_id,request_hash,response FROM project_commands WHERE actor_user_id=? AND command=? AND idempotency_key=?",
        )
        .get(actor.id, command, normalizedKey) as
        | { id: number; project_id: number | null; request_hash: string; response: string }
        | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new DomainError("IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同请求", 409);
        const parsed = JSON.parse(existing.response) as { deliveryId: number };
        return this.get(parsed.deliveryId);
      }
      const slot = this.db
        .prepare(
          "INSERT INTO project_commands(project_id,actor_user_id,command,idempotency_key,request_hash,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(projectId, actor.id, command, normalizedKey, requestHash, now());
      const result = fn();
      this.db
        .prepare("UPDATE project_commands SET response=? WHERE id=?")
        .run(JSON.stringify({ deliveryId: result.id }), slot.lastInsertRowid);
      return result;
    }).immediate();
  }
}
