import { noteCreateSchema, type Note } from "@superpm/shared";

export const noteEditableFields = [
  "title",
  "content",
  "type",
  "color",
  "isPinned",
] as const;
export type NoteValues = Pick<Note, (typeof noteEditableFields)[number]>;
export interface NoteDraft {
  id: number;
  createdAt: string;
  base: NoteValues;
  values: NoteValues;
}

const prefix = "superpm.note-draft.v1.";
export const noteDraftKey = (accountId: number, noteId: number) =>
  prefix + accountId + "." + noteId;

export function noteValues(note: Note): NoteValues {
  return {
    title: note.title,
    content: note.content,
    type: note.type,
    color: note.color,
    isPinned: note.isPinned,
  };
}

export function readNoteDraft(
  storage: Pick<Storage, "getItem">,
  key: string,
): NoteDraft | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const draft = value as Partial<NoteDraft>;
  if (
    !Number.isSafeInteger(draft.id) ||
    draft.id === 0 ||
    typeof draft.createdAt !== "string" ||
    !Number.isFinite(Date.parse(draft.createdAt))
  )
    return null;
  for (const values of [draft.base, draft.values]) {
    if (
      !values ||
      !noteEditableFields.every((field) => Object.hasOwn(values, field)) ||
      !noteCreateSchema.safeParse(values).success
    )
      return null;
  }
  return draft as NoteDraft;
}

/** Only call after a successful notes list authorized the current account. */
export function recoverNoteDrafts(
  storage: Pick<Storage, "length" | "key" | "getItem">,
  accountId: number,
): Note[] {
  const notes: Note[] = [];
  const accountPrefix = prefix + accountId + ".";
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(accountPrefix)) continue;
    const draft = readNoteDraft(storage, key);
    if (!draft || key !== noteDraftKey(accountId, draft.id)) continue;
    notes.push({
      ...draft.values,
      id: draft.id,
      isArchived: false,
      convertedTaskId: null,
      convertedTask: null,
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
      archivedAt: null,
    });
  }
  return notes;
}
