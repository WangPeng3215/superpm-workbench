<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  ArrowDown,
  Document,
  Folder,
  Grid,
  Link as LinkIcon,
  MoreFilled,
  Picture,
  Plus,
  Refresh,
  Search,
  Sort,
} from "@element-plus/icons-vue";
import {
  artifactMemoryName,
  artifactStatusLabels,
  requirementImagesFolder,
  requirementWorkspaceStageLabels,
  type ArtifactDirectory,
  type ArtifactLink,
  type ArtifactNode,
  type RequirementWorkspaceStage,
  type RequirementWorkspaceState,
} from "@superpm/shared";
import { artifactApi } from "../../api/artifacts";
import { ApiError, errorMessage, request } from "../../api/client";

// 需求知识库卡片视图（文档管理 tab）：UI 只做展示与交互编排，业务规则全部在服务层
const props = defineProps<{ requirementId: number; requirementName: string }>();
const emit = defineEmits<{
  (e: "open-doc", node: ArtifactNode): void;
  (e: "doc-deleted", nodeId: number): void;
}>();

const parentId = ref<number | null>(null);
const directory = ref<ArtifactDirectory>();
const loading = ref(false);
const error = ref("");
const keyword = ref("");
const sortKey = ref<"name" | "time" | "type">("name");
const sortOrder = ref<"asc" | "desc">("asc");
const previewSrc = ref("");
const systemOpen = ref(false);
const searching = computed(() => Boolean(directory.value?.search));
const crumbs = computed(() => directory.value?.breadcrumb ?? []);
const isEmpty = computed(
  () =>
    (directory.value?.folders.length ?? 0) +
      (directory.value?.files.length ?? 0) +
      (directory.value?.links.length ?? 0) ===
    0,
);
const emptyText = computed(() =>
  searching.value
    ? `没有匹配「${directory.value?.search}」的文件`
    : "此目录为空，点击右上角「新建」添加内容",
);
// 打开策略（文档 2.6）：md→左栏编辑器；图片→页内预览；pdf→新窗口预览；其余→本地打开或下载，未知格式永不自动执行
const imageExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
]);
const iconMap: Record<string, typeof Document> = {
  picture: Picture,
  grid: Grid,
  document: Document,
};
const isMemory = (node: ArtifactNode) =>
  node.nodeType === "file" && node.relativePath === artifactMemoryName;
// 系统级资源（文档 §12.3）：需求记忆文件与根目录 images/ 不可改名、移动、删除。
// 前端仅隐藏入口，最终约束在服务层强制执行（MCP 等其它调用方同样受约束）。
const isProtected = (node: ArtifactNode) =>
  node.relativePath === artifactMemoryName ||
  node.relativePath === requirementImagesFolder;
