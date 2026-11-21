import type Database from "better-sqlite3";
import { assertProjectAccess } from "./project-access.js";
import type { DailyTaskService } from "./daily-tasks.js";
import { DomainError } from "./domain-error.js";

interface WorklogRow {
  id: number;
  user_id: number;
  task_id: number;
  project_id: number;
  project_task_id: number;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  status: "active" | "completed";
  title: string;
  assignee_user_id: number;
  assignee_name: string;
  worker_user_id: number;
  worker_name: string;
}

export interface ProjectWorklogItem {
  projectTaskId: number;
  title: string;
  assigneeUserId: number;
  assigneeName: string;
  workerUserId: number;
  workerName: string;
  totalSeconds: number;
}

export interface ProjectWorklog {
  totalSeconds: number;
  items: ProjectWorklogItem[];
}

/** Project rollups use only the immutable project/task source snapshots on time entries. */
export class ProjectWorklogService {
  constructor(
    private readonly db: Database.Database,
    private readonly dailyTasks: DailyTaskService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(projectId: number): ProjectWorklog {
    if (!Number.isSafeInteger(projectId) || projectId < 1)
      throw new DomainError("NOT_FOUND", "项目不存在", 404);
    assertProjectAccess(this.db, projectId, "read", true);

    const rows = this.db
      .prepare(
        `SELECT e.id, e.user_id, e.task_id, e.project_id, e.project_task_id,
                e.started_at, e.ended_at, e.duration_seconds, e.status,
                t.title, t.assignee_user_id,
                COALESCE(NULLIF(u.display_name, ''), u.username) AS assignee_name,
                worker.id AS worker_user_id,
                COALESCE(NULLIF(worker.display_name, ''), worker.username) AS worker_name
         FROM daily_time_entries e
         JOIN project_tasks t ON t.id = e.project_task_id AND t.project_id = e.project_id
         JOIN users u ON u.id = t.assignee_user_id
         JOIN users worker ON worker.id = e.user_id
         WHERE e.project_id = ? AND e.project_task_id IS NOT NULL
         ORDER BY e.id`,
      )
      .all(projectId) as WorklogRow[];

    const items = new Map<string, ProjectWorklogItem>();
    const now = this.now();
    for (const row of rows) {
      const seconds = this.dailyTasks.worklogSeconds(row, now);
      if (seconds <= 0) continue;
      const key = `${row.project_task_id}:${row.worker_user_id}`;
      const item = items.get(key) ?? {
        projectTaskId: row.project_task_id,
        title: row.title,
        assigneeUserId: row.assignee_user_id,
        assigneeName: row.assignee_name,
        workerUserId: row.worker_user_id,
        workerName: row.worker_name,
        totalSeconds: 0,
      };
      item.totalSeconds += seconds;
      items.set(key, item);
    }
    const resultItems = [...items.values()].sort(
      (left, right) => left.projectTaskId - right.projectTaskId,
    );
    return {
      totalSeconds: resultItems.reduce(
        (sum, item) => sum + item.totalSeconds,
        0,
      ),
      items: resultItems,
    };
  }
}
