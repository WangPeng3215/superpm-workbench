import { ref } from "vue";

/** 数据根变更计数：设置页据此重新拉取系统信息。 */
export const dataRootRevision = ref(0);

export function notifyDataRootChanged() {
  dataRootRevision.value += 1;
}
