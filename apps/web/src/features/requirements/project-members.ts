import type { ProjectMember } from "@superpm/shared";

export function requirementResponsibilityMembers(
  members: readonly ProjectMember[] | undefined,
) {
  return (members ?? []).filter(
    (member) =>
      member.status === "active" &&
      member.accountStatus === "active" &&
      member.roles.some((role) => role !== "viewer"),
  );
}
