<script setup lang="ts">
import {
  Plus,
  Search,
  Refresh,
  Filter,
  EditPen,
  DocumentAdd,
} from "@element-plus/icons-vue";
import {
  priorities,
  requirementStatuses,
  stages,
  stageLabels,
  statusLabels,
  typeLabels,
} from "@superpm/shared";
import XlyButton from "../components/ease-ui/xly-button/index.vue";
import XlyEmpty from "../components/ease-ui/xly-empty/index.vue";
import RequirementDetail from "../features/requirements/RequirementDetail.vue";
import { useRequirements } from "../features/requirements/useRequirements";
const {
  loading,
  saving,
  list,
  selected,
  history,
  showDrawer,
  showForm,
  formMode,
  formRef,
  formError,
  filters,
  form,
  formRules,
  parentOptions,
  currentStage,
  viewingStage,
  loadError,
  load,
  openDetail,
  openCreate,
  openEdit,
  save,
  remove,
  changeStage,
  closeForm,
  clearFilters,
  statusType,
  priorityType,
  typeLabel,
  statusLabel,
  stageLabel,
  stageSaving,
} = useRequirements();
</script>

<template>
  <div class="page-heading requirements-heading">
    <div>
      <div class="eyebrow">PRODUCT OPERATIONS · LOCAL FIRST</div>
      <h1>需求工作台</h1>
      <p>把需求事实、过程记录和阶段推进放在一个可追溯的工作空间里。</p>
    </div>
    <XlyButton type="primary" @click="openCreate()"
      ><template #icon><Plus /></template>新建需求</XlyButton
    >
  </div>
  <section class="surface requirement-surface">
    <div class="workspace-toolbar">
      <div class="toolbar-title">
        <h2>全部需求</h2>
        <span class="count-badge">{{ list.total }}</span>
      </div>
      <div class="toolbar-actions">
        <el-input
          v-model="filters.q"
          clearable
          placeholder="搜索编号或名称"
          :prefix-icon="Search"
          class="search-input"
          @keyup.enter="
            filters.page = 1;
            load();
          "
          @clear="load"
        /><el-select
          v-model="filters.sortBy"
          style="width: 126px"
          aria-label="排序字段"
          @change="load"
          ><el-option label="最近更新" value="updatedAt" /><el-option
            label="优先级"
            value="priority" /><el-option
            label="提出时间"
            value="proposedAt" /><el-option
            label="名称"
            value="name" /></el-select
        ><el-button
          aria-label="切换排序方向"
          @click="
            filters.sortOrder = filters.sortOrder === 'desc' ? 'asc' : 'desc';
            load();
          "
          >{{ filters.sortOrder === "desc" ? "降序" : "升序" }}</el-button
        ><el-button plain :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </div>
    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      :closable="false"
      show-icon
      class="error-alert"
    />
    <div class="filter-strip">
      <span class="filter-label"
        ><el-icon><Filter /></el-icon>筛选</span
      ><el-select
        v-model="filters.type"
        clearable
        placeholder="需求类型"
        @change="
          filters.page = 1;
          load();
        "
        ><el-option
          v-for="(label, value) in typeLabels"
          :key="value"
          :label="label"
          :value="value" /></el-select
      ><el-select
        v-model="filters.priority"
        clearable
        placeholder="优先级"
        @change="
          filters.page = 1;
          load();
        "
        ><el-option
          v-for="priority in priorities"
          :key="priority"
          :label="priority"
          :value="priority" /></el-select
      ><el-select
        v-model="filters.status"
        clearable
        placeholder="需求状态"
        @change="
          filters.page = 1;
          load();
        "
        ><el-option
          v-for="status in requirementStatuses"
          :key="status"
          :label="statusLabels[status]"
          :value="status" /></el-select
      ><el-select
        v-model="filters.currentStage"
        clearable
        placeholder="当前阶段"
        @change="
          filters.page = 1;
          load();
        "
        ><el-option
          v-for="stage in stages"
          :key="stage"
          :label="stageLabels[stage]"
          :value="stage" /></el-select
      ><el-button
        v-if="
          filters.q ||
          filters.type ||
          filters.priority ||
          filters.status ||
          filters.currentStage
        "
        link
        type="primary"
        @click="clearFilters"
        >清除条件</el-button
      >
    </div>
    <el-table
      v-loading="loading"
      :data="list.items"
      row-key="id"
      class="requirements-table"
      :tree-props="{ children: 'children' }"
      default-expand-all
    >
      <el-table-column prop="requirementNo" label="编号" width="130"
        ><template #default="{ row }"
          ><button class="link-button requirement-no" @click="openDetail(row)">
            {{ row.requirementNo }}
          </button></template
        ></el-table-column
      >
      <el-table-column prop="name" label="需求名称" min-width="230"
        ><template #default="{ row }"
          ><button class="link-button name-button" @click="openDetail(row)">
            {{ row.name }}</button
          ><span v-if="row.parentId" class="child-mark">子需求</span></template
        ></el-table-column
      >
      <el-table-column prop="type" label="类型" width="100"
        ><template #default="{ row }">{{
          typeLabel(row)
        }}</template></el-table-column
      >
      <el-table-column prop="priority" label="优先级" width="90"
        ><template #default="{ row }"
          ><el-tag
            :type="priorityType(row.priority)"
            effect="plain"
            size="small"
            >{{ row.priority }}</el-tag
          ></template
        ></el-table-column
      >
      <el-table-column prop="status" label="状态" width="105"
        ><template #default="{ row }"
          ><el-tag :type="statusType(row.status)" effect="light" size="small">{{
            statusLabel(row)
          }}</el-tag></template
        ></el-table-column
      >
      <el-table-column prop="currentStage" label="当前阶段" width="120"
        ><template #default="{ row }"
          ><span class="stage-cell"
            ><i :class="`stage-dot stage-${row.currentStage}`"></i
            >{{ stageLabel(row) }}</span
          ></template
        ></el-table-column
      >
      <el-table-column prop="proposedAt" label="提出时间" width="112" />
      <el-table-column prop="expectedAt" label="预计完成" width="112"
        ><template #default="{ row }">{{
          row.expectedAt || "—"
        }}</template></el-table-column
      >
      <el-table-column prop="updatedAt" label="最近更新" width="164"
        ><template #default="{ row }">{{
          new Date(row.updatedAt).toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        }}</template></el-table-column
      >
      <el-table-column label="操作" width="145" fixed="right"
        ><template #default="{ row }"
          ><el-button link type="primary" :icon="EditPen" @click="openEdit(row)"
            >编辑</el-button
          ><el-button
            v-if="!row.parentId"
            link
            type="primary"
            :icon="DocumentAdd"
            @click="openCreate(row.id)"
            >子需求</el-button
          ></template
        ></el-table-column
      >
      <template #empty
        ><XlyEmpty
          type="search"
          description="还没有符合条件的需求"
          size="default"
          ><XlyButton type="primary" size="small" @click="openCreate()"
            >创建第一个需求</XlyButton
          ></XlyEmpty
        ></template
      >
    </el-table>
    <div class="table-footer">
      <span
        >显示
        {{
          list.items.length ? (filters.page - 1) * filters.pageSize + 1 : 0
        }}–{{ Math.min(filters.page * filters.pageSize, list.total) }} /
        {{ list.total }} 个主需求</span
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

  <RequirementDetail
    v-model="showDrawer"
    v-model:viewing-stage="viewingStage"
    :selected="selected"
    :history="history"
    :stage-saving="stageSaving"
    @edit="openEdit"
    @remove="remove"
    @change-stage="changeStage"
  />

  <el-dialog
    v-model="showForm"
    :title="
      formMode === 'create'
        ? form.parentId
          ? '创建子需求'
          : '新建需求'
        : '编辑需求'
    "
    width="620px"
    destroy-on-close
    :before-close="closeForm"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    ><el-alert
      v-if="formError"
      :title="formError"
      type="error"
      :closable="false"
      show-icon
      class="form-error"
    /><el-form
      ref="formRef"
      :model="form"
      :rules="formRules"
      label-position="top"
      class="requirement-form"
      ><el-form-item label="需求名称" prop="name"
        ><el-input
          v-model="form.name"
          maxlength="200"
          show-word-limit
          placeholder="例如：建立本地文件版本管理"
      /></el-form-item>
      <div class="form-grid">
        <el-form-item label="需求类型"
          ><el-select v-model="form.type"
            ><el-option
              v-for="(label, value) in typeLabels"
              :key="value"
              :label="label"
              :value="value" /></el-select></el-form-item
        ><el-form-item label="优先级"
          ><el-select v-model="form.priority"
            ><el-option
              v-for="priority in priorities"
              :key="priority"
              :label="priority"
              :value="priority" /></el-select></el-form-item
        ><el-form-item label="状态"
          ><el-select v-model="form.status"
            ><el-option
              v-for="status in requirementStatuses"
              :key="status"
              :label="statusLabels[status]"
              :value="status" /></el-select></el-form-item
        ><el-form-item label="当前阶段"
          ><el-select v-model="form.currentStage"
            ><el-option
              v-for="stage in stages"
              :key="stage"
              :label="stageLabels[stage]"
              :value="stage" /></el-select
        ></el-form-item>
      </div>
      <el-form-item v-if="formMode === 'create'" label="父需求"
        ><el-select
          v-model="form.parentId"
          data-testid="parent-requirement-select"
          clearable
          placeholder="留空表示主需求"
          ><el-option
            v-for="option in parentOptions"
            :key="option.id"
            :label="option.label"
            :value="option.id" /></el-select></el-form-item
      ><el-form-item label="需求描述"
        ><el-input
          v-model="form.description"
          type="textarea"
          :rows="5"
          maxlength="50000"
          show-word-limit
          placeholder="描述背景、目标和范围（可后续补充）"
      /></el-form-item>
      <div class="form-grid">
        <el-form-item label="提出时间" prop="proposedAt"
          ><el-date-picker
            v-model="form.proposedAt"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%" /></el-form-item
        ><el-form-item label="预计完成"
          ><el-date-picker
            v-model="form.expectedAt"
            type="date"
            value-format="YYYY-MM-DD"
            clearable
            style="width: 100%"
        /></el-form-item></div></el-form
    ><template #footer
      ><el-button :disabled="saving" @click="closeForm()">取消</el-button
      ><XlyButton type="primary" :loading="saving" @click="save">{{
        formMode === "create" ? "创建需求" : "保存修改"
      }}</XlyButton></template
    ></el-dialog
  >
</template>

<style scoped src="../features/requirements/requirements.css"></style>
