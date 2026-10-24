<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  BarChartOutlined,
  BugOutlined,
  CodeOutlined,
  DeleteOutlined,
  FormatPainterOutlined,
  LeftOutlined,
  LinkOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
  WarningFilled,
} from "@ant-design/icons-vue";
import {
  issueAssetRelationLabels,
  issueStatuses,
  issueStatusLabels,
  issueTypes,
  issueTypeLabels,
  stageLabels,
  stages,
  type Issue,
  type IssueAssetLink,
  type IssueDetail,
  type IssueLinkedArtifact,
  type IssueStage,
  type IssueStatus,
  type IssueType,
} from "@superpm/shared";
import { issueApi, type IssueUpdatePayload } from "../../api/issues";
import { artifactApi } from "../../api/artifacts";
import { errorMessage } from "../../api/client";
import FileTypeIcon from "../../components/FileTypeIcon.vue";
import InlineRichTextEditor from "./InlineRichTextEditor.vue";
import { toDisplayHtml, toStoredHtml } from "./doc-images";
import { documentToEditorHtml, htmlToMarkdown } from "./doc-markdown";

// 问题记录（开发文档 V1.0）：左栏台账 + 右栏详情。
// 标题/类型/阶段/状态/描述/结论全部自动保存；描述与结论各自保存为 Markdown，
// 图片统一落到需求根目录 images/，编辑器内写相对路径。
const props = defineProps<{
  requirementId: number;
  currentStage?: IssueStage;
}>();

interface Snapshot {
  title: string;
  type: IssueType | null;
  stage: IssueStage;
  status: IssueStatus;
  descHtml: string;
  solHtml: string;
}
type SaveUi = "saved" | "pending" | "saving" | "failed";
interface ArtifactTreeItem {
  id: number;
  name: string;
  nodeType: IssueLinkedArtifact["nodeType"];
  disabled: boolean;
  children: ArtifactTreeItem[];
}

const typeOptions = issueTypes.map((value) => ({
  value,
  label: issueTypeLabels[value],
}));
const stageOptions = stages.map((value) => ({
  value,
  label: stageLabels[value],
}));

function emptyStatusCounts(): Record<IssueStatus, number> {
  return { pending: 0, to_confirm: 0, processing: 0, resolved: 0, wont_fix: 0 };
}

// ===== 列表与筛选 =====
const issues = ref<Issue[]>([]);
const statusCounts = ref<Record<IssueStatus, number>>(emptyStatusCounts());
const listLoading = ref(true);
const listError = ref("");
const statusFilter = ref<IssueStatus | "">("");
const typeFilter = ref<IssueType | "">("");
const keyword = ref("");
const selectedId = ref<number | null>(null);
const mobileDetailOpen = ref(false);
let listSeq = 0;
let refreshTimer: number | undefined;

// ===== 详情与自动保存 =====
const detail = ref<IssueDetail>();
const detailLoading = ref(false);
const detailError = ref("");
const titleDraft = ref("");
const typeDraft = ref<IssueType | null>(null);
const stageDraft = ref<IssueStage>("analysis");
const statusDraft = ref<IssueStatus>("pending");
const descHtml = ref("");
const solHtml = ref("");
const snapshot = ref<Snapshot | null>(null);
const saving = ref(false);
const saveFailed = ref(false);
const saveError = ref("");
const lastSavedAt = ref<string | null>(null);
const titleEl = ref<HTMLTextAreaElement>();
const descEditor = ref<InstanceType<typeof InlineRichTextEditor>>();
const solEditor = ref<InstanceType<typeof InlineRichTextEditor>>();
let titleObserver: ResizeObserver | undefined;
let detailSeq = 0;
let saveTimer: number | undefined;
let saveTask: Promise<boolean> | undefined;

// ===== 关联产出物 =====
const assets = ref<IssueAssetLink[]>([]);
const linkDialogVisible = ref(false);
const treeLoading = ref(false);
const linkSaving = ref(false);
const artifactTree = ref<ArtifactTreeItem[]>([]);
const checkedIds = ref<number[]>([]);
const expandedIds = ref<Set<number>>(new Set());
const linkedIds = computed(
  () => new Set(assets.value.map((item) => item.assetId)),
);
const sortedAssets = computed(() =>
  [...assets.value].sort((a, b) =>
    a.asset.relativePath.localeCompare(b.asset.relativePath, "zh-Hans-CN"),
  ),
);
// 只展示最近一次 AI 写入来源；完整处理记录已按需求移除
const latestAiActivity = computed(() => {
  const activities = detail.value?.activities;
  if (!activities) return null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (activities[index].actorType === "ai") return activities[index];
  }
  return null;
});

// ===== 新建 =====
const createOpen = ref(false);
const creating = ref(false);
const createTitle = ref("");
const createType = ref<IssueType | "">("");
const createStage = ref<IssueStage>("analysis");
const createDesc = ref("");
const createTitleInput = ref<{ focus: () => void }>();

// ===== 派生状态 =====
const totalCount = computed(() =>
  issueStatuses.reduce((sum, status) => sum + statusCounts.value[status], 0),
);
const hasFilters = computed(() =>
  Boolean(statusFilter.value || typeFilter.value || keyword.value.trim()),
);
const showFullEmpty = computed(
  () =>
    !listLoading.value &&
    !listError.value &&
    !hasFilters.value &&
    totalCount.value === 0,
);
const dirty = computed(() => {
  const saved = snapshot.value;
  if (!detail.value || !saved) return false;
  return (
    titleDraft.value.trim() !== saved.title ||
    typeDraft.value !== saved.type ||
    stageDraft.value !== saved.stage ||
    statusDraft.value !== saved.status ||
    descHtml.value !== saved.descHtml ||
    solHtml.value !== saved.solHtml
  );
});
const saveUi = computed<SaveUi>(() => {
  if (saving.value) return "saving";
  if (saveFailed.value) return "failed";
  if (dirty.value) return "pending";
  return "saved";
});
const saveLabel = computed(() => {
  if (saving.value) return "保存中…";
  if (saveFailed.value) return saveError.value || "保存失败，内容已保留";
  if (dirty.value) return "有未保存的修改";
  return lastSavedAt.value
    ? `已自动保存 · ${formatClock(lastSavedAt.value)}`
    : "所有修改已自动保存";
});
const solutionEmpty = computed(() => !htmlHasContent(solHtml.value));
const needsSolution = computed(
  () => statusDraft.value === "resolved" && solutionEmpty.value,
);

