import { reactive } from "vue";
import { authStore } from "./auth";

// 功能页签 store：沿用 auth.ts 的 reactive 单例先例（项目未引入 pinia，禁新增依赖）。
// 页签 key 取路由 path；页签不预置——左侧菜单/路由进入某功能后对应页签才出现，
// 全部页签均可关闭；需求详情按访问动态开签，加载完成后由详情页回填「编号 · 名称」文案。
export interface WorkTab {
  key: string; // 页签唯一键（= 路由 path）
  path: string; // 点击页签跳转的路由路径
  label: string; // 页签文案（详情页加载完成后回填「编号 · 名称」/ 会议标题）
  requirementId?: number; // 需求详情页签关联的需求 id
  meetingId?: number; // 会议详情页签关联的会议 id
  optimizationPointId?: number; // 优化点详情页签关联的优化点 id
  projectId?: number;
  pinned?: boolean; // 固定页签始终排在最左侧
}

const TAB_LAYOUT_KEY = "superpm.workbench.tab-layout.v1";
type TabLayout = {
  order: string[];
  pinned: string[];
  paths: string[];
  labels: Record<string, string>;
};

function layoutStorageKey() {
  const userId = authStore.user?.id;
  return userId == null ? null : `${TAB_LAYOUT_KEY}.${userId}`;
}

function readLayout(): TabLayout {
  try {
    const key = layoutStorageKey();
    if (!key) return { order: [], pinned: [], paths: [], labels: {} };
    const raw = localStorage.getItem(key);
    if (!raw) return { order: [], pinned: [], paths: [], labels: {} };
    const parsed = JSON.parse(raw) as Partial<TabLayout>;
    return {
      order: Array.isArray(parsed.order)
        ? parsed.order.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      pinned: Array.isArray(parsed.pinned)
        ? parsed.pinned.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      paths: Array.isArray(parsed.paths)
        ? parsed.paths.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      labels:
        parsed.labels && typeof parsed.labels === "object"
          ? (parsed.labels as Record<string, string>)
          : {},
    };
  } catch {
    return { order: [], pinned: [], paths: [], labels: {} };
  }
}

function persistLayout() {
  try {
    const key = layoutStorageKey();
    if (!key) return;
    localStorage.setItem(
      key,
      JSON.stringify({
        order: tabsStore.tabs.map((tab) => tab.key),
        pinned: tabsStore.tabs
          .filter((tab) => tab.pinned)
          .map((tab) => tab.key),
        paths: tabsStore.tabs.map((tab) => tab.path),
        labels: Object.fromEntries(
          tabsStore.tabs.map((tab) => [tab.key, tab.label]),
        ),
      }),
    );
  } catch {
    // 存储不可用时页签仍可正常使用，仅不保留布局。
  }
}

