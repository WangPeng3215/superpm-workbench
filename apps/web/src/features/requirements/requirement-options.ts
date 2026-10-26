import type { Requirement } from "@superpm/shared";
import { requirementApi } from "../../api/requirements";

export interface RequirementOption {
  id: number;
  requirementNo: string;
  name: string;
  depth: number;
  label: string;
}

type OptionSource = Requirement & { children?: OptionSource[] };

export function flattenRequirementOptions(
  items: OptionSource[],
  depth = 0,
  out: RequirementOption[] = [],
): RequirementOption[] {
  for (const item of items) {
    out.push({
      id: item.id,
      requirementNo: item.requirementNo,
      name: item.name,
      depth,
      label: `${item.requirementNo} · ${item.name}`,
    });
    if (item.children?.length)
      flattenRequirementOptions(item.children, depth + 1, out);
  }
  return out;
}

export async function searchRequirementOptions(
  query = "",
): Promise<RequirementOption[]> {
  const result = await requirementApi.list({
    q: query,
    page: 1,
    pageSize: 50,
    sortBy: "updatedAt",
    sortOrder: "desc",
  });
  return flattenRequirementOptions(result.items);
}
