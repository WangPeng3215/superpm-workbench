import { z } from "zod";

const textNode = z.object({ type: z.literal("text"), text: z.string() });
const paragraph = z.object({
  type: z.literal("paragraph"),
  content: z.array(textNode).optional(),
});
const document = z.object({
  type: z.literal("doc"),
  content: z.array(paragraph),
});

/** Plain-text editing is the first UI; persisted content can later use Tiptap. */
export function encodeDescription(text: string) {
  return JSON.stringify({
    type: "doc",
    content: text
      .split("\n")
      .map((line) =>
        line
          ? { type: "paragraph", content: [{ type: "text", text: line }] }
          : { type: "paragraph" },
      ),
  });
}
export function decodeDescription(stored: string) {
  try {
    const parsed = document.safeParse(JSON.parse(stored));
    if (!parsed.success) return stored;
    return parsed.data.content
      .map((node) => (node.content ?? []).map((child) => child.text).join(""))
      .join("\n");
  } catch {
    return stored;
  }
}
