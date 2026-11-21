<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import type { TableInstance } from "element-plus";
import {
  DownOutlined,
  FileTextOutlined,
  PlusOutlined,
  PushpinFilled,
  SearchOutlined,
  SettingOutlined,
  UpOutlined,
} from "@ant-design/icons-vue";
import {
  dateFields,
  dateLabels,
  priorities,
  stageLabels,
  statusLabels,
  typeLabels,
  type Requirement,
} from "@superpm/shared";
import XlyEmpty from "../../components/ease-ui/xly-empty/index.vue";
import { decorative } from "../../components/decorativeIcon";
import RichTextEditor from "./RichTextEditor.vue";
import { isEnumField, tagTone } from "./enum-tags";
import { useEditableTable } from "./useEditableTable";

const SearchIcon = decorative(SearchOutlined);
const SettingIcon = decorative(SettingOutlined);
const AddIcon = decorative(PlusOutlined);

import { projectApi } from "../../api/projects";
import type { Project } from "@superpm/shared";
const props = withDefaults(
  defineProps<{ projectId?: number; readOnly?: boolean }>(),
  { readOnly: false },
);
const projects = ref<Project[]>([]);
const projectFilter = ref<number | "unassigned" | undefined>();
onMounted(async () => {
  if (!props.projectId) {
    try {
      projects.value = (await projectApi.list({ pageSize: 100 })).items;
    } catch {}
  }
});
function selectProject(value: number | "unassigned" | undefined) {
  filters.projectId = typeof value === "number" ? value : undefined;
  filters.unassigned = value === "unassigned" ? true : undefined;
}
const router = useRouter();
const {
  list,
  loading,
  saving,
  saveState,
  pinning,
  loadError,
  formError,
  storageError,
  filters,
  dateRanges,
  expandedDates,
  form,
  editingId,
  editing,
  columns,
  showColumns,
  dragged,
  visibleColumns,
  moveColumn,
  setVisible,
  resetColumns,
  load,
  applyFilters,
  clearFilters,
  create,
  edit,
  cancel,
  save,
  retrySave,
  finishEditing,
  setPinned,
  rows,
  isEditing,
  canEditRow,
  updateField,
  invalidate,
  remove,
} = useEditableTable({
  projectId: props.projectId,
  readOnly: () => props.readOnly,
});
watch(
  [() => filters.projectId, () => filters.unassigned],
  ([projectId, unassigned]) => {
    projectFilter.value = projectId ?? (unassigned ? "unassigned" : undefined);
  },
);
defineExpose({ load, flush: finishEditing, invalidate });
const richOpen = ref(false),
  richTarget = ref<Requirement>();
