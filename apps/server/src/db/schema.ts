import {
  integer,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import type { Requirement, Stage } from "@superpm/shared";
export const requirements = sqliteTable("requirements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requirementNo: text("requirement_no").notNull().unique(),
  name: text("name").notNull(),
  type: text("type").$type<Requirement["type"]>().notNull(),
  priority: text("priority").$type<Requirement["priority"]>().notNull(),
  description: text("description").notNull(),
  status: text("status").$type<Requirement["status"]>().notNull(),
  currentStage: text("current_stage").$type<Stage>().notNull(),
  parentId: integer("parent_id").references(
    (): AnySQLiteColumn => requirements.id,
  ),
  proposedAt: text("proposed_at").notNull(),
  expectedAt: text("expected_at"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  plannedReleaseAt: text("planned_release_at"),
  releasedAt: text("released_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
});
export const stageHistory = sqliteTable("requirement_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requirementId: integer("requirement_id")
    .notNull()
    .references(() => requirements.id),
  fromStage: text("from_stage").$type<Stage>().notNull(),
  toStage: text("to_stage").$type<Stage>().notNull(),
  actor: text("actor").notNull(),
  note: text("note").notNull(),
  createdAt: text("created_at").notNull(),
});
export const requirementAudit = sqliteTable("requirement_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requirementId: integer("requirement_id")
    .notNull()
    .references(() => requirements.id),
  action: text("action").notNull(),
  payload: text("payload").notNull(),
  createdAt: text("created_at").notNull(),
});
