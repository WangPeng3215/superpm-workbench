import { stages, type Stage } from "@superpm/shared";

export function stageTransitionNeedsNote(from: Stage, to: Stage) {
  return from !== to && stages.indexOf(to) !== stages.indexOf(from) + 1;
}
