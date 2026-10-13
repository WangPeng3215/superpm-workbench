<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  Plus,
  Search,
  Refresh,
  Setting,
  ArrowDown,
  ArrowUp,
  Document,
  MoreFilled,
} from "@element-plus/icons-vue";
import {
  dateFields,
  dateLabels,
  priorities,
  stageLabels,
  statusLabels,
  typeLabels,
  type Requirement,
} from "@superpm/shared";
import XlyButton from "../components/ease-ui/xly-button/index.vue";
import XlyEmpty from "../components/ease-ui/xly-empty/index.vue";
import RequirementDetail from "../features/requirements/RequirementDetail.vue";
import RichTextEditor from "../features/requirements/RichTextEditor.vue";
import { useEditableTable } from "../features/requirements/useEditableTable";
const {
  list,
  loading,
  saving,
  loadError,
  formError,
  filters,
  dateRanges,
  expandedDates,
  form,
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
  rows,
  isEditing,
  selected,
  history,
  showDrawer,
  viewingStage,
  stageSaving,
  openDetail,
  changeStage,
  remove,
} = useEditableTable();
const richOpen = ref(false),
  richTarget = ref<Requirement>();
const table = ref();
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
watch(editing, async (value) => {
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
function sorted({ prop, order }: { prop: string; order: string | null }) {
  filters.sortBy = (order ? prop : "updatedAt") as typeof filters.sortBy;
  filters.sortOrder = order === "ascending" ? "asc" : "desc";
  load();
}
function sortable(key: string) {
  return [
    "type",
    "status",
    "priority",
    "currentStage",
    ...dateFields,
    "updatedAt",
  ].includes(key);
}
async function childFromDetail(
  parentId: number,
  name: string,
  description: string,
  descriptionHtml: string,
) {
  showDrawer.value = false;
  await create(parentId, { name, description, descriptionHtml });
}
const activeFilters = computed(
  () =>
    Object.entries(filters).filter(
      ([key, value]) =>
        !["page", "pageSize", "sortBy", "sortOrder"].includes(key) && value,
    ).length,
);
</script>
<template>
  <div class="page-heading compact-heading">
    <div>
      <div class="eyebrow">需求管理 / REQUIREMENTS</div>
      <h1>
        需求工作台 <span class="heading-count">{{ list.total }}</span>
      </h1>
      <p>直接编辑需求，沿着分析、设计、开发与测试推进。</p>
    </div>
    <div class="heading-actions">
      <span class="workspace-hint">本地保存 · 两级需求</span
      ><XlyButton type="primary" :disabled="saving" @click="create()"
        ><template #icon><Plus /></template>新增需求</XlyButton
      >
    </div>
  </div>
  <section class="surface filter-panel">
    <div class="filter-panel-heading">
      <strong>筛选需求</strong
      ><span v-if="activeFilters" class="filter-count"
        >{{ activeFilters }} 个条件</span
      ><el-button link @click="expandedDates = !expandedDates"
        >{{ expandedDates ? "收起时间条件" : "更多时间条件"
        }}<el-icon><ArrowUp v-if="expandedDates" /><ArrowDown v-else /></el-icon
      ></el-button>
    </div>
    <el-form
      label-position="top"
      class="filter-form"
      @submit.prevent="applyFilters"
    >
      <el-form-item label="需求名称"
        ><el-input
          v-model="filters.q"
          clearable
          placeholder="输入名称或编号搜索"
          :prefix-icon="Search"
          @keyup.enter="applyFilters"
      /></el-form-item>
      <el-form-item label="需求类型"
        ><el-select v-model="filters.type" placeholder="全部类型" clearable
          ><el-option
            v-for="(label, value) in typeLabels"
            :key="value"
            :label="label"
            :value="value" /></el-select
      ></el-form-item>
      <el-form-item label="状态"
        ><el-select v-model="filters.status" placeholder="全部状态" clearable
          ><el-option
            v-for="(label, value) in statusLabels"
            :key="value"
            :label="label"
            :value="value" /></el-select
      ></el-form-item>
      <el-form-item label="优先级"
        ><el-select
          v-model="filters.priority"
          placeholder="全部优先级"
          clearable
          ><el-option
            v-for="value in priorities"
            :key="value"
            :label="value"
            :value="value" /></el-select
      ></el-form-item>
      <el-form-item label="提出时间" class="date-filter"
        ><el-date-picker
          v-model="dateRanges.proposedAt"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          range-separator="至"
      /></el-form-item>
      <div class="filter-buttons">
        <el-button type="primary" @click="applyFilters">查询</el-button
        ><el-button @click="clearFilters">重置</el-button>
      </div>
      <template v-if="expandedDates"
        ><el-form-item
          v-for="key in dateFields.filter((key) => key !== 'proposedAt')"
          :key="key"
          :label="dateLabels[key]"
          class="date-filter extra-date"
          ><el-date-picker
            v-model="dateRanges[key]"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            range-separator="至" /></el-form-item
      ></template>
    </el-form>
  </section>
  <section class="surface requirement-surface">
    <div class="workspace-toolbar">
      <div class="toolbar-title">
        <h2>全部需求</h2>
        <el-tag size="small" effect="plain">表格视图</el-tag
        ><span class="toolbar-note">点击单元格编辑 · 点击编号打开详情</span>
      </div>
      <div class="toolbar-actions">
        <el-select
          v-model="filters.sortBy"
          style="width: 155px"
          aria-label="排序字段"
          @change="load"
          ><el-option label="最近更新" value="updatedAt" /><el-option
            v-for="column in columns.filter(
              (c) => sortable(c.key) && c.key !== 'updatedAt',
            )"
            :key="column.key"
            :label="column.label"
            :value="column.key" /></el-select
        ><el-button
          aria-label="切换排序方向"
          @click="
            filters.sortOrder = filters.sortOrder === 'desc' ? 'asc' : 'desc';
            load();
          "
          >{{ filters.sortOrder === "desc" ? "降序" : "升序" }}</el-button
        ><el-button :icon="Setting" @click="showColumns = true"
          >列设置</el-button
        ><el-button
          :icon="Refresh"
          circle
          aria-label="刷新需求"
          @click="load"
        />
      </div>
    </div>
    <el-alert
      v-if="loadError || formError"
      :title="loadError || formError"
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
              <el-icon
                ><ArrowDown v-if="!collapsed.has(row.id)" /><ArrowUp v-else
              /></el-icon></button
            ><span v-if="row.draft" class="draft-number">待生成编号</span
            ><button
              v-else
              class="link-button requirement-no"
              @click="openDetail(row)"
            >
              {{ row.requirementNo }}
            </button>
          </div>
          <el-input
            v-else-if="isEditing(row) && column.kind === 'text'"
            v-model="form.name"
            aria-label="需求名称"
            placeholder="输入需求名称"
            maxlength="200"
            @keyup.enter="save"
          />
          <el-select
            v-else-if="isEditing(row) && column.kind === 'select'"
            v-model="(form as any)[column.key]"
            :aria-label="column.label"
            ><el-option
              v-for="(label, value) in options(column.key)"
              :key="value"
              :label="label"
              :value="value"
          /></el-select>
          <el-date-picker
            v-else-if="isEditing(row) && column.kind === 'date'"
            v-model="(form as any)[column.key]"
            type="date"
            value-format="YYYY-MM-DD"
            :aria-label="column.label"
            placeholder="选择日期"
            :clearable="column.key !== 'proposedAt'"
          />
          <button
            v-else-if="column.kind === 'rich'"
            class="rich-cell"
            @click="openRich(row)"
          >
            <el-icon><Document /></el-icon
            ><span>{{
              (isEditing(row) ? form.description : row.description)?.slice(
                0,
                26,
              ) || "添加描述"
            }}</span>
          </button>
          <button
            v-else-if="column.kind !== 'readonly'"
            class="cell-value"
            :class="[
              column.key === 'name' ? 'name-cell' : '',
              column.key === 'status' ? 'status-' + row.status : '',
              column.key === 'priority' ? 'priority-' + row.priority : '',
            ]"
            @click="edit(row)"
          >
            <i v-if="column.key === 'status'" class="status-dot"></i
            >{{ valueLabel(row, column.key)
            }}<span
              v-if="column.key === 'name' && row.parentId"
              class="child-mark"
              >子需求</span
            >
          </button>
          <span v-else>{{ valueLabel(row, column.key) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="178" fixed="right"
        ><template #default="{ row }"
          ><div v-if="isEditing(row)" class="row-actions">
            <el-button link type="primary" :loading="saving" @click="save"
              >保存</el-button
            ><el-button link :disabled="saving" @click="cancel">取消</el-button>
          </div>
          <div v-else class="row-actions">
            <el-button link type="primary" @click="edit(row)">编辑</el-button
            ><el-button
              v-if="!row.parentId"
              link
              type="primary"
              @click="
                collapsed.delete(row.id);
                create(row.id);
              "
              >子需求</el-button
            ><el-dropdown
              @command="
                (command: string) =>
                  command === 'detail' ? openDetail(row) : remove(row)
              "
              ><el-button
                link
                :icon="MoreFilled"
                aria-label="更多操作"
              /><template #dropdown
                ><el-dropdown-menu
                  ><el-dropdown-item command="detail">打开详情</el-dropdown-item
                  ><el-dropdown-item command="delete" divided
                    >删除需求</el-dropdown-item
                  ></el-dropdown-menu
                ></template
              ></el-dropdown
            >
          </div></template
        ></el-table-column
      >
      <template #empty
        ><XlyEmpty size="small" type="search" description="还没有符合条件的需求"
          ><el-button type="primary" plain @click="create()"
            >添加一条需求</el-button
          ></XlyEmpty
        ></template
      >
    </el-table>
    <button class="add-row-button" :disabled="saving" @click="create()">
      <el-icon><Plus /></el-icon>在底部新增一行<span
        >输入名称后保存，其他信息可逐步补充</span
      >
    </button>
    <div class="table-footer">
      <span
        >{{ list.total }} 个主需求 · {{ list.matchedCount }} 条匹配需求
        <span v-if="editing" class="unsaved-label">· 有一行尚未保存</span></span
      ><el-pagination
        v-model:current-page="filters.page"
        v-model:page-size="filters.pageSize"
        :page-sizes="[10, 20, 50]"
        :total="list.total"
        layout="sizes, prev, pager, next"
        @current-change="load"
        @size-change="
          filters.page = 1;
          load();
        "
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
    @save="saveRich"
  />
  <RequirementDetail
    v-if="showDrawer"
    v-model="showDrawer"
    v-model:viewing-stage="viewingStage"
    :selected="selected"
    :history="history"
    :stage-saving="stageSaving"
    @edit="
      showDrawer = false;
      edit($event);
    "
    @remove="remove"
    @change-stage="changeStage"
    @create-child="childFromDetail"
    @updated="load"
  />
</template>
<style scoped src="../features/requirements/workbench.css"></style>
