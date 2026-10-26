import { reactive } from "vue";

// 功能页签 store：沿用 auth.ts 的 reactive 单例先例（项目未引入 pinia，禁新增依赖）。
// 页签 key 取路由 path；页签不预置——左侧菜单/路由进入某功能后对应页签才出现，
// 全部页签均可关闭；需求详情按访问动态开签，加载完成后由详情页回填「编号 · 名称」文案。
export interface WorkTab {
  key: string; // 页签唯一键（= 路由 path）
  path: string; // 点击页签跳转的路由路径
  label: string; // 页签文案（详情页加载完成后回填「编号 · 名称」/ 会议标题）
  requirementId?: number; // 需求详情页签关联的需求 id
  meetingId?: number; // 会议详情页签关联的会议 id
}

// 菜单功能路由 → 页签文案：首次进入对应功能后开出页签
const FEATURE_TAB_LABELS: Record<string, string> = {
  "/requirements": "需求列表",
  "/meetings": "会议记录",
  "/meetings/new": "新建会议",
  "/tasks": "每日任务",
  "/online-tools": "在线工具",
  "/notifications": "系统通知",
  "/settings": "系统设置",
};

export const tabsStore = reactive<{
  tabs: WorkTab[];
  activePath: string;
}>({ tabs: [], activePath: "" });

// 详情路由 → 实体 id（非详情路径返回 null）
function detailId(path: string): {
  kind: "requirement" | "meeting";
  id: number;
} | null {
  const requirement = /^\/requirements\/(\d+)$/.exec(path);
  if (requirement) return { kind: "requirement", id: Number(requirement[1]) };
  const meeting = /^\/meetings\/(\d+)$/.exec(path);
  if (meeting) return { kind: "meeting", id: Number(meeting[1]) };
  return null;
}

// 路由联动：每次路由变化调用。激活对应页签；页签不存在时新增
//（功能页签取菜单文案；详情页未加载前先以「需求 #id / 会议 #id」占位，加载完成后回填真实文案）
export function syncRoute(path: string) {
  tabsStore.activePath = path;
  if (tabsStore.tabs.some((tab) => tab.path === path)) return;
  const detail = detailId(path);
  if (detail?.kind === "requirement") {
    tabsStore.tabs.push({
      key: path,
      path,
      label: `需求 #${detail.id}`,
      requirementId: detail.id,
    });
    return;
  }
  if (detail?.kind === "meeting") {
    tabsStore.tabs.push({
      key: path,
      path,
      label: `会议 #${detail.id}`,
      meetingId: detail.id,
    });
    return;
  }
  const label = FEATURE_TAB_LABELS[path];
  if (label) tabsStore.tabs.push({ key: path, path, label });
}

// 回填/刷新页签文案：详情页 load 完成与保存改名后调用
export function setTabLabel(path: string, label: string) {
  const tab = tabsStore.tabs.find((item) => item.path === path);
  if (tab) tab.label = label;
}

// 关闭页签。若关的是激活页签，返回应跳转的路径
//（右侧第一个 → 左侧第一个 → 兜底「需求列表」路由，路由联动会重新开出首页页签）；
// 关非激活页签返回 null（路由不变）
export function closeTab(key: string): string | null {
  const index = tabsStore.tabs.findIndex((tab) => tab.key === key);
  if (index < 0) return null;
  const wasActive = tabsStore.activePath === key;
  tabsStore.tabs.splice(index, 1);
  if (!wasActive) return null;
  const next = tabsStore.tabs[index] ?? tabsStore.tabs[index - 1];
  const target = next ? next.path : "/requirements";
  tabsStore.activePath = target;
  return target;
}

// 移除页签但不触发跳转（保存新建后由调用方决定去向）
export function removeTab(key: string) {
  const index = tabsStore.tabs.findIndex((tab) => tab.key === key);
  if (index < 0) return;
  tabsStore.tabs.splice(index, 1);
  if (tabsStore.activePath === key) tabsStore.activePath = "";
}

// 关闭其他页签（仅保留指定页签）；激活页签被关时返回跳转路径
export function closeOtherTabs(key: string): string | null {
  tabsStore.tabs = tabsStore.tabs.filter((tab) => tab.key === key);
  if (tabsStore.tabs.some((tab) => tab.path === tabsStore.activePath)) {
    return null;
  }
  tabsStore.activePath = key;
  return key;
}

// 退出登录/进入公开页（登录页）时清空全部页签，之后进入功能按需重开
export function clearTabs() {
  tabsStore.tabs = [];
  tabsStore.activePath = "";
}
