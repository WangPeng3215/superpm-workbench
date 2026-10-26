import { mergeAttributes, Node } from "@tiptap/core";
import { requirementApi } from "../../api/requirements";

export interface RequirementRefInput {
  id: number;
  name: string;
  requirementNo?: string;
}

interface RequirementRefAttributes {
  requirementId: number | null;
  requirementName: string;
  requirementCode: string;
  requirementMissing: boolean;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    requirementRef: {
      insertRequirementRef: (input: RequirementRefInput) => ReturnType;
    };
  }
}

function displayLabel(attributes: RequirementRefAttributes): string {
  const name = attributes.requirementName || "需求";
  return attributes.requirementCode
    ? `${attributes.requirementCode} · ${name}`
    : name;
}

export const RequirementRef = Node.create({
  name: "requirementRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      requirementId: {
        default: null,
        parseHTML: (element) => {
          const id = Number(element.getAttribute("data-requirement-id"));
          return Number.isInteger(id) && id > 0 ? id : null;
        },
        renderHTML: (attributes) =>
          attributes.requirementId
            ? { "data-requirement-id": String(attributes.requirementId) }
            : {},
      },
      requirementName: {
        default: "",
        parseHTML: (element) =>
          element.getAttribute("data-requirement-name") ?? "",
        renderHTML: (attributes) => ({
          "data-requirement-name": attributes.requirementName,
        }),
      },
      requirementCode: {
        default: "",
        parseHTML: (element) =>
          element.getAttribute("data-requirement-code") ?? "",
        renderHTML: (attributes) => ({
          "data-requirement-code": attributes.requirementCode,
        }),
      },
      requirementMissing: {
        default: false,
        parseHTML: (element) =>
          element.getAttribute("data-requirement-missing") === "true",
        renderHTML: (attributes) =>
          attributes.requirementMissing
            ? { "data-requirement-missing": "true" }
            : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-requirement-id]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const attributes = node.attrs as RequirementRefAttributes;
    const missing = attributes.requirementMissing;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: missing ? "requirement-ref is-missing" : "requirement-ref",
        title: missing ? "该需求已删除或无法访问" : displayLabel(attributes),
      }),
      displayLabel(attributes),
    ];
  },
  renderText({ node }) {
    const attributes = node.attrs as RequirementRefAttributes;
    return attributes.requirementName || "需求";
  },
  addCommands() {
    return {
      insertRequirementRef:
        (input: RequirementRefInput) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              requirementId: input.id,
              requirementName: input.name,
              requirementCode: input.requirementNo ?? "",
              requirementMissing: false,
            },
          }),
    };
  },
});

// 打开编辑器/详情时按 ID 解析最新名称；已删除的需求回退到保存时的名称并标记失效。
export async function resolveRequirementRefHtml(html: string): Promise<string> {
  if (!html || !html.includes("data-requirement-id")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const elements = Array.from(
    doc.querySelectorAll<HTMLElement>("[data-requirement-id]"),
  );
  const ids = [
    ...new Set(
      elements
        .map((element) => Number(element.dataset.requirementId))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!ids.length) return html;
  let states;
  try {
    states = await requirementApi.references(ids);
  } catch {
    return html;
  }
  const byId = new Map(states.map((state) => [state.id, state]));
  for (const element of elements) {
    const id = Number(element.dataset.requirementId);
    const state = byId.get(id);
    if (state?.exists) {
      element.dataset.requirementName = state.name ?? "";
      element.dataset.requirementCode = state.requirementNo ?? "";
      element.removeAttribute("data-requirement-missing");
      element.classList.remove("is-missing");
      element.textContent = state.requirementNo
        ? `${state.requirementNo} · ${state.name}`
        : (state.name ?? "");
      element.title = element.textContent;
      continue;
    }
    const storedName =
      element.dataset.requirementName?.trim() ||
      element.textContent?.trim() ||
      "已失效需求";
    element.dataset.requirementMissing = "true";
    element.classList.add("is-missing");
    element.textContent = storedName;
    element.title = "该需求已删除或无法访问";
  }
  return doc.body.innerHTML;
}