function extensionOf(node: ArtifactNode) {
  return node.extension ?? "";
}
function fileIcon(node: ArtifactNode) {
  const extension = extensionOf(node);
  if (imageExtensions.has(extension)) return iconMap.picture;
  if ([".xlsx", ".xls", ".csv"].includes(extension)) return iconMap.grid;
  return iconMap.document;
}
function formatSize(bytes: number | null) {
  if (bytes === null || bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
function metaOf(node: ArtifactNode) {
  // 搜索结果为跨目录平铺，卡片展示需求内相对路径便于定位
  if (searching.value) return node.relativePath;
  if (node.nodeType === "folder") return `${node.childCount ?? 0} 个子项`;
  return [
    extensionOf(node).replace(".", "").toUpperCase() || "文件",
    formatSize(node.sizeBytes),
    formatTime(node.modifiedAt),
  ]
    .filter(Boolean)
    .join(" · ");
}
// ===== 排序（纯展示逻辑）=====
function sortNodes(list: ArtifactNode[]) {
  const direction = sortOrder.value === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    if (a.nodeType !== b.nodeType) return a.nodeType === "folder" ? -1 : 1;
    if (sortKey.value === "time")
      return (
        direction *
        ((a.modifiedAt ?? "").localeCompare(b.modifiedAt ?? "") ||
          a.name.localeCompare(b.name, "zh-Hans-CN"))
      );
    if (sortKey.value === "type")
      return (
        direction *
        ((a.extension ?? "").localeCompare(b.extension ?? "") ||
          a.name.localeCompare(b.name, "zh-Hans-CN"))
      );
    return direction * a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}
function sortLinks(list: ArtifactLink[]) {
  const direction = sortOrder.value === "asc" ? 1 : -1;
  return [...list].sort(
    (a, b) => direction * a.name.localeCompare(b.name, "zh-Hans-CN"),
  );
}
const foldersView = computed(() => sortNodes(directory.value?.folders ?? []));
const filesView = computed(() => sortNodes(directory.value?.files ?? []));
const linksView = computed(() => sortLinks(directory.value?.links ?? []));
// ===== 需求目录初始化状态（文档 §12.5）=====
const workspace = ref<RequirementWorkspaceState>();
const workspaceBusy = ref(false);
// 仅在有异常时提示：初始化失败、目录缺失、系统级资源被外部删除
const workspaceAlert = computed(() => {
  const state = workspace.value;
  if (!state) return null;
  if (state.status === "failed")
    return {
      type: "error" as const,
      title: "需求目录初始化失败",
      description: `${state.failureReason ?? "未知原因"}（阶段：${workspaceStageLabel(state.failureStage)}）`,
      action: "重试初始化",
    };
  if (!state.directoryExists)
    return {
      type: "warning" as const,
      title: "需求目录缺失",
      description: `磁盘上未找到 ${state.relativePath}，初始化后会自动重建默认结构。`,
      action: "立即初始化",
    };
  if (state.missingResources.length)
    return {
      type: "warning" as const,
      title: "系统级资源缺失",
      description: `缺少 ${state.missingResources.join("、")}，可能已被外部删除。`,
      action: "修复默认结构",
    };
  return null;
});
function workspaceStageLabel(stage: RequirementWorkspaceStage | null) {
  if (!stage) return "未知";
  return requirementWorkspaceStageLabels[stage];
}
async function loadWorkspace() {
  try {
    workspace.value = await artifactApi.directory(props.requirementId);
  } catch {
    // 状态查询失败不干扰文档浏览：错误已在主列表流程中呈现
    workspace.value = undefined;
  }
}
async function fixWorkspace() {
  const state = workspace.value;
  if (!state) return;
  workspaceBusy.value = true;
  try {
    workspace.value =
      state.status === "failed" || !state.directoryExists
        ? await artifactApi.initializeDirectory(props.requirementId)
        : await artifactApi.repairDirectory(props.requirementId);
    ElMessage.success("需求目录已就绪");
    await load();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    workspaceBusy.value = false;
  }
}
// ===== 数据加载 =====
async function load() {
  const requirementId = props.requirementId;
  loading.value = true;
  error.value = "";
  try {
    const result = await artifactApi.list(
      requirementId,
      searching.value ? null : parentId.value,
      keyword.value.trim(),
    );
    if (requirementId !== props.requirementId) return;
    directory.value = result;
  } catch (e) {
    if (requirementId === props.requirementId) error.value = errorMessage(e);
  } finally {
    if (requirementId === props.requirementId) loading.value = false;
  }
}
watch(
  () => props.requirementId,
  () => {
    parentId.value = null;
    keyword.value = "";
    void load();
    void loadWorkspace();
  },
  { immediate: true },
);
// 名称搜索防抖（服务端做全需求范围搜索）
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(keyword, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void load(), 400);
});
function enter(folder: ArtifactNode) {
  keyword.value = "";
  parentId.value = folder.id;
  void load();
}
function goCrumb(index: number) {
  const crumb = crumbs.value[index];
  if (!crumb || index === crumbs.value.length - 1) return;
  keyword.value = "";
  parentId.value = crumb.id;
  void load();
}
async function refresh() {
  try {
    const result = await artifactApi.refresh(
      props.requirementId,
      searching.value ? undefined : directory.value?.parentPath || undefined,
    );
    const total = result.added + result.updated + result.missing;
    if (total > 0)
      ElMessage.success(
        `已刷新目录：新增 ${result.added}，更新 ${result.updated}，缺失 ${result.missing}`,
      );
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
  await load();
  // 刷新后重新比对磁盘：外部删除的系统级资源要立刻在提示条里可见（文档 §12.3）
  await loadWorkspace();
}
// ===== 打开策略 =====
async function openFile(node: ArtifactNode) {
  if (node.status === "missing") {
    ElMessage.warning("文件在磁盘上已缺失，请先刷新目录或从磁盘恢复后重试。");
    return;
  }
  const extension = extensionOf(node);
  if ([".md", ".markdown"].includes(extension)) {
    emit("open-doc", node);
    return;
  }
  if (imageExtensions.has(extension)) {
    previewSrc.value = artifactApi.rawUrl(node.id);
    return;
  }
  if (extension === ".pdf") {
    window.open(artifactApi.rawUrl(node.id), "_blank", "noopener");
    return;
  }
  if (systemOpen.value) {
    try {
      await artifactApi.openLocally(node.id);
      return;
    } catch (e) {
      ElMessage.warning(errorMessage(e));
    }
  }
  // 无本地打开通道时交由浏览器处理（未知格式不自动执行，仅展示或触发下载）
  window.open(artifactApi.rawUrl(node.id));
}
function openLink(link: ArtifactLink) {
  window.open(link.url, "_blank", "noopener,noreferrer");
}
onMounted(async () => {
  try {
    const system = await request<{ systemOpenAvailable?: boolean }>("/system");
    systemOpen.value = system.systemOpenAvailable === true;
  } catch {
    systemOpen.value = false;
  }
});
// ===== 新建 / 重命名 / 移动 / 删除 =====
const createDialogVisible = ref(false);
const createKind = ref<"folder" | "file" | "link">("folder");
const createForm = ref({ name: "", url: "", description: "" });
const createSaving = ref(false);
const renameVisible = ref(false);
const renameTarget = ref<ArtifactNode>();
const renameForm = ref({ name: "" });
const linkEditVisible = ref(false);
const linkEditTarget = ref<ArtifactLink>();
const linkEditForm = ref({ name: "", url: "", description: "" });
const moveTargetNode = ref<ArtifactNode>();
const moveTargetLink = ref<ArtifactLink>();
const moveVisible = ref(false);
const moveTarget = ref(0);
const moveSaving = ref(false);
function onCreateCommand(command: string | number | object) {
  createKind.value = command as "folder" | "file" | "link";
  createForm.value = { name: "", url: "", description: "" };
  createDialogVisible.value = true;
}
async function submitCreate() {
  if (createSaving.value) return;
  const requirementId = props.requirementId;
  const parentIdValue = searching.value ? null : parentId.value;
  createSaving.value = true;
  try {
    if (createKind.value === "link") {
      if (!createForm.value.name.trim() || !createForm.value.url.trim()) {
        ElMessage.warning("请填写链接名称与地址");
        return;
      }
      await artifactApi.createLink(requirementId, {
        folderNodeId: parentIdValue,
        name: createForm.value.name,
        url: createForm.value.url.trim(),
        description: createForm.value.description.trim() || undefined,
      });
    } else if (!createForm.value.name.trim()) {
      ElMessage.warning(
        createKind.value === "folder"
          ? "请输入文件夹名称"
          : "请输入文件名称（可含扩展名，如 方案.md）",
      );
      return;
    } else if (createKind.value === "folder") {
      await artifactApi.createFolder(
        requirementId,
        parentIdValue,
        createForm.value.name,
      );
    } else {
      await artifactApi.createFile(
        requirementId,
        parentIdValue,
        createForm.value.name,
      );
    }
    createDialogVisible.value = false;
    ElMessage.success("创建成功");
    await load();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    createSaving.value = false;
  }
}
async function startRename(node: ArtifactNode) {
  renameTarget.value = node;
  renameForm.value = { name: node.name };
  renameVisible.value = true;
}
async function submitRename() {
  const node = renameTarget.value;
  if (!node || !renameForm.value.name.trim()) {
    ElMessage.warning("请输入名称");
    return;
  }
  try {
    await artifactApi.rename(node.id, renameForm.value.name);
    renameVisible.value = false;
    renameTarget.value = undefined;
    ElMessage.success("已重命名");
    await load();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}
function startLinkEdit(link: ArtifactLink) {
  linkEditTarget.value = link;
  linkEditForm.value = {
    name: link.name,
    url: link.url,
    description: link.description ?? "",
  };
  linkEditVisible.value = true;
}
async function submitLinkEdit() {
  const link = linkEditTarget.value;
  if (!link) return;
  if (!linkEditForm.value.name.trim() || !linkEditForm.value.url.trim()) {
    ElMessage.warning("请填写链接名称与地址");
    return;
  }
  try {
    await artifactApi.updateLink(link.id, {
      name: linkEditForm.value.name,
      url: linkEditForm.value.url.trim(),
      description: linkEditForm.value.description.trim() || null,
    });
    linkEditVisible.value = false;
    linkEditTarget.value = undefined;
    ElMessage.success("链接已更新");
    await load();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}
// 移动目标树：根节点为需求根目录（id=0 提交时映射为 null）
function startMove(target: ArtifactNode | ArtifactLink) {
  if ("nodeType" in target) moveTargetNode.value = target;
  else moveTargetLink.value = target;
  moveTarget.value =
    ("nodeType" in target ? target.parentId : target.folderNodeId) ?? 0;
  moveVisible.value = true;
}
async function loadMoveTree(
  node: { data?: { id?: number } | null; level: number },
  resolve: (
    children: { id: number; name: string; disabled?: boolean }[],
  ) => void,
) {
  // 第 0 层提供"需求根目录"虚拟节点（id=0，提交时映射为 null），其子级为根目录下的文件夹
  if (node.level === 0) {
    resolve([{ id: 0, name: props.requirementName }]);
    return;
  }
  const parentIdValue = node.data?.id === 0 ? null : (node.data?.id ?? null);
  try {
    const dir = await artifactApi.list(props.requirementId, parentIdValue);
    resolve(
      dir.folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        disabled: moveTargetNode.value?.id === folder.id,
      })),
    );
  } catch (e) {
    ElMessage.error(errorMessage(e));
    resolve([]);
  }
}
async function submitMove() {
  const targetParentId = moveTarget.value === 0 ? null : moveTarget.value;
  moveSaving.value = true;
  try {
    if (moveTargetNode.value)
      await artifactApi.move(moveTargetNode.value.id, targetParentId);
    else if (moveTargetLink.value)
      await artifactApi.updateLink(moveTargetLink.value.id, {
        folderNodeId: targetParentId,
      });
    moveVisible.value = false;
    moveTargetNode.value = undefined;
    moveTargetLink.value = undefined;
    ElMessage.success("已移动");
    await load();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    moveSaving.value = false;
  }
}
async function removeNode(node: ArtifactNode) {
  if (isMemory(node)) {
    ElMessage.warning("需求记忆文件不可删除");
    return;
  }
  try {
    await ElMessageBox.confirm(
      node.nodeType === "folder"
        ? `确定删除文件夹「${node.name}」吗？`
        : `确定删除文件「${node.name}」吗？删除后不可恢复。`,
      "删除确认",
      {
        confirmButtonText: "确认删除",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
  } catch {
    return;
  }
  try {
    // 非空目录第一次请求会得到 409 与影响范围，再二次确认后递归删除
    await artifactApi.remove(node.id, false);
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== "CONFLICT") {
      ElMessage.error(errorMessage(e));
      return;
    }
    try {
      await ElMessageBox.confirm(
        `${e.message}。是否继续删除？`,
        "删除非空目录",
        {
          confirmButtonText: "确认删除",
          cancelButtonText: "取消",
          type: "warning",
        },
      );
    } catch {
      return;
    }
    try {
      await artifactApi.remove(node.id, true);
    } catch (retryError) {
      ElMessage.error(errorMessage(retryError));
      return;
    }
  }
  ElMessage.success("已删除");
  emit("doc-deleted", node.id);
  await load();
}
async function removeLink(link: ArtifactLink) {
  try {
    await ElMessageBox.confirm(
      `确定删除链接「${link.name}」吗？仅移除记录，不影响外部页面。`,
      "删除链接",
      {
        confirmButtonText: "确认删除",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
  } catch {
    return;
  }
  try {
    await artifactApi.removeLink(link.id);
    ElMessage.success("链接已删除");
    await load();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}
async function downloadFile(node: ArtifactNode) {
  window.open(artifactApi.rawUrl(node.id, true));
}
async function openLocally(node: ArtifactNode, reveal = false) {
  try {
    await artifactApi.openLocally(node.id, { reveal });
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}
function onFileCommand(command: string | number | object, node: ArtifactNode) {
  const action = String(command);
  if (action === "open") void openFile(node);
  else if (action === "download") void downloadFile(node);
  else if (action === "open-locally") void openLocally(node);
  else if (action === "reveal") void openLocally(node, true);
  else if (action === "rename") void startRename(node);
  else if (action === "move") startMove(node);
  else if (action === "delete") void removeNode(node);
}
function onFolderCommand(
  command: string | number | object,
  node: ArtifactNode,
) {
  const action = String(command);
  if (action === "enter") enter(node);
  else if (action === "open-folder") void openLocally(node);
  else if (action === "rename") void startRename(node);
  else if (action === "move") startMove(node);
  else if (action === "delete") void removeNode(node);
}
function onLinkCommand(command: string | number | object, link: ArtifactLink) {
  const action = String(command);
  if (action === "open") openLink(link);
  else if (action === "edit") startLinkEdit(link);
  else if (action === "move") startMove(link);
  else if (action === "delete") void removeLink(link);
}
</script>
<template>
  <section class="doc-manager" aria-label="需求知识库">
    <header class="doc-toolbar">
      <nav class="doc-breadcrumb" aria-label="目录路径">
        <template v-for="(crumb, index) in crumbs" :key="crumb.id ?? 'root'">
          <span v-if="index" class="crumb-sep">/</span>
          <button
            type="button"
            class="crumb"
            :class="{ current: index === crumbs.length - 1 }"
            :disabled="index === crumbs.length - 1 || searching"
            @click="goCrumb(index)"
          >
            {{ crumb.name }}
          </button>
        </template>
      </nav>
      <div class="doc-tools">
        <el-input
          v-model="keyword"
          class="doc-search"
          placeholder="搜索文件名"
          clearable
          :prefix-icon="Search"
        />
        <el-select v-model="sortKey" class="doc-sort" aria-label="排序方式">
          <el-option label="按名称" value="name" />
          <el-option label="按修改时间" value="time" />
          <el-option label="按类型" value="type" />
        </el-select>
        <el-tooltip :content="sortOrder === 'asc' ? '升序' : '降序'">
          <el-button
            class="sort-order-btn"
            :icon="Sort"
            :aria-label="sortOrder === 'asc' ? '切换为降序' : '切换为升序'"
            @click="sortOrder = sortOrder === 'asc' ? 'desc' : 'asc'"
          />
        </el-tooltip>
        <el-dropdown
          trigger="click"
          :disabled="searching"
          @command="onCreateCommand"
        >
          <el-button type="primary" plain :disabled="searching">
            <el-icon><Plus /></el-icon>新建<el-icon class="el-icon--right"
              ><ArrowDown
            /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="folder">新建文件夹</el-dropdown-item>
              <el-dropdown-item command="file">新建文件</el-dropdown-item>
              <el-dropdown-item command="link">新建链接</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-tooltip content="扫描磁盘并同步索引">
          <el-button
            class="refresh-btn"
            :icon="Refresh"
            aria-label="刷新目录"
            @click="refresh"
          />
        </el-tooltip>
      </div>
    </header>
    <el-alert
      v-if="workspaceAlert"
      class="workspace-alert"
      :type="workspaceAlert.type"
      :title="workspaceAlert.title"
      :closable="false"
      show-icon
    >
      <div class="workspace-alert-body">
        <span>{{ workspaceAlert.description }}</span>
        <el-button
          class="workspace-fix-btn"
          size="small"
          :loading="workspaceBusy"
          @click="fixWorkspace"
        >
          {{ workspaceAlert.action }}
        </el-button>
      </div>
    </el-alert>
    <div v-loading="loading" class="doc-body">
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        show-icon
        :closable="false"
      />
      <div v-else-if="isEmpty" class="doc-empty">
        <el-empty :description="emptyText" />
      </div>
      <div v-else class="doc-grid">
        <article
          v-for="folder in foldersView"
          :key="`f-${folder.id}`"
          class="doc-card is-folder"
          :data-name="folder.name"
          tabindex="0"
          @click="enter(folder)"
          @keydown.enter="enter(folder)"
        >
          <div class="doc-card-icon folder">
            <el-icon><Folder /></el-icon>
          </div>
          <h3 class="doc-card-name" :title="folder.name">
            <span class="name-text">{{ folder.name }}</span>
            <el-tag
              v-if="isProtected(folder)"
              class="memory-tag"
              size="small"
              effect="plain"
              >系统目录</el-tag
            >
          </h3>
          <p class="doc-card-meta">{{ metaOf(folder) }}</p>
          <el-dropdown
            class="doc-card-more"
            trigger="click"
            @command="
              (command: string | number | object) =>
                onFolderCommand(command, folder)
            "
          >
            <button
              type="button"
              class="doc-more-btn"
              :aria-label="`「${folder.name}」操作菜单`"
              @click.stop
            >
              <el-icon><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="enter">进入</el-dropdown-item>
                <el-dropdown-item v-if="systemOpen" command="open-folder"
                  >在资源管理器中打开</el-dropdown-item
                >
                <el-dropdown-item v-if="!isProtected(folder)" command="rename"
                  >重命名</el-dropdown-item
                >
                <el-dropdown-item v-if="!isProtected(folder)" command="move"
                  >移动到…</el-dropdown-item
                >
                <el-dropdown-item
                  v-if="!isProtected(folder)"
                  command="delete"
                  divided
                  >删除</el-dropdown-item
                >
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </article>
        <article
          v-for="file in filesView"
          :key="`n-${file.id}`"
          class="doc-card is-file"
          :class="{ 'is-missing': file.status === 'missing' }"
          :data-name="file.name"
          tabindex="0"
          @click="openFile(file)"
          @keydown.enter="openFile(file)"
        >
          <div class="doc-card-icon file">
            <el-icon><component :is="fileIcon(file)" /></el-icon>
          </div>
          <h3 class="doc-card-name" :title="file.name">
            <span class="name-text">{{ file.name }}</span>
            <el-tag
              v-if="isMemory(file)"
              class="memory-tag"
              size="small"
              effect="plain"
              >需求记忆</el-tag
            >
          </h3>
          <p class="doc-card-meta">{{ metaOf(file) }}</p>
          <el-tag
            v-if="file.status !== 'normal'"
            class="doc-card-status"
            size="small"
            type="warning"
            >{{ artifactStatusLabels[file.status] }}</el-tag
          >
          <el-dropdown
            class="doc-card-more"
            trigger="click"
            @command="
              (command: string | number | object) =>
                onFileCommand(command, file)
            "
          >
            <button
              type="button"
              class="doc-more-btn"
              :aria-label="`「${file.name}」操作菜单`"
              @click.stop
            >
              <el-icon><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="open">打开</el-dropdown-item>
                <el-dropdown-item command="download">下载</el-dropdown-item>
                <el-dropdown-item v-if="systemOpen" command="open-locally"
                  >本地程序打开</el-dropdown-item
                >
                <el-dropdown-item v-if="systemOpen" command="reveal"
                  >在文件夹中显示</el-dropdown-item
                >
                <el-dropdown-item
                  v-if="!isProtected(file)"
                  command="rename"
                  divided
                  >重命名</el-dropdown-item
                >
                <el-dropdown-item v-if="!isProtected(file)" command="move"
                  >移动到…</el-dropdown-item
                >
                <el-dropdown-item
                  v-if="!isProtected(file)"
                  command="delete"
                  divided
                  >删除</el-dropdown-item
                >
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </article>
        <article
          v-for="link in linksView"
          :key="`l-${link.id}`"
          class="doc-card is-link"
          :data-name="link.name"
          tabindex="0"
          @click="openLink(link)"
          @keydown.enter="openLink(link)"
        >
          <div class="doc-card-icon link">
            <el-icon><LinkIcon /></el-icon>
          </div>
          <h3 class="doc-card-name" :title="link.name">{{ link.name }}</h3>
          <p class="doc-card-meta">
            {{ hostOf(link.url) }}
            <span v-if="link.description" class="link-desc"
              >· {{ link.description }}</span
            >
          </p>
          <el-dropdown
            class="doc-card-more"
            trigger="click"
            @command="
              (command: string | number | object) =>
                onLinkCommand(command, link)
            "
          >
            <button
              type="button"
              class="doc-more-btn"
              :aria-label="`「${link.name}」操作菜单`"
              @click.stop
            >
              <el-icon><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="open">打开链接</el-dropdown-item>
                <el-dropdown-item command="edit">编辑</el-dropdown-item>
                <el-dropdown-item command="move">移动到…</el-dropdown-item>
                <el-dropdown-item command="delete" divided
                  >删除</el-dropdown-item
                >
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </article>
      </div>
    </div>
    <!-- 新建（文件夹 / 文件 / 链接） -->
    <el-dialog
      v-model="createDialogVisible"
      :title="
        createKind === 'folder'
          ? '新建文件夹'
          : createKind === 'file'
            ? '新建文件'
            : '新建链接'
      "
      width="420px"
    >
      <form class="dialog-form" @submit.prevent="submitCreate">
        <label class="dialog-field">
          <span>{{ createKind === "link" ? "链接名称" : "名称" }}</span>
          <el-input
            v-model="createForm.name"
            :placeholder="
              createKind === 'folder'
                ? '输入文件夹名称'
                : createKind === 'file'
                  ? '输入文件名称，可含扩展名，如 方案.md'
                  : '输入链接名称'
            "
            maxlength="200"
          />
        </label>
        <label v-if="createKind === 'link'" class="dialog-field">
          <span>链接地址</span>
          <el-input
            v-model="createForm.url"
            placeholder="https://…"
            maxlength="2000"
          />
        </label>
        <label v-if="createKind === 'link'" class="dialog-field">
          <span>备注（可选）</span>
          <el-input
            v-model="createForm.description"
            type="textarea"
            :rows="2"
            maxlength="2000"
          />
        </label>
      </form>
      <template #footer>
        <el-button @click="createDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="createSaving" @click="submitCreate"
          >创建</el-button
        >
      </template>
    </el-dialog>
    <!-- 重命名（文件夹 / 文件） -->
    <el-dialog v-model="renameVisible" title="重命名" width="380px">
      <form class="dialog-form" @submit.prevent="submitRename">
        <label class="dialog-field">
          <span>名称</span>
          <el-input
            v-model="renameForm.name"
            maxlength="200"
            @keyup.enter="submitRename"
          />
        </label>
      </form>
      <template #footer>
        <el-button @click="renameVisible = false">取消</el-button>
        <el-button type="primary" @click="submitRename">保存</el-button>
      </template>
    </el-dialog>
    <!-- 编辑链接 -->
    <el-dialog v-model="linkEditVisible" title="编辑链接" width="420px">
      <form class="dialog-form" @submit.prevent="submitLinkEdit">
        <label class="dialog-field">
          <span>链接名称</span>
          <el-input v-model="linkEditForm.name" maxlength="200" />
        </label>
        <label class="dialog-field">
          <span>链接地址</span>
          <el-input v-model="linkEditForm.url" maxlength="2000" />
        </label>
        <label class="dialog-field">
          <span>备注</span>
          <el-input
            v-model="linkEditForm.description"
            type="textarea"
            :rows="2"
            maxlength="2000"
          />
        </label>
      </form>
      <template #footer>
        <el-button @click="linkEditVisible = false">取消</el-button>
        <el-button type="primary" @click="submitLinkEdit">保存</el-button>
      </template>
    </el-dialog>
    <!-- 移动到… -->
    <el-dialog v-model="moveVisible" title="移动到…" width="420px">
      <el-tree-select
        v-model="moveTarget"
        node-key="id"
        lazy
        check-strictly
        :load="loadMoveTree"
        :props="{ label: 'name', isLeaf: () => false }"
        placeholder="选择目标文件夹（根目录 = 需求名）"
        style="width: 100%"
      />
      <template #footer>
        <el-button @click="moveVisible = false">取消</el-button>
        <el-button type="primary" :loading="moveSaving" @click="submitMove"
          >移动</el-button
        >
      </template>
    </el-dialog>
    <!-- 图片页内预览 -->
    <el-image-viewer
      v-if="previewSrc"
      :url-list="[previewSrc]"
      @close="previewSrc = ''"
    />
  </section>
</template>
<style scoped>
.doc-manager {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  border: 1px solid var(--border-base);
  border-radius: 8px;
  background: var(--bg-surface);
  overflow: hidden;
}
.doc-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-subtle);
}
/* 需求目录初始化异常提示：占用一行，右侧给出修复入口（文档 §12.5） */
.workspace-alert {
  margin: 0;
  border-radius: 0;
}
.workspace-alert-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
}
.workspace-fix-btn {
  flex: none;
}
.doc-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
  font-size: 12px;
}
.crumb-sep {
  color: var(--text-faint);
}
.crumb {
  border: 0;
  background: none;
  padding: 2px 4px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.crumb:hover:not(:disabled) {
  color: var(--brand);
  background: var(--bg-hover);
}
.crumb.current {
  color: var(--text-title);
  font-weight: 600;
  cursor: default;
}
.doc-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.doc-search {
  width: 150px;
}
.doc-sort {
  width: 108px;
}
.doc-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
}
.doc-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.doc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}
.doc-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 12px 10px;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: var(--bg-surface);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.15s ease;
}
.doc-card:hover,
.doc-card:focus-visible {
  border-color: var(--brand);
  box-shadow: 0 2px 10px rgb(0 0 0 / 0.08);
  transform: translateY(-1px);
  outline: none;
}
.doc-card.is-missing {
  opacity: 0.72;
}
.doc-card-icon {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  font-size: 16px;
  flex: none;
}
.doc-card-icon.folder {
  color: var(--brand);
  background: var(--bg-brand-soft);
}
.doc-card-icon.file {
  color: var(--text-secondary);
  background: var(--bg-subtle);
}
.doc-card-icon.link {
  color: #1a7f37;
  background: rgb(26 127 55 / 0.12);
}
.doc-card-name {
  margin: 2px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-title);
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.memory-tag {
  flex: none;
}
.doc-card-meta {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link-desc {
  color: var(--text-faint);
}
.doc-card-status {
  position: absolute;
  top: 8px;
  right: 30px;
}
.doc-card-more {
  position: absolute;
  top: 6px;
  right: 6px;
  flex: none;
}
.doc-more-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
}
.doc-more-btn:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}
.dialog-form {
  display: grid;
  gap: 12px;
}
.dialog-field {
  display: grid;
  gap: 6px;
}
.dialog-field > span {
  font-size: 11px;
  color: var(--text-muted);
}
@media (max-width: 1100px) {
  .doc-search {
    width: 120px;
  }
}
</style>
