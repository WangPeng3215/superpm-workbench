import {
  requirementCreateSchema,
  requirementUpdateSchema,
  requirementListSchema,
} from "@superpm/shared";
import type Database from "better-sqlite3";
import { RequirementsRepository } from "../repositories/requirements.js";

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export class RequirementService {
  private readonly repo: RequirementsRepository;
  constructor(private readonly db: Database.Database) {
    this.repo = new RequirementsRepository(db);
  }
  create(input: unknown) {
    const data = requirementCreateSchema.parse(input);
    return this.transaction(() => {
      this.checkParent(data.parentId);
      const item = this.repo.insert(data);
      this.repo.audit(item.id, "create", data);
      return item;
    });
  }
  get(id: number) {
    const item = this.repo.get(id);
    if (!item) throw new DomainError("NOT_FOUND", "需求不存在", 404);
    return item;
  }
  list(input: unknown) {
    return this.repo.list(requirementListSchema.parse(input));
  }
  update(id: number, input: unknown) {
    const parsed = requirementUpdateSchema.parse(input);
    const { stageNote, ...patch } = parsed;
    return this.transaction(() => {
      const existing = this.get(id);
      if (patch.parentId !== undefined) this.checkParent(patch.parentId, id);
      const updated = this.repo.update(id, patch);
      if (patch.currentStage && patch.currentStage !== existing.currentStage) {
        this.repo.addHistory({
          requirementId: id,
          fromStage: existing.currentStage,
          toStage: patch.currentStage,
          actor: "local-user",
          note: stageNote ?? "",
          createdAt: new Date().toISOString(),
        });
      }
      this.repo.audit(id, "update", parsed);
      return updated;
    });
  }
  remove(id: number) {
    this.transaction(() => {
      this.get(id);
      if (this.repo.children(id).length)
        throw new DomainError("CONFLICT", "存在有效子需求，无法删除", 409);
      this.repo.softDelete(id);
      this.repo.audit(id, "delete", {});
    });
  }
  history(id: number) {
    this.get(id);
    return this.repo.history(id);
  }
  private checkParent(parentId: number | null, id?: number) {
    if (parentId === null) return;
    const parent = this.get(parentId);
    if (
      parent.parentId !== null ||
      parent.id === id ||
      (id && this.repo.children(id).length)
    ) {
      throw new DomainError(
        "CONFLICT",
        "仅支持两级需求，父需求必须为主需求",
        409,
      );
    }
  }
  private transaction<T>(fn: () => T) {
    return this.db.transaction(fn).immediate();
  }
}
