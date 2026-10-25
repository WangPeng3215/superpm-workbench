import { reactive } from "vue";
import type { OnlineTool } from "@superpm/shared";
import { onlineToolApi } from "../../api/online-tools";
import { errorMessage } from "../../api/client";

// 维护页与悬浮弹窗共用同一份快捷工具数据，避免两处长期不一致。
export const toolboxStore = reactive<{
  tools: OnlineTool[];
  loaded: boolean;
  loading: boolean;
  error: string;
}>({ tools: [], loaded: false, loading: false, error: "" });

export async function refreshToolbox() {
  if (toolboxStore.loading) return;
  toolboxStore.loading = true;
  toolboxStore.error = "";
  try {
    toolboxStore.tools = await onlineToolApi.favorites();
    toolboxStore.loaded = true;
  } catch (error) {
    toolboxStore.error = errorMessage(error);
  } finally {
    toolboxStore.loading = false;
  }
}
