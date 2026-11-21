import { describe, expect, it } from "vitest";
import type { ProjectMember } from "@superpm/shared";
import { requirementResponsibilityMembers } from "../src/features/requirements/project-members";

const member = {
  projectId: 1,
  userId: 1,
  username: "owner",
  displayName: "项目负责人",
  roles: ["owner"],
  status: "active",
  accountStatus: "active",
  joinedAt: "2026-11-19",
  removedAt: null,
} satisfies ProjectMember;

describe("需求责任人选项", () => {
  it("只列出当前有效账号且具有非只读角色的有效成员", () => {
    const members: ProjectMember[] = [
      member,
      { ...member, userId: 2, roles: ["viewer"] },
      { ...member, userId: 3, roles: ["contributor"], status: "removed" },
      { ...member, userId: 4, accountStatus: "disabled" },
      { ...member, userId: 5, roles: ["viewer", "contributor"] },
      { ...member, userId: 6, roles: ["product_owner"] },
    ];
    expect(
      requirementResponsibilityMembers(members).map((m) => m.userId),
    ).toEqual([1, 5, 6]);
    expect(members).toHaveLength(6);
  });

  it("项目尚未加载时不给出旧的责任人选项", () => {
    expect(requirementResponsibilityMembers(undefined)).toEqual([]);
  });
});
