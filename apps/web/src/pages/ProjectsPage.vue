<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import {
  projectStatusLabels,
  type Project,
  type ProjectDetail,
  type ProjectListQuery,
  type ProjectListResult,
} from "@superpm/shared";
import { projectApi } from "../api/projects";
import { errorMessage } from "../api/client";
import ProjectFormDialog from "../features/projects/ProjectFormDialog.vue";
const router = useRouter();
const filters = reactive<ProjectListQuery>({
  q: "",
  view: "all",
  page: 1,
  pageSize: 20,
});
const result = ref<ProjectListResult>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});
const loading = ref(false),
  error = ref(""),
  creating = ref(false);
let revision = 0;
async function load() {
  const token = ++revision;
  loading.value = true;
  error.value = "";
  try {
    const response = await projectApi.list(filters);
    if (token === revision) result.value = response;
  } catch (e) {
    if (token === revision) error.value = errorMessage(e);
  } finally {
    if (token === revision) loading.value = false;
  }
}
function search() {
  filters.page = 1;
  void load();
}
function reset() {
  Object.assign(filters, { q: "", view: "all", page: 1 });
  void load();
}
function created(detail: ProjectDetail) {
  void router.push(`/projects/${detail.project.id}`);
}
function openProject(row: Project) {
  void router.push(`/projects/${row.id}`);
}
function changePage(page: number) {
  filters.page = page;
  void load();
}
onMounted(load);
</script>
<template>
  <div class="projects-page">
    <el-form class="surface project-toolbar" @submit.prevent="search">
      <el-input
        v-model="filters.q"
        clearable
        aria-label="搜索项目"
        placeholder="搜索项目名称或编号"
        @keyup.enter="search"
      />
      <el-select v-model="filters.view" aria-label="项目视图" @change="search"
        ><el-option label="全部项目" value="all" /><el-option
          label="我负责的"
          value="owned" /><el-option
          label="我参与的"
          value="participating" /><el-option label="已归档" value="archived"
      /></el-select>
      <div class="toolbar-actions">
        <el-button type="primary" @click="search">查询</el-button
        ><el-button @click="reset">重置</el-button
        ><el-button type="primary" plain @click="creating = true"
          >新建项目</el-button
        >
      </div>
    </el-form>
    <section class="surface project-list">
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
        show-icon
      /><el-button v-if="error" @click="load">重新加载</el-button>
      <el-table
        v-loading="loading"
        :data="result.items"
        row-key="id"
        @row-dblclick="openProject"
      >
        <el-table-column label="项目编号" width="150"
          ><template #default="{ row }"
            ><el-button
              link
              type="primary"
              @click="router.push(`/projects/${row.id}`)"
              >{{ row.projectNo }}</el-button
            ></template
          ></el-table-column
        >
        <el-table-column label="项目名称" min-width="240" show-overflow-tooltip
          ><template #default="{ row }"
            ><el-button
              class="project-name"
              link
              @click="router.push(`/projects/${row.id}`)"
              >{{ row.name }}</el-button
            ></template
          ></el-table-column
        >
        <el-table-column label="状态" width="130"
          ><template #default="{ row }"
            ><el-tag>{{
              projectStatusLabels[
                row.status as keyof typeof projectStatusLabels
              ]
            }}</el-tag
            ><el-tag v-if="row.archivedAt" type="info">已归档</el-tag></template
          ></el-table-column
        >
        <el-table-column
          prop="customerName"
          label="客户 / 业务方"
          min-width="140"
          show-overflow-tooltip
        /><el-table-column label="目标交付日" width="140"
          ><template #default="{ row }">{{
            row.targetDeliveryDate || "尚未计划"
          }}</template></el-table-column
        >
        <el-table-column label="更新时间" width="170"
          ><template #default="{ row }">{{
            new Date(row.updatedAt).toLocaleString("zh-CN")
          }}</template></el-table-column
        >
        <template #empty
          ><el-empty description="还没有符合条件的项目"
        /></template>
      </el-table>
      <div class="list-footer">
        <span>共 {{ result.total }} 个项目</span
        ><el-pagination
          :current-page="filters.page"
          :page-size="filters.pageSize"
          :total="result.total"
          layout="prev, pager, next"
          @update:current-page="changePage"
        />
      </div>
    </section>
    <ProjectFormDialog v-model="creating" @created="created" />
  </div>
</template>
<style scoped>
.projects-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.project-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
}
.project-toolbar > .el-input {
  flex: 1;
  max-width: 340px;
}
.project-toolbar > .el-select {
  width: 170px;
}
.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  white-space: nowrap;
}
.toolbar-actions .el-button {
  margin: 0;
}
.project-list {
  overflow: hidden;
}
.list-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  color: var(--text-secondary);
}
.project-name {
  max-width: 100%;
  justify-content: flex-start;
  overflow: hidden;
  text-overflow: ellipsis;
}
@media (max-width: 800px) {
  .project-toolbar {
    gap: 8px;
    flex-wrap: wrap;
  }
  .toolbar-actions {
    margin-left: 0;
  }
  .project-toolbar > .el-input {
    min-width: 180px;
  }
}
</style>
