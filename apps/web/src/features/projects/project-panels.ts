import type { ProjectOverview } from "@superpm/shared";
import type { ProjectEvent } from "../../api/projects.js";

export interface ProjectNavigationTarget {
  type: "project" | "requirement" | "task" | "delivery" | "document";
  id: number;
}

export interface ProjectRiskItem {
  key: string;
  title: string;
  detail?: string;
  target: ProjectNavigationTarget;
}

export function projectActionTarget(
  action: Pick<ProjectOverview["myActions"]["items"][number], "id" | "kind">,
): ProjectNavigationTarget {
  return { type: action.kind, id: action.id };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

export function projectEventTarget(
  event: Pick<ProjectEvent, "action" | "payload">,
): ProjectNavigationTarget | null {
  const payload = event.payload;
  if (!payload) return null;
  if (
    event.action.startsWith("requirement") ||
    event.action === "requirements_shared"
  ) {
    for (const key of ["requirementId", "rootRequirementId"]) {
      const id = positiveInteger(payload[key]);
      if (id) return { type: "requirement", id };
    }
  }
  if (
    event.action.startsWith("task") ||
    event.action.startsWith("project_task")
  ) {
    for (const key of ["taskId", "projectTaskId"]) {
      const id = positiveInteger(payload[key]);
      if (id) return { type: "task", id };
    }
  }
  if (
    event.action.startsWith("project_document_") ||
    event.action === "project_meeting_copied"
  ) {
    const documentId = positiveInteger(payload.documentId);
    if (documentId) return { type: "document", id: documentId };
  }
  if (event.action.startsWith("delivery")) {
    const deliveryId = positiveInteger(payload.deliveryId);
    if (deliveryId) return { type: "delivery", id: deliveryId };
  }
  return null;
}

const eventLabels: Record<string, string> = {
  project_created: "创建了项目",
  project_updated: "更新了项目信息",
  member_roles_updated: "调整了项目成员角色",
  member_removed: "移除了项目成员",
  project_leads_updated: "调整了项目负责人",
  project_start: "启动了项目",
  project_pause: "暂停了项目",
  project_resume: "恢复了项目",
  project_cancel: "取消了项目",
  project_reopen: "重新打开了项目",
  project_archived: "归档了项目",
  project_restored: "取消了项目归档",
  requirements_shared: "将需求加入项目",
  requirement_updated: "更新了项目需求",
  project_document_created: "新增了项目资料",
  project_document_updated: "更新了项目资料",
  project_document_deleted: "删除了项目资料",
  project_meeting_copied: "复制了项目会议纪要",
  delivery_scope_confirmed: "确认了交付范围",
};

export function projectEventLabel(event: Pick<ProjectEvent, "action">) {
  return eventLabels[event.action] ?? "项目发生更新";
}

export function projectRiskItems(overview: ProjectOverview): ProjectRiskItem[] {
  const items: ProjectRiskItem[] = [];
  if (overview.risks.items?.length) {
    const reasonLabels: Record<string, string> = {
      blocked: "阻塞",
      overdue: "逾期",
      failed_acceptance: "验收未通过",
      blocking_issue: "存在未接受的交付阻断问题",
      scope_follow_up: "延期或豁免缺少后续跟进",
    };
    for (const risk of overview.risks.items) {
      if (!positiveInteger(risk.id)) continue;
      items.push({
        key: risk.key,
        title: risk.title,
        detail: [...new Set(risk.reasons)]
          .map((reason) => reasonLabels[reason] ?? reason)
          .join(" · "),
        target: { type: risk.kind, id: risk.id },
      });
    }
    return items;
  }
  const seenTasks = new Set<number>();
  for (const id of overview.risks.blockedRequirements) {
    if (!positiveInteger(id)) continue;
    items.push({
      key: `requirement:${id}`,
      title: `阻塞需求 #${id}`,
      target: { type: "requirement", id },
    });
  }
  for (const id of overview.risks.blockedTasks) {
    if (!positiveInteger(id) || seenTasks.has(id)) continue;
    seenTasks.add(id);
    const overdue = overview.risks.overdueTasks.includes(id);
    items.push({
      key: `task:${id}`,
      title: overdue ? `阻塞且逾期任务 #${id}` : `阻塞任务 #${id}`,
      target: { type: "task", id },
    });
  }
  for (const id of overview.risks.overdueTasks) {
    if (!positiveInteger(id) || seenTasks.has(id)) continue;
    seenTasks.add(id);
    items.push({
      key: `task:${id}`,
      title: `逾期任务 #${id}`,
      target: { type: "task", id },
    });
  }
  for (const id of overview.risks.failedDeliveries ?? []) {
    if (!positiveInteger(id)) continue;
    items.push({
      key: `delivery:failed:${id}`,
      title: `验收未通过交付 #${id}`,
      target: { type: "delivery", id },
    });
  }
  for (const id of overview.risks.overdueDeliveries ?? []) {
    if (!positiveInteger(id)) continue;
    items.push({
      key: `delivery:overdue:${id}`,
      title: `逾期未验收交付 #${id}`,
      target: { type: "delivery", id },
    });
  }
  return items;
}

export function formatProjectEventTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