// ===== 展示辅助 =====
function typeTone(type: IssueType | null): string {
  switch (type) {
    case "analysis":
      return "tone-purple";
    case "ui":
      return "tone-teal";
    case "development":
      return "tone-blue";
    case "testing":
      return "tone-amber";
    default:
      return "tone-slate";
  }
}
function statusTone(status: IssueStatus): string {
  switch (status) {
    case "pending":
      return "tone-amber";
    case "to_confirm":
      return "tone-purple";
    case "processing":
      return "tone-blue";
    case "resolved":
      return "tone-green";
    default:
      return "tone-slate";
  }
}
function typeIcon(type: IssueType | null) {
  switch (type) {
    case "analysis":
      return BarChartOutlined;
    case "ui":
      return FormatPainterOutlined;
    case "development":
      return CodeOutlined;
    case "testing":
      return BugOutlined;
    default:
      return MoreOutlined;
  }
}
function pad2(value: number) {
  return String(value).padStart(2, "0");
}
function parseDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
function formatShort(iso: string) {
  const date = parseDate(iso);
  if (!date) return iso;
  const now = new Date();
  const day =
    date.getFullYear() === now.getFullYear()
      ? `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
      : `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
function formatFull(iso: string) {
  const date = parseDate(iso);
  if (!date) return iso;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
function formatClock(iso: string) {
  const date = parseDate(iso);
  return date ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : iso;
}
// 列表摘要：Markdown 收敛成一行纯文本，图片/链接不占篇幅
function excerpt(issue: Issue) {
  const text = issue.description
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`~]+/g, " ")
    .replace(/^\s*[-+]\s+/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || "暂无描述";
}
function htmlHasContent(html: string) {
  if (!html.trim()) return false;
  const container = document.createElement("div");
  container.innerHTML = html;
  return (
    Boolean(container.textContent?.trim()) ||
    Boolean(container.querySelector("img"))
  );
}

// ===== 列表加载 =====
async function loadList(
  options: { quiet?: boolean; selectFirst?: boolean } = {},
) {
  const seq = ++listSeq;
  if (!options.quiet) {
    listLoading.value = true;
    listError.value = "";
  }
  try {
    const result = await issueApi.list(props.requirementId, {
      status: statusFilter.value || undefined,
      type: typeFilter.value || undefined,
      q: keyword.value.trim() || undefined,
    });
    if (seq !== listSeq) return;
    issues.value = result.items;
    statusCounts.value = result.statusCounts;
    listError.value = "";
    // 首次进入或删除当前问题后自动选中第一条，减少一次点击
    if (
      options.selectFirst !== false &&
      !selectedId.value &&
      !detail.value &&
      result.items.length
    ) {
      void openIssue(result.items[0].id);
    }
  } catch (error) {
    if (seq !== listSeq) return;
    const message = errorMessage(error);
    if (options.quiet) return;
    if (!issues.value.length) listError.value = message;
    else ElMessage.error(message);
  } finally {
    if (seq === listSeq && !options.quiet) listLoading.value = false;
  }
}
function scheduleQuietRefresh() {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    void loadList({ quiet: true });
  }, 400);
}
function onStatusFilterChange(value: unknown) {
  statusFilter.value =
    typeof value === "string" &&
    (issueStatuses as readonly string[]).includes(value)
      ? (value as IssueStatus)
      : "";
  void loadList();
}
function onTypeFilterChange(value: unknown) {
  typeFilter.value =
    typeof value === "string" &&
    (issueTypes as readonly string[]).includes(value)
      ? (value as IssueType)
      : "";
  void loadList();
}
function runSearchNow() {
  void loadList();
}
function clearFilters() {
  statusFilter.value = "";
  typeFilter.value = "";
  keyword.value = "";
  void loadList();
}

// ===== 详情加载 =====
async function openIssue(id: number, options: { force?: boolean } = {}) {
  if (!options.force && selectedId.value === id && detail.value) {
    mobileDetailOpen.value = true;
    return;
  }
  if (detail.value) {
    const saved = await flush();
    if (!saved) {
      ElMessage.error("当前问题尚未保存成功，请重试后再切换");
      return;
    }
  }
  const seq = ++detailSeq;
  selectedId.value = id;
  mobileDetailOpen.value = true;
  detail.value = undefined;
  snapshot.value = null;
  assets.value = [];
  detailError.value = "";
  detailLoading.value = true;
  try {
    const loaded = await issueApi.detail(props.requirementId, id);
    if (seq !== detailSeq) return;
    hydrate(loaded);
    await loadAssets();
  } catch (error) {
    if (seq !== detailSeq) return;
    detailError.value = errorMessage(error);
    ElMessage.error(detailError.value);
  } finally {
    if (seq === detailSeq) detailLoading.value = false;
  }
}
function hydrate(loaded: IssueDetail) {
  detail.value = loaded;
  titleDraft.value = loaded.title;
  typeDraft.value = loaded.type;
  stageDraft.value = loaded.stage;
  statusDraft.value = loaded.status;
  const description = toDisplayHtml(
    documentToEditorHtml(loaded.description),
    props.requirementId,
  );
  const solution = toDisplayHtml(
    documentToEditorHtml(loaded.solution),
    props.requirementId,
  );
  descHtml.value = description;
  solHtml.value = solution;
  snapshot.value = {
    title: loaded.title,
    type: loaded.type,
    stage: loaded.stage,
    status: loaded.status,
    descHtml: description,
    solHtml: solution,
  };
  lastSavedAt.value = loaded.updatedAt;
  saveFailed.value = false;
  saveError.value = "";
  saving.value = false;
  // 详情在窄屏可能下一帧才从隐藏切到显示，用 ResizeObserver 在真实布局后补量标题高度
  void nextTick(() => {
    resizeTitle();
    titleObserver?.disconnect();
    if (titleEl.value) {
      titleObserver = new ResizeObserver(() => resizeTitle());
      titleObserver.observe(titleEl.value);
    }
  });
}

// ===== 自动保存 =====
function currentSolutionMarkdown() {
  return htmlToMarkdown(toStoredHtml(solHtml.value, props.requirementId));
}
function buildPatch(): IssueUpdatePayload {
  const saved = snapshot.value;
  const patch: IssueUpdatePayload = {};
  if (!saved) return patch;
  const title = titleDraft.value.trim();
  if (title && title !== saved.title) patch.title = title;
  if (typeDraft.value !== saved.type) patch.type = typeDraft.value;
  if (stageDraft.value !== saved.stage) patch.stage = stageDraft.value;
  if (statusDraft.value !== saved.status) patch.status = statusDraft.value;
  if (descHtml.value !== saved.descHtml)
    patch.description = htmlToMarkdown(
      toStoredHtml(descHtml.value, props.requirementId),
    );
  if (solHtml.value !== saved.solHtml)
    patch.solution = currentSolutionMarkdown();
  return patch;
}
// 只确认本次请求提交过的字段，避免旧响应覆盖保存期间的新输入
function acknowledge(
  patch: IssueUpdatePayload,
  sentDescHtml: string,
  sentSolHtml: string,
) {
  const saved = snapshot.value;
  if (!saved) return;
  snapshot.value = {
    title: patch.title ?? saved.title,
    type: patch.type === undefined ? saved.type : patch.type,
    stage: patch.stage ?? saved.stage,
    status: patch.status ?? saved.status,
    descHtml: patch.description === undefined ? saved.descHtml : sentDescHtml,
    solHtml: patch.solution === undefined ? saved.solHtml : sentSolHtml,
  };
}
async function persist(): Promise<boolean> {
  const current = detail.value;
  if (!current) return true;
  const issueId = current.id;
  try {
    while (dirty.value && detail.value?.id === issueId) {
      if (!titleDraft.value.trim()) {
        saveFailed.value = true;
        saveError.value = "问题标题不能为空";
        return false;
      }
      if (
        statusDraft.value === "resolved" &&
        !currentSolutionMarkdown().trim()
      ) {
        saveFailed.value = true;
        saveError.value = "请先填写解决方案 / 最终结论，再标记为已解决";
        return false;
      }
      const patch = buildPatch();
      if (!Object.keys(patch).length) break;
      const sentDescHtml = descHtml.value;
      const sentSolHtml = solHtml.value;
      saving.value = true;
      saveFailed.value = false;
      saveError.value = "";
      try {
        const updated = await issueApi.update(
          props.requirementId,
          issueId,
          patch,
        );
        if (detail.value?.id !== issueId) return true;
        acknowledge(patch, sentDescHtml, sentSolHtml);
        detail.value = {
          ...detail.value,
          issueKey: updated.issueKey,
          title: updated.title,
          description: updated.description,
          type: updated.type,
          stage: updated.stage,
          status: updated.status,
          solution: updated.solution,
          resolvedAt: updated.resolvedAt,
          updatedAt: updated.updatedAt,
        };
        lastSavedAt.value = updated.updatedAt;
        patchListRow(updated);
        scheduleQuietRefresh();
      } catch (error) {
        if (detail.value?.id === issueId) {
          saveFailed.value = true;
          saveError.value = errorMessage(error);
        }
        return false;
      }
    }
    return true;
  } finally {
    saving.value = false;
  }
}
function saveNow(): Promise<boolean> {
  clearSaveTimer();
  if (!saveTask) {
    saveTask = (async () => {
      let saved = await persist();
      // 上一轮落盘期间产生的新修改（枚举切换不走防抖）在同一任务内继续保存
      while (saved && dirty.value) saved = await persist();
      return saved;
    })().finally(() => {
      saveTask = undefined;
    });
  }
  return saveTask;
}
function scheduleSave() {
  clearSaveTimer();
  if (!detail.value) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void saveNow();
  }, 800);
}
function clearSaveTimer() {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
  }
}
function patchListRow(updated: Issue) {
  const index = issues.value.findIndex((item) => item.id === updated.id);
  if (index < 0) return;
  const previousStatus = issues.value[index].status;
  const next = [...issues.value];
  next[index] = { ...next[index], ...updated };
  next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
  issues.value = next;
  if (previousStatus !== updated.status) {
    const counts = { ...statusCounts.value };
    counts[previousStatus] = Math.max(0, counts[previousStatus] - 1);
    counts[updated.status] += 1;
    statusCounts.value = counts;
  }
}
// 页签切换/离开前调用：先等图片上传，再落盘所有未保存字段
async function flush(): Promise<boolean> {
  clearSaveTimer();
  if (!detail.value) return true;
  await Promise.allSettled([
    descEditor.value?.waitForUpload(),
    solEditor.value?.waitForUpload(),
  ]);
  if (!dirty.value) {
    saveFailed.value = false;
    return true;
  }
  return saveNow();
}
defineExpose({ flush });

// ===== 标题 / 枚举字段 =====
function onTitleEnter() {
  titleEl.value?.blur();
}
function onTitleInput() {
  if (titleDraft.value.includes("\n"))
    titleDraft.value = titleDraft.value.replace(/\n+/g, " ");
  scheduleSave();
  void nextTick(resizeTitle);
}
function onTitleBlur() {
  if (!titleDraft.value.trim()) {
    titleDraft.value = snapshot.value?.title ?? detail.value?.title ?? "";
    ElMessage.warning("问题标题不能为空，已恢复原标题");
    void nextTick(resizeTitle);
    if (dirty.value) scheduleSave();
    else saveFailed.value = false;
    return;
  }
  const trimmed = titleDraft.value.trim();
  if (trimmed !== titleDraft.value) {
    titleDraft.value = trimmed;
    void nextTick(resizeTitle);
  }
  if (dirty.value) scheduleSave();
}
function resizeTitle() {
  const el = titleEl.value;
  if (!el) return;
  el.style.height = "auto";
  // 隐藏时 scrollHeight 为 0，回退到 rows=1 的自然高度
  el.style.height = el.scrollHeight > 0 ? `${el.scrollHeight}px` : "";
}
function onTypeChange(value: unknown) {
  typeDraft.value =
    typeof value === "string" &&
    (issueTypes as readonly string[]).includes(value)
      ? (value as IssueType)
      : null;
  void saveNow();
}
function onStageChange(value: unknown) {
  if (
    typeof value !== "string" ||
    !(stages as readonly string[]).includes(value)
  )
    return;
  stageDraft.value = value as IssueStage;
  void saveNow();
}
function onStatusChange(value: unknown) {
  if (
    typeof value !== "string" ||
    !(issueStatuses as readonly string[]).includes(value)
  )
    return;
  const next = value as IssueStatus;
  const previous = statusDraft.value;
  if (next === "resolved" && !currentSolutionMarkdown().trim()) {
    ElMessage.warning("请先填写解决方案 / 最终结论，再将问题标记为已解决");
    statusDraft.value = previous;
    return;
  }
  statusDraft.value = next;
  void saveNow();
}
function onDescHtml(html: string) {
  descHtml.value = html;
  scheduleSave();
}
function onSolHtml(html: string) {
  solHtml.value = html;
  scheduleSave();
}

// ===== 新建问题 =====
async function openCreate() {
  if (detail.value) {
    const saved = await flush();
    if (!saved) {
      ElMessage.error("当前问题尚未保存成功，请重试后再新增");
      return;
    }
  }
  createTitle.value = "";
  createType.value = "";
  createStage.value = props.currentStage ?? "analysis";
  createDesc.value = "";
  createOpen.value = true;
  await nextTick();
  createTitleInput.value?.focus();
}
async function submitCreate() {
  const title = createTitle.value.trim();
  if (!title) {
    ElMessage.warning("请输入问题标题");
    return;
  }
  if (creating.value) return;
  creating.value = true;
  try {
    const created = await issueApi.create(props.requirementId, {
      title,
      type: createType.value || null,
      stage: createStage.value,
      description: createDesc.value.trim(),
    });
    createOpen.value = false;
    ElMessage.success("问题已创建");
    statusFilter.value = "";
    typeFilter.value = "";
    keyword.value = "";
    selectedId.value = created.id;
    detail.value = undefined;
    snapshot.value = null;
    mobileDetailOpen.value = true;
    await loadList({ quiet: true });
    await openIssue(created.id, { force: true });
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    creating.value = false;
  }
}

// ===== 删除问题 =====
async function removeIssue() {
  const current = detail.value;
  if (!current) return;
  try {
    await ElMessageBox.confirm(
      "删除后该问题不可恢复；描述中已插入的图片文件不会被删除。",
      "删除问题",
      {
        confirmButtonText: "删除",
        cancelButtonText: "取消",
        type: "warning",
        confirmButtonClass: "el-button--danger",
      },
    );
  } catch {
    return;
  }
  clearSaveTimer();
  try {
    await issueApi.remove(props.requirementId, current.id);
    ElMessage.success("问题已删除");
    detail.value = undefined;
    snapshot.value = null;
    selectedId.value = null;
    assets.value = [];
    mobileDetailOpen.value = false;
    await loadList();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

// ===== 关联产出物 =====
async function loadAssets() {
  const current = detail.value;
  if (!current) {
    assets.value = [];
    return;
  }
  try {
    const result = await issueApi.listAssets(props.requirementId, current.id);
    if (detail.value?.id === current.id) assets.value = result.items;
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}
async function unlink(link: IssueAssetLink) {
  const current = detail.value;
  if (!current) return;
  try {
    await issueApi.unlinkAsset(props.requirementId, current.id, link.assetId);
    await loadAssets();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}
async function loadTreeLevel(
  parentId: number | null,
): Promise<ArtifactTreeItem[]> {
  const directory = await artifactApi.list(props.requirementId, parentId);
  const folders = await Promise.all(
    directory.folders.map(async (folder) => ({
      id: folder.id,
      name: folder.name,
      nodeType: "folder" as const,
      disabled: linkedIds.value.has(folder.id),
      children: await loadTreeLevel(folder.id),
    })),
  );
  const files = directory.files.map((file) => ({
    id: file.id,
    name: file.name,
    nodeType: "file" as const,
    disabled: linkedIds.value.has(file.id),
    children: [],
  }));
  return [...folders, ...files];
}
async function openLinkDialog() {
  linkDialogVisible.value = true;
  treeLoading.value = true;
  checkedIds.value = [];
  expandedIds.value = new Set();
  try {
    artifactTree.value = await loadTreeLevel(null);
    for (const item of artifactTree.value)
      if (item.nodeType === "folder") expandedIds.value.add(item.id);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    treeLoading.value = false;
  }
}
const treeRows = computed<{ item: ArtifactTreeItem; depth: number }[]>(() => {
  const rows: { item: ArtifactTreeItem; depth: number }[] = [];
  const walk = (items: ArtifactTreeItem[], depth: number) => {
    for (const item of items) {
      rows.push({ item, depth });
      if (item.nodeType === "folder" && expandedIds.value.has(item.id))
        walk(item.children, depth + 1);
    }
  };
  walk(artifactTree.value, 0);
  return rows;
});
function toggleExpanded(item: ArtifactTreeItem) {
  const next = new Set(expandedIds.value);
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  expandedIds.value = next;
}
function onTreeCheck(
  item: ArtifactTreeItem,
  checked: boolean | string | number,
) {
  if (checked === true) {
    if (!checkedIds.value.includes(item.id))
      checkedIds.value = [...checkedIds.value, item.id];
  } else {
    checkedIds.value = checkedIds.value.filter((id) => id !== item.id);
  }
}
async function confirmLink() {
  const current = detail.value;
  if (!current) return;
  const targets = checkedIds.value.filter((id) => !linkedIds.value.has(id));
  if (!targets.length) {
    linkDialogVisible.value = false;
    return;
  }
  linkSaving.value = true;
  try {
    for (const assetId of targets)
      await issueApi.linkAsset(
        props.requirementId,
        current.id,
        assetId,
        "reference",
      );
    ElMessage.success("已关联产出物");
    linkDialogVisible.value = false;
    await loadAssets();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    linkSaving.value = false;
  }
}

// ===== 生命周期 =====
function onBeforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value) return;
  event.preventDefault();
  event.returnValue = "";
}
function onWindowResize() {
  void nextTick(resizeTitle);
}
onMounted(() => {
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("resize", onWindowResize);
  void loadList();
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload);
  window.removeEventListener("resize", onWindowResize);
  titleObserver?.disconnect();
  if (refreshTimer) window.clearTimeout(refreshTimer);
  clearSaveTimer();
  void flush();
});
</script>
<template>
  <!-- 空台账：整块留白比双栏空壳更清楚 -->
  <div v-if="showFullEmpty" class="issue-empty">
    <div class="empty-ledger">
      <span class="empty-kicker">问题记录</span>
      <h2>先记下来，<br />再逐条解决。</h2>
      <p>
        分析、设计、开发和测试中的疑问都可以记录在这里。每条问题都有独立的描述、解决方案与关联产出物。
      </p>
      <button class="issue-primary" type="button" @click="openCreate()">
        <el-icon aria-hidden="true" :size="14"><PlusOutlined /></el-icon>
        新增第一个问题
      </button>
    </div>
    <div class="empty-side" aria-hidden="true">
      <div class="empty-legend">
        <span
          v-for="status in issueStatuses"
          :key="status"
          class="empty-chip"
          :class="statusTone(status)"
          >{{ issueStatusLabels[status] }} <b>0</b></span
        >
      </div>
      <div class="empty-rule"></div>
      <div class="empty-lines">
        <span class="empty-line" style="width: 88%"></span>
        <span class="empty-line" style="width: 62%"></span>
        <span class="empty-line" style="width: 76%"></span>
        <span class="empty-line" style="width: 48%"></span>
      </div>
      <span class="empty-caption">每条疑问，都有落点</span>
    </div>
  </div>

  <div
    v-else
    class="issue-app"
    :class="{ 'detail-open': mobileDetailOpen && detail }"
  >
    <!-- ===== 左栏：台账 ===== -->
    <aside class="issue-rail">
      <header class="rail-head">
        <div class="filter-row filter-row--selects">
          <el-select
            class="filter-select type-filter"
            :model-value="typeFilter || 'all'"
            aria-label="按问题类型筛选"
            @change="onTypeFilterChange"
          >
            <el-option label="全部类型" value="all" />
            <el-option
              v-for="option in typeOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
          <el-select
            class="filter-select status-filter"
            :model-value="statusFilter || 'all'"
            aria-label="按问题状态筛选"
            @change="onStatusFilterChange"
          >
            <el-option label="全部状态" value="all" />
            <el-option
              v-for="status in issueStatuses"
              :key="status"
              :label="issueStatusLabels[status]"
              :value="status"
            />
          </el-select>
        </div>

        <div class="filter-row filter-row--search">
          <label class="search-box">
            <el-icon aria-hidden="true" :size="13"><SearchOutlined /></el-icon>
            <input
              v-model="keyword"
              type="search"
              placeholder="搜索标题或描述"
              aria-label="搜索问题标题或描述"
              @keydown.enter="runSearchNow()"
            />
            <button
              v-if="keyword"
              class="search-clear"
              type="button"
              aria-label="清空搜索"
              @click="
                keyword = '';
                runSearchNow();
              "
            >
              ×
            </button>
          </label>
          <button class="search-button" type="button" @click="runSearchNow()">
            搜索
          </button>
          <button
            class="issue-primary issue-primary--small"
            type="button"
            @click="openCreate()"
          >
            <el-icon aria-hidden="true" :size="12"><PlusOutlined /></el-icon>
            新增
          </button>
        </div>
      </header>

      <div
        class="rail-list"
        :class="{ 'is-refreshing': listLoading && issues.length }"
      >
        <div v-if="listError" class="rail-error">
          <el-icon aria-hidden="true" :size="15"><WarningFilled /></el-icon>
          <p>{{ listError }}</p>
          <button class="text-button" type="button" @click="loadList()">
            <el-icon aria-hidden="true" :size="12"><ReloadOutlined /></el-icon
            >重新加载
          </button>
        </div>
        <div v-else-if="listLoading && !issues.length" class="list-skeleton">
          <span v-for="index in 5" :key="index" class="skeleton-row"></span>
        </div>
        <template v-else>
          <button
            v-for="issue in issues"
            :key="issue.id"
            type="button"
            class="issue-row"
            :class="{ active: selectedId === issue.id && detail }"
            @click="openIssue(issue.id)"
          >
            <span class="type-tile" :class="typeTone(issue.type)">
              <el-icon aria-hidden="true" :size="14"
                ><component :is="typeIcon(issue.type)"
              /></el-icon>
            </span>
            <span class="row-main">
              <span class="row-top">
                <strong class="row-title">{{ issue.title }}</strong>
                <span class="status-pill" :class="statusTone(issue.status)">{{
                  issueStatusLabels[issue.status]
                }}</span>
              </span>
              <span class="row-meta">
                <span>{{
                  issue.type ? issueTypeLabels[issue.type] : "未分类"
                }}</span>
                <span class="meta-sep">·</span>
                <span>{{ stageLabels[issue.stage] }}</span>
                <span class="row-time">{{ formatShort(issue.updatedAt) }}</span>
              </span>
              <span class="row-excerpt">{{ excerpt(issue) }}</span>
            </span>
          </button>
          <div v-if="!issues.length" class="rail-empty">
            <template v-if="hasFilters">
              <p>没有符合条件的问题</p>
              <button class="text-button" type="button" @click="clearFilters()">
                清除筛选
              </button>
            </template>
            <template v-else>
              <p>还没有问题记录</p>
              <button class="text-button" type="button" @click="openCreate()">
                <el-icon aria-hidden="true" :size="12"><PlusOutlined /></el-icon
                >新增第一个问题
              </button>
            </template>
          </div>
        </template>
      </div>
    </aside>

    <!-- ===== 右栏：详情 ===== -->
    <section class="detail-pane">
      <template v-if="detail">
        <header class="detail-head">
          <button
            class="back-button"
            type="button"
            @click="mobileDetailOpen = false"
          >
            <el-icon aria-hidden="true" :size="13"><LeftOutlined /></el-icon>
            列表
          </button>

          <textarea
            ref="titleEl"
            v-model="titleDraft"
            class="title-input"
            :class="{ invalid: saveUi === 'failed' && !titleDraft.trim() }"
            rows="1"
            maxlength="200"
            aria-label="问题标题"
            placeholder="问题标题"
            @input="onTitleInput"
            @blur="onTitleBlur"
            @keydown.enter.prevent="onTitleEnter()"
          ></textarea>

          <div class="meta-row">
            <div class="meta-field meta-field--type">
              <span class="meta-label">类型</span>
              <el-select
                :model-value="typeDraft"
                size="small"
                placeholder="未分类"
                clearable
                aria-label="问题类型"
                @change="onTypeChange"
              >
                <el-option
                  v-for="option in typeOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
            </div>
            <div class="meta-field meta-field--stage">
              <span class="meta-label">产生阶段</span>
              <el-select
                :model-value="stageDraft"
                size="small"
                aria-label="产生阶段"
                @change="onStageChange"
              >
                <el-option
                  v-for="option in stageOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
            </div>
            <div class="meta-field meta-field--status">
              <span class="meta-label">状态</span>
              <div class="status-select" :class="statusTone(statusDraft)">
                <el-select
                  :model-value="statusDraft"
                  size="small"
                  aria-label="问题状态"
                  @change="onStatusChange"
                >
                  <el-option
                    v-for="status in issueStatuses"
                    :key="status"
                    :label="issueStatusLabels[status]"
                    :value="status"
                  />
                </el-select>
              </div>
            </div>
            <div class="meta-times">
              <span
                v-if="latestAiActivity"
                class="ai-badge"
                :title="`最近 AI 写入：${latestAiActivity.actorName ?? 'AI'} · ${formatFull(latestAiActivity.createdAt)}`"
              >
                <el-icon aria-hidden="true" :size="9"><CodeOutlined /></el-icon>
                <span class="ai-badge-name">{{
                  latestAiActivity.actorName ?? "AI"
                }}</span>
              </span>
              <span>创建 {{ formatFull(detail.createdAt) }}</span>
              <span>更新 {{ formatFull(detail.updatedAt) }}</span>
              <span v-if="detail.resolvedAt" class="resolved-time"
                >解决 {{ formatFull(detail.resolvedAt) }}</span
              >
              <button
                class="ghost-danger meta-delete"
                type="button"
                @click="removeIssue()"
              >
                <el-icon aria-hidden="true" :size="11"
                  ><DeleteOutlined
                /></el-icon>
                删除
              </button>
            </div>
          </div>
        </header>

        <div class="detail-body">
          <section class="detail-section">
            <div class="section-head">
              <h3 class="section-title">问题描述</h3>
              <span class="section-note">支持粘贴或拖入图片 · 自动保存</span>
            </div>
            <InlineRichTextEditor
              ref="descEditor"
              :key="`desc-${detail.id}`"
              :html="descHtml"
              :requirement-id="requirementId"
              label="问题描述"
              placeholder="描述问题现象、上下文或需要确认的点…"
              compact
              @update:html="onDescHtml"
            />
          </section>

          <section class="detail-section">
            <div class="section-head">
              <h3 class="section-title">解决方案 / 最终结论</h3>
              <span class="section-note" :class="{ 'is-warn': needsSolution }">
                <el-icon aria-hidden="true" v-if="needsSolution" :size="11"
                  ><WarningFilled
                /></el-icon>
                {{
                  needsSolution
                    ? "标记为已解决前必须填写"
                    : "支持 Markdown 与图片"
                }}
              </span>
            </div>
            <InlineRichTextEditor
              ref="solEditor"
              :key="`sol-${detail.id}`"
              :html="solHtml"
              :requirement-id="requirementId"
              label="解决方案或最终结论"
              placeholder="记录处理方案、最终结论，或暂不处理的原因…"
              compact
              @update:html="onSolHtml"
            />
          </section>

          <section class="detail-section">
            <div class="section-head">
              <h3 class="section-title">
                关联产出物
                <span v-if="assets.length" class="section-count">{{
                  assets.length
                }}</span>
              </h3>
              <button
                class="text-button section-action"
                type="button"
                @click="openLinkDialog()"
              >
                <el-icon aria-hidden="true" :size="12"
                  ><LinkOutlined
                /></el-icon>
                关联
              </button>
            </div>
            <div v-if="assets.length" class="asset-chips">
              <span
                v-for="link in sortedAssets"
                :key="link.assetId"
                class="asset-chip"
                :title="link.asset.relativePath"
              >
                <el-icon aria-hidden="true" :size="12">
                  <FileTypeIcon
                    :node-type="link.asset.nodeType"
                    :name="link.asset.name"
                  />
                </el-icon>
                <span class="asset-name">{{ link.asset.name }}</span>
                <span
                  v-if="link.relationType !== 'reference'"
                  class="asset-rel"
                  >{{ issueAssetRelationLabels[link.relationType] }}</span
                >
                <button
                  class="chip-remove"
                  type="button"
                  :aria-label="`取消关联 ${link.asset.name}`"
                  @click="unlink(link)"
                >
                  ×
                </button>
              </span>
            </div>
            <p v-else class="section-empty">
              还没有关联产出物。把相关的设计稿、文档或文件链过来，方便追溯。
            </p>
          </section>
        </div>

        <footer
          class="save-bar"
          :class="`is-${saveUi}`"
          role="status"
          aria-live="polite"
        >
          <span class="save-dot" aria-hidden="true"></span>
          <span class="save-text">{{ saveLabel }}</span>
          <button
            v-if="saveUi === 'failed'"
            class="retry-button"
            type="button"
            @click="saveNow()"
          >
            重试
          </button>
          <span class="save-note">自动保存</span>
        </footer>
      </template>

      <div
        v-else-if="detailLoading"
        class="detail-skeleton"
        aria-label="正在加载问题详情"
      >
        <span class="skeleton-line" style="width: 52%; height: 24px"></span>
        <span class="skeleton-line" style="width: 38%; height: 12px"></span>
        <span class="skeleton-block"></span>
        <span class="skeleton-block"></span>
      </div>

      <div v-else-if="detailError" class="detail-state">
        <el-icon aria-hidden="true" :size="22"><WarningFilled /></el-icon>
        <p>{{ detailError }}</p>
        <button
          v-if="selectedId"
          class="text-button"
          type="button"
          @click="openIssue(selectedId, { force: true })"
        >
          <el-icon aria-hidden="true" :size="12"><ReloadOutlined /></el-icon
          >重新加载
        </button>
      </div>

      <div v-else class="detail-state detail-state--quiet">
        <span class="state-mark">↳</span>
        <p>从左侧选择一条问题，查看描述、结论与关联产出物。</p>
      </div>
    </section>
  </div>

  <!-- 弹窗挂在根级：空台账时双栏未渲染，弹窗仍需可用 -->
  <!-- ===== 关联产出物弹窗 ===== -->
  <el-dialog
    v-model="linkDialogVisible"
    title="关联产出物"
    width="min(460px, 92vw)"
    append-to-body
  >
    <div class="link-dialog-body" v-loading="treeLoading">
      <div
        v-for="row in treeRows"
        :key="row.item.id"
        class="tree-row"
        :style="{ paddingLeft: `${6 + row.depth * 16}px` }"
        @click="row.item.nodeType === 'folder' && toggleExpanded(row.item)"
      >
        <span
          v-if="row.item.nodeType === 'folder'"
          class="tree-caret"
          :class="{ expanded: expandedIds.has(row.item.id) }"
        >
          <el-icon aria-hidden="true" :size="11"><RightOutlined /></el-icon>
        </span>
        <span v-else class="tree-caret tree-caret--leaf"></span>
        <el-icon
          aria-hidden="true"
          class="tree-icon"
          :class="{ 'tree-icon--folder': row.item.nodeType === 'folder' }"
          :size="13"
        >
          <FileTypeIcon :node-type="row.item.nodeType" :name="row.item.name" />
        </el-icon>
        <span class="tree-name">{{ row.item.name }}</span>
        <el-checkbox
          class="tree-check"
          :model-value="checkedIds.includes(row.item.id)"
          :disabled="row.item.disabled"
          @click.stop
          @change="onTreeCheck(row.item, $event)"
        />
      </div>
      <p v-if="!artifactTree.length && !treeLoading" class="section-empty">
        暂无可关联的产出物。
      </p>
    </div>
    <template #footer>
      <el-button @click="linkDialogVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="linkSaving"
        :disabled="!checkedIds.length"
        @click="confirmLink()"
      >
        确定关联
      </el-button>
    </template>
  </el-dialog>

  <!-- ===== 新建问题弹窗 ===== -->
  <el-dialog
    v-model="createOpen"
    title="新增问题"
    width="min(520px, 92vw)"
    :close-on-click-modal="false"
    append-to-body
  >
    <div class="create-form">
      <label class="create-field">
        <span class="create-label">问题标题 <i>*</i></span>
        <el-input
          ref="createTitleInput"
          v-model="createTitle"
          maxlength="200"
          placeholder="一句话说清问题"
          @keydown.enter.prevent="submitCreate()"
        />
      </label>
      <div class="create-row">
        <label class="create-field">
          <span class="create-label">问题类型</span>
          <el-select v-model="createType" placeholder="未分类" clearable>
            <el-option
              v-for="option in typeOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </label>
        <label class="create-field">
          <span class="create-label">产生阶段</span>
          <el-select v-model="createStage">
            <el-option
              v-for="option in stageOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </label>
      </div>
      <label class="create-field">
        <span class="create-label">问题描述</span>
        <el-input
          v-model="createDesc"
          type="textarea"
          :rows="4"
          maxlength="5000"
          resize="none"
          placeholder="可选。创建后可在详情中补充图片与 Markdown。"
        />
      </label>
    </div>
    <template #footer>
      <el-button @click="createOpen = false">取消</el-button>
      <el-button type="primary" :loading="creating" @click="submitCreate()">
        创建问题
      </el-button>
    </template>
  </el-dialog>
</template>
<style scoped>
/* 状态/类型语义色：仅用于数据本身（点、标签、计数） */
.tone-blue {
  --tone-fg: var(--tone-blue-fg);
  --tone-bg: var(--tone-blue-bg);
  --tone-bd: var(--tone-blue-bd);
}
.tone-teal {
  --tone-fg: var(--tone-teal-fg);
  --tone-bg: var(--tone-teal-bg);
  --tone-bd: var(--tone-teal-bd);
}
.tone-green {
  --tone-fg: var(--tone-green-fg);
  --tone-bg: var(--tone-green-bg);
  --tone-bd: var(--tone-green-bd);
}
.tone-amber {
  --tone-fg: var(--tone-amber-fg);
  --tone-bg: var(--tone-amber-bg);
  --tone-bd: var(--tone-amber-bd);
}
.tone-purple {
  --tone-fg: var(--tone-purple-fg);
  --tone-bg: var(--tone-purple-bg);
  --tone-bd: var(--tone-purple-bd);
}
.tone-slate {
  --tone-fg: var(--tone-slate-fg);
  --tone-bg: var(--tone-slate-bg);
  --tone-bd: var(--tone-slate-bd);
}

.issue-app {
  display: grid;
  grid-template-columns: 332px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--border-base);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
}
.issue-rail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--border-base);
  background: var(--bg-subtle);
}
.rail-head {
  display: grid;
  flex: none;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-soft);
}
.issue-primary {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px 13px;
  border: 1px solid var(--brand);
  border-radius: 8px;
  background: var(--brand);
  color: #fff;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}
.issue-primary:hover {
  border-color: var(--brand-strong);
  background: var(--brand-strong);
}
.issue-primary--small {
  height: 30px;
  padding: 0 11px;
  font-size: 11.5px;
}
.issue-primary:focus-visible {
  outline: 2px solid var(--brand-ring);
  outline-offset: 2px;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.filter-select {
  flex: 1 1 0;
  min-width: 0;
}
.filter-select :deep(.el-select__wrapper) {
  min-height: 30px;
  border-radius: 7px;
  background: var(--bg-surface);
  box-shadow: 0 0 0 1px var(--border-base) inset;
  font-size: 11.5px;
}
.filter-select :deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px var(--border-brand) inset;
}
.search-box {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border-base);
  border-radius: 7px;
  background: var(--bg-surface);
  color: var(--text-faint);
}
.search-box:focus-within {
  border-color: var(--border-brand);
  outline: 2px solid var(--brand-ring);
  outline-offset: 0;
}
.search-box input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-body);
  font: inherit;
  font-size: 11.5px;
}
.search-box input::placeholder {
  color: var(--text-faint);
}
.search-box input::-webkit-search-cancel-button {
  display: none;
}
.search-clear {
  flex: none;
  padding: 0 1px;
  border: 0;
  background: none;
  color: var(--text-faint);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.search-clear:hover {
  color: var(--text-regular);
}
.search-button {
  flex: none;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border-base);
  border-radius: 7px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.search-button:hover {
  border-color: var(--border-brand);
  color: var(--brand);
}
.search-button:focus-visible {
  outline: 2px solid var(--brand-ring);
  outline-offset: 1px;
}

.rail-list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 9px 12px;
  transition: opacity 0.15s ease;
}
.rail-list.is-refreshing {
  opacity: 0.62;
}
.issue-row {
  position: relative;
  display: flex;
  gap: 9px;
  width: 100%;
  flex: none;
  padding: 10px 9px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.issue-row:hover {
  border-color: var(--border-soft);
  background: var(--bg-hover);
}
.issue-row.active {
  border-color: var(--border-base);
  background: var(--bg-surface);
}
.issue-row.active::before {
  position: absolute;
  top: 11px;
  bottom: 11px;
  left: -1px;
  width: 2px;
  border-radius: 2px;
  background: var(--brand);
  content: "";
}
.issue-row:focus-visible {
  outline: 2px solid var(--brand-ring);
  outline-offset: -1px;
}
.type-tile {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-top: 1px;
  border: 1px solid var(--border-soft);
  border-radius: 7px;
  background: var(--bg-surface);
  color: var(--tone-fg, var(--text-muted));
}
.issue-row:hover .type-tile {
  background: var(--bg-subtle);
}
.issue-row.active .type-tile {
  border-color: var(--border-base);
  background: var(--bg-subtle);
}
.row-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.row-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.row-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-title);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-pill {
  flex: none;
  height: 17px;
  padding: 0 5px;
  border: 1px solid var(--tone-bd, var(--border-base));
  border-radius: 4px;
  background: var(--tone-bg, var(--bg-subtle));
  color: var(--tone-fg, var(--text-muted));
  font-size: 9.5px;
  font-weight: 600;
  line-height: 15px;
}
.row-meta {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.4;
  white-space: nowrap;
}
.meta-sep {
  color: var(--border-line);
}
.row-time {
  flex: none;
  margin-left: auto;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.row-excerpt {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 10.8px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.rail-empty {
  display: grid;
  justify-items: center;
  gap: 9px;
  padding: 42px 14px;
  color: var(--text-muted);
  font-size: 11.5px;
  text-align: center;
}
.rail-empty p {
  margin: 0;
}
.rail-error {
  display: grid;
  justify-items: center;
  gap: 8px;
  padding: 36px 16px;
  color: var(--text-muted);
  font-size: 11.5px;
  text-align: center;
}
.rail-error p {
  margin: 0;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.text-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--brand);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.text-button:hover {
  text-decoration: underline;
}
.list-skeleton {
  display: grid;
  gap: 6px;
  padding: 4px 1px;
}
.skeleton-row {
  height: 76px;
  border-radius: 9px;
  background: var(--bg-hover);
  animation: skeleton-pulse 1.2s ease-in-out infinite;
}

/* 右栏：白色纸面，标题、字段、正文按阅读顺序排列 */
.detail-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg-surface);
}
.detail-head {
  display: grid;
  flex: none;
  gap: 8px;
  padding: 14px 24px 12px;
  border-bottom: 1px solid var(--border-soft);
}
.back-button {
  display: none;
  justify-self: start;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border: 1px solid var(--border-base);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.ghost-danger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--border-base);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-muted);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.ghost-danger:hover {
  border-color: var(--tone-red-bd);
  background: var(--tone-red-bg);
  color: var(--tone-red-fg);
}
.title-input {
  width: 100%;
  margin: 0;
  padding: 2px 5px;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 6px;
  outline: 0;
  background: transparent;
  color: var(--text-heading);
  font: inherit;
  font-size: 21px;
  font-weight: 650;
  line-height: 1.38;
  letter-spacing: -0.35px;
  resize: none;
}
.title-input:hover {
  background: var(--bg-subtle);
}
.title-input:focus {
  border-color: var(--border-brand);
  background: var(--bg-surface);
}
.title-input.invalid {
  border-color: var(--tone-red-bd);
  background: var(--tone-red-bg);
}
.meta-row {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 8px 13px;
}
.meta-field {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.meta-label {
  color: var(--text-muted);
  font-size: 9.5px;
  letter-spacing: 0.05em;
}
.meta-field :deep(.el-select) {
  width: 142px;
}
.meta-field--stage :deep(.el-select) {
  width: 118px;
}
.meta-field--status :deep(.el-select) {
  width: 112px;
}
.meta-field :deep(.el-select__wrapper) {
  min-height: 27px;
  border-radius: 6px;
  background: var(--bg-surface);
  box-shadow: 0 0 0 1px var(--border-base) inset;
  font-size: 11.5px;
}
.meta-field :deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px var(--brand) inset;
}
.status-select :deep(.el-select__wrapper) {
  background: var(--tone-bg);
  box-shadow: 0 0 0 1px var(--tone-bd) inset;
}
.status-select :deep(.el-select__selected-item) {
  color: var(--tone-fg);
  font-weight: 600;
}
.status-select :deep(.el-select__caret) {
  color: var(--tone-fg);
}
.status-select :deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px var(--tone-fg) inset;
}
.meta-times {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 2px 11px;
  margin-left: auto;
  padding-bottom: 5px;
  color: var(--text-faint);
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
}
.resolved-time {
  color: var(--tone-green-fg);
}
.ai-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 150px;
  padding: 0 5px;
  border-radius: 4px;
  color: var(--tone-blue-fg);
  background: var(--tone-blue-bg);
  box-shadow: 0 0 0 1px var(--tone-blue-bd) inset;
  font-size: 9px;
  font-weight: 600;
  line-height: 1.6;
}
.ai-badge-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta-delete {
  margin-left: 2px;
  padding: 2px 6px;
  font-size: 10px;
  line-height: 1.5;
}

.detail-body {
  display: grid;
  flex: 1 1 auto;
  align-content: start;
  gap: 18px;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 22px;
}
.detail-section {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 20px;
}
.section-title {
  margin: 0;
  color: var(--text-title);
  font-size: 11.5px;
  font-weight: 650;
  letter-spacing: 0.01em;
  line-height: 1.4;
}
.section-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  height: 15px;
  margin-left: 4px;
  padding: 0 4px;
  border: 1px solid var(--border-base);
  border-radius: 4px;
  background: var(--bg-subtle);
  color: var(--text-muted);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  vertical-align: 1px;
}
.section-note {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  color: var(--text-faint);
  font-size: 9.5px;
}
.section-note.is-warn {
  color: var(--tone-amber-fg);
}
.section-action {
  margin-left: auto;
  font-size: 10.5px;
}
.section-empty {
  margin: 0;
  color: var(--text-faint);
  font-size: 10.8px;
  line-height: 1.65;
}
.detail-section :deep(.inline-rich) {
  border-radius: 8px;
}
.asset-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.asset-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  height: 26px;
  padding: 0 3px 0 7px;
  border: 1px solid var(--border-base);
  border-radius: 6px;
  background: var(--bg-subtle);
  color: var(--text-regular);
  font-size: 10.5px;
}
.asset-chip :deep(.el-icon) {
  flex: none;
  color: var(--text-faint);
}
.asset-name {
  overflow: hidden;
  max-width: 240px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-rel {
  flex: none;
  color: var(--text-faint);
  font-size: 9.5px;
}
.chip-remove {
  flex: none;
  padding: 1px 4px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--text-faint);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.chip-remove:hover {
  background: var(--tone-red-bg);
  color: var(--tone-red-fg);
}

.save-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 7px;
  min-height: 36px;
  padding: 8px 24px;
  border-top: 1px solid var(--border-base);
  background: var(--bg-subtle);
  color: var(--text-muted);
  font-size: 10.5px;
}
.save-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--tone-green-fg);
}
.save-bar.is-pending .save-dot {
  background: var(--tone-amber-fg);
}
.save-bar.is-saving .save-dot {
  background: var(--brand);
  animation: save-pulse 1s ease-in-out infinite;
}
.save-bar.is-failed {
  color: var(--danger-text);
}
.save-bar.is-failed .save-dot {
  background: var(--danger-text);
}
.save-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.save-note {
  flex: none;
  margin-left: auto;
  color: var(--text-faint);
  font-size: 9.5px;
}
.retry-button {
  flex: none;
  padding: 2px 8px;
  border: 1px solid var(--tone-red-bd);
  border-radius: 5px;
  background: var(--tone-red-bg);
  color: var(--danger-text);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}

.detail-skeleton {
  display: grid;
  flex: 1;
  align-content: start;
  gap: 14px;
  padding: 24px;
}
.skeleton-line,
.skeleton-block {
  border-radius: 6px;
  background: var(--bg-hover);
  animation: skeleton-pulse 1.2s ease-in-out infinite;
}
.skeleton-line {
  height: 12px;
}
.skeleton-block {
  height: 190px;
  border-radius: 8px;
}
.detail-state {
  display: grid;
  flex: 1;
  place-content: center;
  justify-items: center;
  gap: 9px;
  padding: 40px;
  color: var(--text-muted);
  font-size: 11.5px;
  text-align: center;
}
.detail-state p {
  max-width: 360px;
  margin: 0;
  line-height: 1.7;
}
.detail-state .el-icon {
  color: var(--text-faint);
}
.state-mark {
  color: var(--border-line);
  font-size: 24px;
  line-height: 1;
}
.detail-state--quiet {
  color: var(--text-faint);
}

/* 空台账 */
.issue-empty {
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(0, 0.92fr);
  height: 100%;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--border-base);
  border-radius: 12px;
  background: var(--bg-surface);
}
.empty-ledger {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  padding: 52px 48px;
}
.empty-kicker {
  color: var(--brand);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
}
.empty-ledger h2 {
  margin: 13px 0 12px;
  color: var(--text-heading);
  font-size: 31px;
  font-weight: 650;
  line-height: 1.28;
  letter-spacing: -0.7px;
}
.empty-ledger p {
  max-width: 390px;
  margin: 0 0 23px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.85;
}
.empty-ledger .issue-primary {
  padding: 10px 15px;
  font-size: 12px;
}
.empty-side {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 17px;
  padding: 52px 42px;
  border-left: 1px solid var(--border-soft);
  background: var(--bg-subtle);
}
.empty-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.empty-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border: 1px solid var(--tone-bd, var(--border-base));
  border-radius: 5px;
  background: var(--tone-bg, var(--bg-surface));
  color: var(--tone-fg, var(--text-muted));
  font-size: 10px;
}
.empty-chip b {
  font-weight: 500;
  opacity: 0.6;
}
.empty-rule {
  height: 1px;
  background: var(--border-base);
}
.empty-lines {
  display: grid;
  gap: 10px;
}
.empty-line {
  height: 7px;
  border-radius: 4px;
  background: var(--border-soft);
}
.empty-caption {
  color: var(--text-faint);
  font-size: 9.5px;
  letter-spacing: 0.08em;
}

/* 关联弹窗 */
.link-dialog-body {
  display: grid;
  gap: 1px;
  min-height: 120px;
  max-height: 360px;
  overflow: auto;
}
.tree-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: default;
  user-select: none;
}
.tree-row:hover {
  background: var(--bg-hover);
}
.tree-caret {
  display: inline-flex;
  flex: none;
  width: 14px;
  color: var(--text-faint);
  transition: transform 0.15s ease;
}
.tree-caret.expanded {
  transform: rotate(90deg);
}
.tree-caret--leaf {
  visibility: hidden;
}
.tree-icon {
  flex: none;
  color: var(--text-faint);
}
.tree-icon--folder {
  color: var(--tone-amber-fg);
}
.tree-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-regular);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-check {
  flex: none;
  height: auto;
}
.tree-check :deep(.el-checkbox__label) {
  display: none;
}

/* 新建弹窗 */
.create-form {
  display: grid;
  gap: 14px;
}
.create-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.create-field {
  display: grid;
  gap: 6px;
}
.create-label {
  color: var(--text-secondary);
  font-size: 11px;
}
.create-label i {
  color: var(--danger-text);
  font-style: normal;
}

@keyframes save-pulse {
  50% {
    opacity: 0.32;
  }
}
@keyframes skeleton-pulse {
  50% {
    opacity: 0.55;
  }
}
@media (prefers-reduced-motion: reduce) {
  .save-bar.is-saving .save-dot,
  .skeleton-row,
  .skeleton-line,
  .skeleton-block {
    animation: none;
  }
  .tree-caret,
  .rail-list {
    transition: none;
  }
}

@media (max-width: 1180px) {
  .issue-app {
    grid-template-columns: 300px minmax(0, 1fr);
  }
  .meta-times {
    width: 100%;
    justify-content: flex-start;
    margin-left: 0;
    padding-bottom: 0;
  }
}
/* 单栏：列表与详情互斥，详情提供返回按钮 */
@media (max-width: 980px) {
  .issue-app {
    grid-template-columns: minmax(0, 1fr);
  }
  .issue-rail {
    border-right: 0;
  }
  .detail-pane {
    display: none;
  }
  .issue-app.detail-open .issue-rail {
    display: none;
  }
  .issue-app.detail-open .detail-pane {
    display: flex;
  }
  .back-button {
    display: inline-flex;
  }
  .rail-head {
    padding: 14px 13px 10px;
  }
  .detail-head {
    padding: 13px 15px 12px;
  }
  .detail-body {
    padding: 16px 15px 20px;
  }
  .save-bar {
    padding: 8px 15px;
  }
  .issue-empty {
    grid-template-columns: minmax(0, 1fr);
  }
  .empty-side {
    display: none;
  }
  .empty-ledger {
    padding: 40px 28px;
  }
}
@media (max-width: 640px) {
  .title-input {
    font-size: 19px;
  }
  .meta-field {
    flex: 1 1 calc(50% - 7px);
  }
  .meta-field :deep(.el-select) {
    width: 100%;
  }
  .meta-field--status {
    flex-basis: 100%;
  }
  .section-note {
    display: none;
  }
  .save-note {
    display: none;
  }
  .empty-ledger {
    padding: 32px 22px;
  }
  .empty-ledger h2 {
    font-size: 26px;
  }
  .create-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
<style>
/* 深色模式下填充品牌色的按钮改用深色文字，保证对比度 */
html.dark .issue-primary {
  color: #0f131b;
}
</style>
