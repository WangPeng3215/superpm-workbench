import { reactive } from "vue";

/**
 * 会议编辑态记忆。
 *
 * 页签只记录路由 path（不含 `?edit=1`），切到别的页面再回来时 query 已丢失，
 * 编辑态会退回只读。这里按会议 id 记住编辑态，跨路由切换保留；
 * 点「完成」、删除会议或手动退出编辑时清除。
 *
 * 只存在内存里：刷新浏览器后以 URL 上的 `?edit=1` 为准，避免误判。
 */
const editingIds = reactive(new Set<number>());

export function markMeetingEditing(id: number) {
  editingIds.add(id);
}

export function clearMeetingEditing(id: number) {
  editingIds.delete(id);
}

export function isMeetingEditing(id: number): boolean {
  return editingIds.has(id);
}
