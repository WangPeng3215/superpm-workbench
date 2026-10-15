<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  ArrowLeft,
  Document,
  Grid,
  Link,
  MoreFilled,
  Picture,
  Plus,
  Tickets,
  Upload,
} from "@element-plus/icons-vue";
import {
  fileCategoryKinds,
  resolveCategoryOpenAction,
  assetCategories,
  type AssetStatus,
  type FileCategory,
  type RequirementFile,
  type Stage,
} from "@superpm/shared";
import { requirementFileApi } from "../../api/requirement-files";
import { errorMessage } from "../../api/client";

const props = defineProps<{ requirementId: number; activePhase: Stage }>();
const emit = defineEmits<{
  "open-doc": [file: RequirementFile];
  "doc-removed": [file: RequirementFile];
}>();
// 右栏固定七分类（用户定稿），不随阶段切换变化
interface CategoryEntry {
  key: FileCategory;
  label: string;
  defaultPhase: Stage;
}
const orderedCategories: CategoryEntry[] = assetCategories.map((entry) => ({
  key: entry.key,
  label: entry.label,
  defaultPhase: entry.defaultPhase,
}));
const selectedCategory = ref<CategoryEntry>();
const previewSrc = ref("");
// 探测服务器是否启用了本地程序打开（补充文档 5.4）
const systemOpenReady = ref(false);
// 列表一次拉全（phase=all），按分类过滤展示
const allFiles = ref<RequirementFile[]>([]);
const loaded = ref(false);
const loading = ref(false);
const input = ref<HTMLInputElement>();
const uploadTarget = ref<{ phase: Stage; category: FileCategory }>();
const markdownPattern = /\.(md|markdown)$/i;
const imagePattern = /\.(png|jpe?g|gif|webp|svg)$/i;
const sheetPattern = /\.(xls|xlsx|csv)$/i;
async function loadAll() {
  if (loaded.value) return;
  loading.value = true;
  try {
    const result = await requirementFileApi.list(
      props.requirementId,
      "all",
      true,
    );
    allFiles.value = result.groups.flatMap((group) => group.files);
    loaded.value = true;
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}
async function refresh() {
  loaded.value = false;
  await loadAll();
}
function filesOf(category: FileCategory) {
  return allFiles.value.filter((file) => file.category === category);
}
// 分类摘要：文件数 / 定稿数 / 是否有缺失
function statsOf(category: FileCategory) {
  const files = filesOf(category);
  return {
    total: files.length,
    confirmed: files.filter((file) => file.isFinal).length,
    missing: files.some((file) => file.status === "missing"),
  };
}
// 列表与分类固定，阶段切换无需重置（常驻产物区）
onMounted(async () => {
  loadAll();
  try {
    const info = (await fetch("/api/system").then((r) => r.json())) as {
      systemOpenAvailable?: boolean;
    };
    systemOpenReady.value = Boolean(info?.systemOpenAvailable);
  } catch {
    // 探测失败按不可用处理，回退为浏览器直接处理
  }
});
defineExpose({ refresh });
function isMarkdown(file: RequirementFile) {
  return file.resourceType === "text" || markdownPattern.test(file.name) ||
    markdownPattern.test(file.fileName);
}
function isLink(file: RequirementFile) {
  return file.resourceType === "link";
}
function iconOf(file: RequirementFile) {
  if (isLink(file)) return Link;
  const source = `${file.name} ${file.fileName}`.toLowerCase();
  if (imagePattern.test(source)) return Picture;
  if (sheetPattern.test(source)) return Grid;
  if (markdownPattern.test(source) || /\.(txt|json|log)$/i.test(source))
    return Tickets;
  return Document;
}
function stateText(file: RequirementFile) {
  if (file.status === "missing") return "文件缺失";
  if (file.status === "archived") return "已归档";
  if (file.isFinal) return "定稿";
  return "草稿";
}
function stateClass(file: RequirementFile) {
  return `asset-state--${file.status}`;
}
async function open(file: RequirementFile) {
  // 缺失文件不发起请求，明确反馈
  if (file.status === "missing") {
    ElMessage.warning("文件已缺失，无法打开；可在磁盘恢复文件或删除该条目");
    return;
  }
  if (isLink(file)) {
    if (file.linkUrl) window.open(file.linkUrl, "_blank", "noopener");
    return;
  }
  if (isMarkdown(file)) {
    emit("open-doc", file);
    return;
  }
  // 图片页内预览（img 标签加载 SVG 不会执行脚本，安全）
  const source = `${file.name} ${file.fileName}`.toLowerCase();
  if (imagePattern.test(source)) {
    previewSrc.value = requirementFileApi.rawUrl(props.requirementId, file.id);
    return;
  }
  // 办公文档等未知类型：本地模式交系统默认程序，服务器模式回退浏览器处理
  if (systemOpenReady.value) {
    try {
      await requirementFileApi.openLocally(props.requirementId, file.id);
      return;
    } catch (error) {
      ElMessage.warning(errorMessage(error));
    }
  }
  window.open(requirementFileApi.rawUrl(props.requirementId, file.id), "_blank");
}
// 链接条目展示来源域名
function hostOf(file: RequirementFile) {
  if (!file.linkUrl) return "";
  try {
    return new URL(file.linkUrl).hostname;
  } catch {
    return file.linkUrl;
  }
}
// 分类卡片打开策略（补充文档 3.2）：空态/单文件直开/唯一确认版直开，其余进入全部文件视图
function openCategory(group: CategoryEntry) {
  const files = filesOf(group.key);
  const action = resolveCategoryOpenAction(files);
  if (action.action === "open_single" && action.assetId !== undefined) {
    const target = files.find((file) => file.id === action.assetId);
    if (target) void open(target);
    return;
  }
  selectedCategory.value = group;
}
// 多文件且无确认版时的提示
const selectionHint = computed(() => {
  const group = selectedCategory.value;
  if (!group) return "";
  const action = resolveCategoryOpenAction(filesOf(group.key));
  return action.needsConfirm
    ? "该分类存在多个文件，请选择要打开的文件，或先将某一文件设为定稿。"
    : "";
});
async function upload(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  target.value = "";
  const destination = uploadTarget.value;
  if (!file || !destination) return;
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.warning("文件不能超过 5 MB");
    return;
  }
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  try {
    await requirementFileApi.create(props.requirementId, {
      phase: destination.phase,
      category: destination.category,
      name: file.name,
      mime: file.type || "application/octet-stream",
      data,
      isFinal: false,
    });
    ElMessage.success("上传成功");
    await refresh();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}
async function createLink(category: FileCategory, phase: Stage) {
  let name: string;
  let url: string;
  try {
    const result = await ElMessageBox.prompt("输入链接地址", "新建链接", {
      inputPlaceholder: "https://example.com",
      confirmButtonText: "下一步",
      cancelButtonText: "取消",
      inputValidator: (text: string) =>
        /^(https?|ftp):\/\/\S+$/i.test(text.trim()) ||
        "链接需以 http(s):// 或 ftp:// 开头",
    });
    url = result.value.trim();
    const named = await ElMessageBox.prompt("输入名称", "新建链接", {
      inputValue: url,
      confirmButtonText: "确定",
      cancelButtonText: "取消",
      inputValidator: (text: string) =>
        text.trim() ? true : "请输入名称",
    });
    name = named.value.trim();
  } catch {
    return;
  }
  try {
    await requirementFileApi.create(props.requirementId, {
      phase,
      category,
      name,
      resourceType: "link",
      linkUrl: url,
      isFinal: false,
    });
    ElMessage.success("链接已添加");
    await refresh();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}
async function rename(file: RequirementFile) {
  try {
    const result = await ElMessageBox.prompt("输入新名称", "重命名", {
      inputValue: file.name,
      confirmButtonText: "确定",
      cancelButtonText: "取消",
      inputValidator: (text: string) => (text.trim() ? true : "请输入名称"),
    });
    await requirementFileApi.update(props.requirementId, file.id, {
      name: result.value.trim(),
    });
  } catch {
    return;
  }
  ElMessage.success("已重命名");
  await refresh();
}
async function changeStatus(file: RequirementFile, status: AssetStatus) {
  try {
    await requirementFileApi.update(props.requirementId, file.id, { status });
  } catch (error) {
    ElMessage.error(errorMessage(error));
    return;
  }
  ElMessage.success(status === "archived" ? "已归档" : "状态已更新");
  await refresh();
}
async function remove(file: RequirementFile) {
  try {
    await ElMessageBox.confirm(`确定删除「${file.name}」吗？`, "删除条目", {
      confirmButtonText: "删除",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }
  try {
    await requirementFileApi.remove(props.requirementId, file.id);
    ElMessage.success("已删除");
    // 通知宿主：若左栏正编辑该文档则回退默认记录
    emit("doc-removed", file);
    await refresh();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}
function uploadFor(category: FileCategory, phase: Stage) {
  uploadTarget.value = { phase, category };
  input.value?.click();
}
const canUpload = (category: FileCategory) =>
  ["file", "both"].includes(fileCategoryKinds[category]);
const canLink = (category: FileCategory) =>
  ["link", "both"].includes(fileCategoryKinds[category]);
// 七分类卡片的上传/链接一律按分类默认阶段归属（补充用户定稿）
const phaseOf = (entry: CategoryEntry) => entry.defaultPhase;
</script>
<template>
  <aside class="surface assets-panel" v-loading="loading">
    <!-- 一级：分类卡片列表 -->
    <div v-if="!selectedCategory" class="category-grid">
      <div
        v-for="group in orderedCategories"
        :key="group.key"
        class="category-card"
        role="button"
        tabindex="0"
        @click="openCategory(group)"
        @keydown.enter="openCategory(group)"
      >
        <div class="category-head">
          <span class="category-name">{{ group.label }}</span>
        </div>
        <div class="category-stats">
          <span>{{ statsOf(group.key).total }} 个文件</span>
          <span>{{ statsOf(group.key).confirmed }} 个定稿</span>
          <span
            v-if="statsOf(group.key).missing"
            class="category-missing"
            >有文件缺失</span
          >
        </div>
        <button
          class="category-view-all"
          type="button"
          @click.stop="selectedCategory = group"
        >
          查看所有文件
        </button>
      </div>
    </div>
    <!-- 二级：某分类的全部文件 -->
    <template v-else>
      <header class="assets-head">
        <button
          class="assets-back"
          type="button"
          aria-label="返回分类列表"
          @click="selectedCategory = undefined"
        >
          <el-icon :size="14"><ArrowLeft /></el-icon>
        </button>
        <strong class="assets-title">{{ selectedCategory.label }}</strong>
      </header>
      <p v-if="selectionHint" class="assets-hint">{{ selectionHint }}</p>
      <div class="asset-list">
        <div
          v-for="file in filesOf(selectedCategory.key)"
          :key="file.id"
          class="asset-item"
        >
          <el-icon class="asset-icon" :size="15"
            ><component :is="iconOf(file)"
          /></el-icon>
          <button
            class="asset-name"
            type="button"
            :title="isLink(file) ? file.linkUrl ?? '' : file.name"
            @click="open(file)"
          >
            {{ file.name }}
          </button>
          <span
            v-if="isLink(file) && hostOf(file)"
            class="asset-host"
            :title="file.linkUrl ?? ''"
            >{{ hostOf(file) }}</span
          >
          <span class="asset-state" :class="stateClass(file)">{{
            stateText(file)
          }}</span>
          <el-dropdown
            class="asset-more"
            trigger="click"
            @command="(command: string) => {
              if (command === 'rename') rename(file);
              else if (command === 'final') changeStatus(file, 'final');
              else if (command === 'draft') changeStatus(file, 'draft');
              else if (command === 'archive') changeStatus(file, 'archived');
              else if (command === 'remove') remove(file);
            }"
          >
            <el-icon class="asset-more-icon" :size="14"><MoreFilled /></el-icon>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-if="!isLink(file) && file.status !== 'archived'"
                  command="final"
                  :disabled="file.isFinal"
                  >设为定稿</el-dropdown-item
                >
                <el-dropdown-item command="draft" :disabled="!file.isFinal"
                  >恢复草稿</el-dropdown-item
                >
                <el-dropdown-item
                  v-if="file.status !== 'archived'"
                  command="archive"
                  >归档</el-dropdown-item
                >
                <el-dropdown-item command="rename">重命名</el-dropdown-item>
                <el-dropdown-item command="remove" divided>
                  <span class="asset-danger">删除</span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <el-empty
          v-if="!filesOf(selectedCategory.key).length"
          description="暂无条目"
          :image-size="48"
        />
      </div>
      <div
        v-if="canUpload(selectedCategory.key) || canLink(selectedCategory.key)"
        class="asset-actions"
      >
        <button
          v-if="canUpload(selectedCategory.key)"
          class="asset-action"
          type="button"
          @click="uploadFor(selectedCategory.key, phaseOf(selectedCategory))"
        >
          <el-icon :size="13"><Upload /></el-icon>上传文件
        </button>
        <button
          v-if="canLink(selectedCategory.key)"
          class="asset-action"
          type="button"
          @click="createLink(selectedCategory.key, phaseOf(selectedCategory))"
        >
          <el-icon :size="13"><Plus /></el-icon>新建链接
        </button>
      </div>
    </template>
    <input ref="input" type="file" hidden @change="upload" />
    <!-- 图片页内预览 -->
    <el-image-viewer
      v-if="previewSrc"
      :url-list="[previewSrc]"
      @close="previewSrc = ''"
    />
  </aside>
</template>
<style scoped>
.assets-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: auto;
}
.category-grid {
  display: grid;
  gap: 10px;
  padding: 10px;
}
.category-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border-base);
  border-radius: 10px;
  background: var(--bg-surface);
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.category-card:hover,
.category-card--current {
  border-color: var(--brand);
}
.category-card:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.category-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.category-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.category-current {
  font-style: normal;
  font-size: 11px;
  color: var(--brand);
}
.category-stats {
  display: flex;
  gap: 10px;
  font-size: 12px;
  color: var(--text-tertiary);
}
.category-missing {
  color: var(--tone-danger);
}
.category-view-all {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  font-size: 12px;
  color: var(--brand);
  cursor: pointer;
}
.category-view-all:hover {
  text-decoration: underline;
}
.assets-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 0;
  flex: none;
}
.assets-back {
  display: inline-flex;
  padding: 4px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
}
.assets-back:hover {
  color: var(--brand);
  background: var(--bg-hover);
}
.assets-title {
  font-size: 13px;
  color: var(--text-primary);
}
.assets-hint {
  margin: 8px 10px 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-base);
  font-size: 12px;
  color: var(--text-secondary);
  flex: none;
}
.asset-list {
  flex: 1 1 auto;
  padding: 8px 10px;
}
.asset-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
}
.asset-item:hover {
  background: var(--bg-hover);
}
.asset-icon {
  flex: none;
  color: var(--text-tertiary);
}
.asset-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  background: none;
  border: 0;
  padding: 0;
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
}
.asset-name:hover {
  color: var(--brand);
}
.asset-host {
  flex: none;
  max-width: 32%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-tertiary);
}
.asset-state {
  flex: none;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-light);
  color: var(--text-tertiary);
}
.asset-state--final {
  color: var(--tone-success);
  border-color: var(--tone-success-border, var(--tone-success));
}
.asset-state--missing {
  color: var(--tone-danger);
  border-color: var(--tone-danger-border, var(--tone-danger));
}
.asset-more {
  flex: none;
  visibility: hidden;
}
.asset-item:hover .asset-more {
  visibility: visible;
}
.asset-more-icon {
  color: var(--text-tertiary);
  cursor: pointer;
}
.asset-danger {
  color: var(--tone-danger);
}
.asset-actions {
  display: flex;
  gap: 8px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--border-light);
  flex: none;
}
.asset-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-light);
  background: none;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.asset-action:hover {
  color: var(--brand);
  border-color: var(--brand);
}
</style>
