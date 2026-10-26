export type EnumField = "type" | "status" | "priority" | "currentStage";

const tones: Record<EnumField, Record<string, string>> = {
  type: {
    feature: "blue",
    improvement: "teal",
    bug: "red",
    refactor: "purple",
    other: "slate",
  },
  status: {
    not_started: "gray",
    in_progress: "blue",
    blocked: "red",
    paused: "amber",
    completed: "green",
    cancelled: "slate",
  },
  priority: { P0: "red", P1: "amber", P2: "blue", P3: "gray" },
  currentStage: {
    analysis: "purple",
    design: "teal",
    development: "blue",
    testing: "amber",
    online: "green",
  },
};

export function isEnumField(key: string): key is EnumField {
  return key in tones;
}

/** CSS class that colours a tag for the given enum field and value. */
export function tagTone(field: string, value: unknown): string {
  const group = (tones as Record<string, Record<string, string>>)[field];
  return `tone-${group?.[String(value ?? "")] ?? "gray"}`;
}