const table = ref<TableInstance>();
const collapsed = ref(new Set<number>());
const displayedRows = computed(() =>
  rows.value.filter(
    (row) => !row.parentId || row.draft || !collapsed.value.has(row.parentId),
  ),
);
function toggle(id: number) {
  const next = new Set(collapsed.value);
  next.has(id) ? next.delete(id) : next.add(id);
  collapsed.value = next;
}
watch([editing, editingId], async ([value]) => {
  if (value) {
    await nextTick();
    const element = document.querySelector(
      '.editing-row input[aria-label="需求名称"]',
    ) as HTMLInputElement | null;
    element?.focus();
    element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
});
watch(
  visibleColumns,
  async () => {
    await nextTick();
    table.value?.doLayout();
  },
  { deep: true },
);
const enums: Record<string, Record<string, string>> = {
  type: typeLabels,
  status: statusLabels,
  priority: Object.fromEntries(priorities.map((value) => [value, value])),
  currentStage: stageLabels,
};
function options(key: string) {
  return enums[key] ?? {};
}
function valueLabel(row: Requirement, key: keyof Requirement) {
  if (key in enums) return options(key)[String(row[key])];
  if (key === "updatedAt")
    return new Date(row.updatedAt).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  return row[key] || "—";
}
async function openRich(row: Requirement) {
  if (!isEditing(row)) {
    await edit(row);
    if (!isEditing(row)) return;
  }
  richTarget.value = row.id > 0 ? row : undefined;
  richOpen.value = true;
}
function saveRich(html: string, text: string) {
  form.descriptionHtml = html;
  form.description = text;
}
function rowClass({ row }: { row: Requirement & { draft?: boolean } }) {
  return [
    isEditing(row) ? "editing-row" : "",
    row.parentId ? "child-row" : "",
  ].join(" ");
}
type SortOrder = "ascending" | "descending";
let appliedSort: { prop: string; order: SortOrder } | undefined;
let restoringSort = false;
async function sorted({
  prop,
  order,
}: {
  prop: string;
  order: SortOrder | null;
}) {
  if (restoringSort) return;
  if (!(await finishEditing())) {
    restoringSort = true;
    try {
      if (appliedSort) table.value?.sort(appliedSort.prop, appliedSort.order);
      else table.value?.clearSort();
    } finally {
      restoringSort = false;
    }
    return;
  }
  appliedSort = order ? { prop, order } : undefined;
  filters.sortBy = (order ? prop : "updatedAt") as typeof filters.sortBy;
  filters.sortOrder = order === "ascending" ? "asc" : "desc";
  filters.page = 1;
  await load();
}
async function changePage(page: number) {
  if (!(await finishEditing())) return;
  if (filters.page === page) return;
  filters.page = page;
  await load();
}
async function changePageSize(size: number) {
  if (!(await finishEditing())) return;
  filters.pageSize = size;
  filters.page = 1;
  await load();
}
function sortable(key: string) {
  return [
    "requirementNo",
    "type",
    "status",
    "priority",
    "currentStage",
    ...dateFields,
    "updatedAt",
  ].includes(key);
}
const saveHint = computed(() => {
  switch (saveState.value) {
    case "pending":
      return "等待自动保存…";
    case "saving":
      return "正在保存…";
    case "saved":
      return "已自动保存";
    case "blocked":
      return "请补全必填项";
    case "error":
      return "自动保存失败";
    case "conflict":
      return "存在版本冲突，请保留草稿后重新读取";
    case "unauthorized":
      return "登录已失效，草稿已保留";
    default:
      return "编辑后自动保存";
  }
});
function openDetailPage(row: Requirement) {
  router.push(`/requirements/${row.id}`);
}
function openRequirement(requirementId: number) {
  richOpen.value = false;
  void router.push(`/requirements/${requirementId}`);
}
</script>
<template>
  <el-form
    label-position="top"
    class="requirements-toolbar"
    @submit.prevent="applyFilters"
  >
    <div class="toolbar-main">
      <div class="filter-fields">
        <el-form-item label="需求名称">
          <el-input
            v-model="filters.q"
            clearable
            placeholder="搜索名称或编号"
            :prefix-icon="SearchIcon"
            @keyup.enter="applyFilters"
          />
        </el-form-item>
        <el-form-item v-if="!projectId" label="项目">
          <el-select
            v-model="projectFilter"
            clearable
            placeholder="全部项目与私人需求"
            @change="selectProject"
          >
            <el-option label="未关联项目" value="unassigned" />
            <el-option
              v-for="project in projects"
              :key="project.id"
              :label="project.name"
              :value="project.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="需求类型">
          <el-select v-model="filters.type" placeholder="全部类型" clearable>
            <template #label="{ label, value }">
              <el-tag
                size="small"
                class="enum-tag"
                :class="tagTone('type', value)"
              >
                {{ label }}
              </el-tag>
            </template>
            <el-option
              v-for="(label, value) in typeLabels"
              :key="value"
              :label="label"
              :value="value"
            >
              <el-tag
                size="small"
                class="enum-tag"
                :class="tagTone('type', value)"
              >
                {{ label }}
              </el-tag>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" placeholder="全部状态" clearable>
            <template #label="{ label, value }">
              <el-tag
                size="small"
                class="enum-tag"
                :class="tagTone('status', value)"
              >
                {{ label }}
              </el-tag>
            </template>
            <el-option
              v-for="(label, value) in statusLabels"
              :key="value"
              :label="label"
              :value="value"
            >
              <el-tag
                size="small"
                class="enum-tag"
                :class="tagTone('status', value)"
              >
                {{ label }}
              </el-tag>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="优先级">
          <el-select
            v-model="filters.priority"
            placeholder="全部优先级"
            clearable
          >
            <template #label="{ label, value }">
              <el-tag
                size="small"
                class="enum-tag"
                :class="tagTone('priority', value)"
              >
                {{ label }}
              </el-tag>
            </template>
            <el-option
              v-for="value in priorities"
              :key="value"
              :label="value"
              :value="value"
            >
              <el-tag
                size="small"
                class="enum-tag"
                :class="tagTone('priority', value)"
              >
                {{ value }}
              </el-tag>
            </el-option>
          </el-select>
        </el-form-item>
      </div>
      <div class="filter-actions">
        <el-button type="primary" @click="applyFilters">查询</el-button>
        <el-button
          type="primary"
          plain
          :icon="AddIcon"
          :disabled="saving || readOnly"
          @click="create()"
          >添加需求</el-button
        >
        <el-button
          @click="
            projectFilter = undefined;
            clearFilters();
          "
          >重置</el-button
        >
        <el-button
          class="date-toggle"
          :aria-expanded="expandedDates"
          @click="expandedDates = !expandedDates"
        >
          {{ expandedDates ? "收起时间条件" : "更多时间条件" }}
          <el-icon aria-hidden="true"
            ><UpOutlined v-if="expandedDates" /><DownOutlined v-else
          /></el-icon>
        </el-button>
        <el-button :icon="SettingIcon" @click="showColumns = true"
          >列设置</el-button
        >
      </div>
    </div>
    <div v-if="expandedDates" class="filter-drawer">
      <el-form-item
        v-for="key in dateFields"
        :key="key"
        :label="dateLabels[key]"
        class="date-filter"
      >
        <el-date-picker
          v-model="dateRanges[key]"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          range-separator="至"
        />
      </el-form-item>
    </div>
  </el-form>
  <section class="surface requirement-surface">
    <el-alert
      v-if="loadError || formError || storageError"
      :title="loadError || formError || storageError"
      type="error"
      :closable="false"
      show-icon
      class="error-alert"
    />
    <el-table
      ref="table"
      v-loading="loading"
      :data="displayedRows"
      row-key="id"
      class="editable-table"
      :row-class-name="rowClass"
      @sort-change="sorted"
      border
    >
      <el-table-column
        v-for="column in visibleColumns"
        :key="`${column.key}-${column.fixed}`"
        :prop="column.key"
        :label="column.label"
        :width="column.width"
        :fixed="column.fixed || false"
        :sortable="sortable(column.key) ? 'custom' : false"
      >
        <template #header
          ><span
            class="draggable-column"
            draggable="true"
            :title="'拖动调整字段顺序：' + column.label"
            @dragstart="dragged = column.key"
            @dragover.prevent
            @drop.prevent="moveColumn(column.key)"
            ><span class="drag-grip">⠿</span>{{ column.label }}</span
          ></template
        >
        <template #default="{ row }">
          <div
            v-if="column.key === 'requirementNo'"
            class="number-cell"
            :class="{
              'child-number': row.parentId,
              'last-child': row.lastChild,
            }"
          >
            <button
              v-if="!row.parentId && !row.draft"
              class="tree-toggle"
              :aria-label="collapsed.has(row.id) ? '展开子需求' : '收起子需求'"
              @click="toggle(row.id)"
            >
              <el-icon aria-hidden="true"
                ><DownOutlined v-if="!collapsed.has(row.id)" /><UpOutlined
                  v-else
              /></el-icon></button
            ><span v-if="row.draft" class="draft-number">待生成编号</span
            ><button
              v-else
              class="link-button requirement-no"
              @click="openDetailPage(row)"
            >
              {{ row.requirementNo }}
            </button>
            <el-icon
              v-if="row.pinned"
              class="pinned-requirement"
              title="已置顶"
              aria-hidden="true"
              ><PushpinFilled
            /></el-icon>
          </div>
          <div
            v-else-if="isEditing(row) && column.kind === 'text'"
            class="name-editor"
          >
            <el-input
              v-model="form.name"
              aria-label="需求名称"
              placeholder="输入需求名称"
              maxlength="200"
              :disabled="saving"
              @keydown.enter="
                (event: KeyboardEvent) => {
                  if (!event.isComposing) save();
                }
              "
            />
            <el-button
              v-if="row.draft"
              type="primary"
              size="small"
              :loading="saving"
              @click="save"
              >创建</el-button
            >
          </div>
          <el-select
            v-else-if="isEditing(row) && column.kind === 'select'"
            :model-value="(form as any)[column.key]"
            @update:model-value="
              (value: unknown) => updateField(column.key, value)
            "
            :disabled="saving"
            :aria-label="column.label"
            ><template #label="{ label, value }"
              ><el-tag
                v-if="isEnumField(String(column.key))"
                size="small"
                class="enum-tag"
                :class="tagTone(String(column.key), value)"
                >{{ label }}</el-tag
              ><span v-else>{{ label }}</span></template
            ><el-option
              v-for="(label, value) in options(column.key)"
              :key="value"
              :label="label"
              :value="value"
              ><el-tag
                v-if="isEnumField(String(column.key))"
                size="small"
                class="enum-tag"
                :class="tagTone(String(column.key), value)"
                >{{ label }}</el-tag
              ><template v-else>{{ label }}</template></el-option
            ></el-select
          >
          <el-date-picker
            v-else-if="isEditing(row) && column.kind === 'date'"
            v-model="(form as any)[column.key]"
            :disabled="saving"
            type="date"
            value-format="YYYY-MM-DD"
            :aria-label="column.label"
            placeholder="选择日期"
            :clearable="column.key !== 'proposedAt'"
          />
          <button
            v-else-if="column.kind === 'rich'"
            class="rich-cell"
            :disabled="saving && isEditing(row)"
            @click="canEditRow(row) ? openRich(row) : openDetailPage(row)"
          >
            <el-icon aria-hidden="true"><FileTextOutlined /></el-icon
            ><span>{{
              (isEditing(row) ? form.description : row.description)?.slice(
                0,
                26,
              ) || "添加描述"
            }}</span>
          </button>
          <button
            v-else-if="column.kind !== 'readonly' && canEditRow(row)"
            class="cell-value"
            :class="column.key === 'name' ? 'name-cell' : ''"
            @click="edit(row)"
          >
            <el-tag
              v-if="isEnumField(String(column.key))"
              size="small"
              class="enum-tag"
              :class="tagTone(String(column.key), row[column.key])"
              >{{ valueLabel(row, column.key) }}</el-tag
            ><template v-else
              >{{ valueLabel(row, column.key)
              }}<span
                v-if="column.key === 'name' && row.parentId"
                class="child-mark"
                >子需求</span
              ></template
            >
          </button>
          <span v-else>{{ valueLabel(row, column.key) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="240" fixed="right"
        ><template #default="{ row }"
          ><div v-if="isEditing(row)" class="row-actions">
            <el-button
              v-if="!row.draft && saveState === 'error'"
              link
              type="primary"
              @click="retrySave"
              >重试保存</el-button
            >
            <el-button
              v-if="
                !row.draft &&
                ![
                  'error',
                  'blocked',
                  'conflict',
                  'unauthorized',
                  'forbidden',
                ].includes(saveState)
              "
              link
              type="primary"
              @click="save"
              >完成</el-button
            >
            <el-button
              v-if="
                row.draft ||
                ['error', 'blocked', 'conflict', 'unauthorized'].includes(
                  saveState,
                )
              "
              link
              :disabled="saving"
              @click="cancel"
              >{{ row.draft ? "取消" : "放弃未保存修改" }}</el-button
            >
          </div>
          <div v-else class="row-actions">
            <el-button
              v-if="canEditRow(row)"
              link
              type="primary"
              @click="edit(row)"
              >编辑</el-button
            ><el-button
              v-if="!row.parentId && canEditRow(row)"
              class="child-action"
              link
              type="primary"
              @click="
                collapsed.delete(row.id);
                create(row.id);
              "
              >子需求</el-button
            ><el-button link type="primary" @click="openDetailPage(row)"
              >详情</el-button
            ><el-button
              link
              type="primary"
              :disabled="pinning !== undefined"
              @click="setPinned(row)"
              >{{ row.pinned ? "取消置顶" : "置顶" }}</el-button
            ><el-button
              v-if="canEditRow(row)"
              link
              type="danger"
              @click="remove(row)"
              >删除</el-button
            >
          </div></template
        ></el-table-column
      >
      <template #empty
        ><XlyEmpty
          size="small"
          type="search"
          description="还没有符合条件的需求"
      /></template>
    </el-table>
    <div class="table-footer">
      <div class="table-summary">
        <span
          >{{ list.total }} 个主需求 · {{ list.matchedCount }} 条匹配需求</span
        >
        <span
          v-if="editing && editingId !== null && saveState !== 'idle'"
          role="status"
          >{{ saveHint }}</span
        >
      </div>
      <el-pagination
        :current-page="filters.page"
        :page-size="filters.pageSize"
        :page-sizes="[10, 20, 50]"
        :total="list.total"
        layout="sizes, prev, pager, next"
        @update:current-page="changePage"
        @update:page-size="changePageSize"
      />
    </div>
  </section>
  <el-drawer v-model="showColumns" title="列设置" size="400px"
    ><p class="column-intro">
      拖动调整顺序，设置固定位置与可见性。配置保存在当前浏览器。
    </p>
    <div class="column-setting-head">
      <span>字段 / 拖动排序</span><span>固定位置</span>
    </div>
    <div
      v-for="column in columns"
      :key="column.key"
      class="column-setting-row"
      draggable="true"
      @dragstart="dragged = column.key"
      @dragover.prevent
      @drop.prevent="moveColumn(column.key)"
    >
      <span class="drag-grip">⠿</span
      ><el-checkbox
        :model-value="column.visible"
        @change="(value: unknown) => setVisible(column, Boolean(value))"
        >{{ column.label }}</el-checkbox
      ><el-select
        v-model="column.fixed"
        size="small"
        style="width: 95px"
        :aria-label="column.label + '固定位置'"
        ><el-option label="不固定" value="" /><el-option
          label="固定左侧"
          value="left" /><el-option label="固定右侧" value="right"
      /></el-select>
    </div>
    <template #footer
      ><el-button @click="resetColumns">恢复默认</el-button
      ><el-button type="primary" @click="showColumns = false"
        >完成</el-button
      ></template
    ></el-drawer
  >
  <RichTextEditor
    v-model="richOpen"
    title="编辑需求描述"
    :html="form.descriptionHtml"
    :text="form.description"
    :requirement-id="richTarget?.id"
    :auto-save="editingId !== null"
    @save="saveRich"
    @open-requirement="openRequirement"
  />
</template>
<style scoped src="./workbench.css"></style>