function sortTabs() {
  const layout = readLayout();
  const position = new Map(layout.order.map((key, index) => [key, index]));
  tabsStore.tabs.sort((a, b) => {
    const pinOrder = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pinOrder) return pinOrder;
    return (
      (position.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
      (position.get(b.key) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

// 菜单功能路由 → 页签文案：首次进入对应功能后开出页签
const FEATURE_TAB_LABELS: Record<string, string> = {
  "/projects": "项目管理",
  "/requirements": "需求列表",
  "/optimization-points": "优化点管理",
  "/optimization-points/new": "新建优化点",
  "/meetings": "会议记录",
  "/meetings/new": "新建会议",
  "/tasks": "每日任务",
  "/notes": "便签",
  "/online-tools": "工具箱",
  "/notifications": "系统通知",
  "/settings": "系统设置",
};

export const tabsStore = reactive<{
  tabs: WorkTab[];
  activePath: string;
}>({ tabs: [], activePath: "" });

// 详情路由 → 实体 id（非详情路径返回 null）
function detailId(path: string): {
  kind: "requirement" | "meeting" | "optimizationPoint" | "project";
  id: number;
} | null {
  const project = /^\/projects\/(\d+)$/.exec(path);
  if (project) return { kind: "project", id: Number(project[1]) };
  const requirement = /^\/requirements\/(\d+)$/.exec(path);
  if (requirement) return { kind: "requirement", id: Number(requirement[1]) };
  const meeting = /^\/meetings\/(\d+)$/.exec(path);
  if (meeting) return { kind: "meeting", id: Number(meeting[1]) };
  const point = /^\/optimization-points\/(\d+)$/.exec(path);
  if (point) return { kind: "optimizationPoint", id: Number(point[1]) };
  return null;
}

// 路由联动：每次路由变化调用。激活对应页签；页签不存在时新增
//（功能页签取菜单文案；详情页未加载前先以「需求 #id / 会议 #id」占位，加载完成后回填真实文案）
export function syncRoute(path: string) {
  tabsStore.activePath = path;
  if (tabsStore.tabs.some((tab) => tab.path === path)) return;
  const detail = detailId(path);
  if (detail?.kind === "project") {
    tabsStore.tabs.push({
      key: path,
      path,
      label: `项目 #${detail.id}`,
      projectId: detail.id,
    });
    sortTabs();
    persistLayout();
    return;
  }
  if (detail?.kind === "requirement") {
    tabsStore.tabs.push({
      key: path,
      path,
      label: `需求 #${detail.id}`,
      requirementId: detail.id,
    });
    sortTabs();
    persistLayout();
    return;
  }
  if (detail?.kind === "meeting") {
    tabsStore.tabs.push({
      key: path,
      path,
      label: `会议 #${detail.id}`,
      meetingId: detail.id,
    });
    sortTabs();
    persistLayout();
    return;
  }
  if (detail?.kind === "optimizationPoint") {
    tabsStore.tabs.push({
      key: path,
      path,
      label: `优化点 #${detail.id}`,
      optimizationPointId: detail.id,
    });
    sortTabs();
    persistLayout();
    return;
  }
  const label = FEATURE_TAB_LABELS[path];
  if (label) {
    tabsStore.tabs.push({ key: path, path, label });
    sortTabs();
    persistLayout();
  }
}

// 回填/刷新页签文案：详情页 load 完成与保存改名后调用
export function setTabLabel(path: string, label: string) {
  const tab = tabsStore.tabs.find((item) => item.path === path);
  if (tab) {
    tab.label = label;
    persistLayout();
  }
}

// 关闭页签后应跳转的相邻页签路径（不修改 store）：右侧第一个 → 左侧第一个
export function siblingTabPath(key: string): string | null {
  const index = tabsStore.tabs.findIndex((tab) => tab.key === key);
  if (index < 0) return null;
  const next = tabsStore.tabs[index + 1] ?? tabsStore.tabs[index - 1];
  return next ? next.path : null;
}

// 关闭页签。若关的是激活页签，返回应跳转的路径
//（相邻页签 → 兜底「需求列表」路由，路由联动会重新开出首页页签）；
// 关非激活页签返回 null（路由不变）
export function closeTab(key: string): string | null {
  const index = tabsStore.tabs.findIndex((tab) => tab.key === key);
  if (index < 0) return null;
  const wasActive = tabsStore.activePath === key;
  const target = wasActive ? (siblingTabPath(key) ?? "/requirements") : null;
  tabsStore.tabs.splice(index, 1);
  persistLayout();
  if (!wasActive || !target) return null;
  tabsStore.activePath = target;
  return target;
}

// 移除页签但不触发跳转（保存新建后由调用方决定去向）
export function removeTab(key: string) {
  const index = tabsStore.tabs.findIndex((tab) => tab.key === key);
  if (index < 0) return;
  tabsStore.tabs.splice(index, 1);
  persistLayout();
  if (tabsStore.activePath === key) tabsStore.activePath = "";
}

// 关闭其他页签（仅保留指定页签）；激活页签被关时返回跳转路径
export function closeOtherTabs(key: string): string | null {
  tabsStore.tabs = tabsStore.tabs.filter((tab) => tab.key === key);
  if (tabsStore.tabs.some((tab) => tab.path === tabsStore.activePath)) {
    persistLayout();
    return null;
  }
  tabsStore.activePath = key;
  return key;
}

export function closeOtherTabsWithPolicy(key: string, keepPinned: boolean) {
  tabsStore.tabs = tabsStore.tabs.filter(
    (tab) => tab.key === key || (keepPinned && tab.pinned),
  );
  tabsStore.activePath = key;
  persistLayout();
}

export function togglePinned(key: string) {
  const tab = tabsStore.tabs.find((item) => item.key === key);
  if (!tab) return;
  tab.pinned = !tab.pinned;
  sortTabs();
  persistLayout();
}

export function reorderTab(sourceKey: string, targetKey: string) {
  if (sourceKey === targetKey) return;
  const source = tabsStore.tabs.findIndex((tab) => tab.key === sourceKey);
  const target = tabsStore.tabs.findIndex((tab) => tab.key === targetKey);
  if (source < 0 || target < 0) return;
  if (
    Boolean(tabsStore.tabs[source].pinned) !==
    Boolean(tabsStore.tabs[target].pinned)
  )
    return;
  const [tab] = tabsStore.tabs.splice(source, 1);
  const targetAfterRemoval = tabsStore.tabs.findIndex(
    (item) => item.key === targetKey,
  );
  tabsStore.tabs.splice(targetAfterRemoval + (source < target ? 1 : 0), 0, tab);
  persistLayout();
}

// 退出登录/进入公开页（登录页）时清空全部页签，之后进入功能按需重开
export function clearTabs(preserveLayout = false) {
  tabsStore.tabs = [];
  tabsStore.activePath = "";
  if (preserveLayout) return;
  try {
    const key = layoutStorageKey();
    if (key) localStorage.removeItem(key);
  } catch {
    // Clearing visible tabs should not depend on storage availability.
  }
}

export function restoreTabs() {
  const layout = readLayout();
  const pinned = new Set(layout.pinned);
  for (const path of layout.paths) {
    if (tabsStore.tabs.some((tab) => tab.key === path)) continue;
    const detail = detailId(path);
    const common = {
      key: path,
      path,
      label: layout.labels[path] ?? path,
      pinned: pinned.has(path),
    };
    if (detail?.kind === "requirement")
      tabsStore.tabs.push({ ...common, requirementId: detail.id });
    else if (detail?.kind === "project")
      tabsStore.tabs.push({ ...common, projectId: detail.id });
    else if (detail?.kind === "meeting")
      tabsStore.tabs.push({ ...common, meetingId: detail.id });
    else if (detail?.kind === "optimizationPoint")
      tabsStore.tabs.push({ ...common, optimizationPointId: detail.id });
    else if (FEATURE_TAB_LABELS[path])
      tabsStore.tabs.push({
        ...common,
        label: layout.labels[path] ?? FEATURE_TAB_LABELS[path],
      });
    else continue;
  }
  sortTabs();
}
