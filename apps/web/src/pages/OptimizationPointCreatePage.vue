<script setup lang="ts">
import { ref } from "vue";
import { onBeforeRouteLeave, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { ArrowLeftOutlined } from "@ant-design/icons-vue";
import type { OptimizationPointCreate } from "@superpm/shared";
import { optimizationPointApi } from "../api/optimization-points";
import { errorMessage } from "../api/client";
import { decorative } from "../components/decorativeIcon";
import OptimizationPointForm from "../features/optimization-points/OptimizationPointForm.vue";
import { removeTab } from "../stores/tabs";

// 新建走独立路由（与会议记录一致）：页签文案由 tabs store 的 FEATURE_TAB_LABELS 提供，
// 保存成功后移除「新建」页签并跳到详情，避免留下一个空的编辑页。
const CREATE_PATH = "/optimization-points/new";
const BackIcon = decorative(ArrowLeftOutlined);

const router = useRouter();
const form = ref<InstanceType<typeof OptimizationPointForm>>();
const saving = ref(false);
const error = ref("");
const dirty = ref(false);
let leaveConfirmed = false;

async function confirmLeave() {
  if (!dirty.value && !form.value?.isDirty()) return true;
  try {
    await ElMessageBox.confirm(
      "当前优化点尚未保存，离开后将丢失已填写的内容。",
      "离开新建优化点",
      {
        type: "warning",
        confirmButtonText: "离开",
        cancelButtonText: "继续编辑",
      },
    );
    return true;
  } catch {
    return false;
  }
}

onBeforeRouteLeave(() => leaveConfirmed || confirmLeave());

async function leaveTo(path: string) {
  leaveConfirmed = true;
  removeTab(CREATE_PATH);
  await router.push(path);
}

async function back() {
  if (!(await confirmLeave())) return;
  await leaveTo("/optimization-points");
}

async function submit() {
  if (saving.value) return;
  const payload = form.value?.validate();
  if (!payload) return;
  saving.value = true;
  error.value = "";
  try {
    const created = await optimizationPointApi.create(
      payload as OptimizationPointCreate,
    );
    ElMessage.success("优化点已记录");
    leaveConfirmed = true;
    removeTab(CREATE_PATH);
    await router.replace(`/optimization-points/${created.id}`);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="create-page">
    <div class="create-bar">
      <el-button text :icon="BackIcon" @click="back">返回优化点列表</el-button>
    </div>

    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
      class="create-alert"
    />

    <section class="surface create-card">
      <OptimizationPointForm
        ref="form"
        fill
        :disabled="saving"
        @change="dirty = true"
      >
        <template #side>
          <div class="form-actions">
            <el-button :disabled="saving" @click="back">取消</el-button>
            <el-button
              type="primary"
              :loading="saving"
              :disabled="saving"
              @click="submit"
            >
              保存优化点
            </el-button>
          </div>
        </template>
      </OptimizationPointForm>
    </section>
  </div>
</template>

<style scoped>
.create-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: calc(100dvh - var(--app-header-h) - 40px);
  min-height: 0;
}
.create-bar {
  display: flex;
  flex: none;
  align-items: center;
}
.create-alert {
  flex: none;
}
.create-card {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  padding: 14px 18px;
  overflow: hidden;
}
.create-card > .point-form {
  flex: 1 1 auto;
  min-width: 0;
}
/* 操作区随插槽渲染在右栏底部（表单自身不提供按钮） */
.form-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: auto;
  padding-top: 14px;
  border-top: 1px solid var(--border-soft);
}
.form-actions :deep(.el-button) {
  margin: 0;
}
@media (max-width: 980px) {
  .create-page {
    height: auto;
  }
  .create-card {
    min-height: 640px;
    padding: 14px 12px;
  }
}
</style>
