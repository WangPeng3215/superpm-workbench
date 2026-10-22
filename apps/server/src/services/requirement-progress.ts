import type { RequirementProgress } from "@superpm/shared";
import { RequirementService } from "./requirements.js";
import { IssueService } from "./issues.js";
import { ArtifactService } from "./artifacts.js";
import { RequirementDirectoryResolver } from "./requirement-directory.js";

/**
 * 需求进度快照（M2 只读）：把需求本体、工作区状态、阶段历史、问题与产出物统计
 * 组合成一个只读视图。不新增数据表，也不写任何索引或目录。
 */
export class RequirementProgressService {
  constructor(
    private requirements: RequirementService,
    private issues: IssueService,
    private artifacts: ArtifactService,
    private directories: RequirementDirectoryResolver,
  ) {}

  get(requirementId: number): RequirementProgress {
    const requirement = this.requirements.get(requirementId);
    return {
      requirement,
      workspace: this.directories.stateReadOnly(requirementId),
      stageHistory: this.requirements.history(requirementId),
      issues: this.issues.stats(requirementId),
      artifacts: this.artifacts.stats(requirementId),
    };
  }
}
