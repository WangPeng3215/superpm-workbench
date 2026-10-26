<script setup lang="ts">
import { ref } from "vue";
import { onBeforeRouteLeave, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { ArrowLeftOutlined } from "@ant-design/icons-vue";
import type { MeetingCreate } from "@superpm/shared";
import { meetingApi } from "../api/meetings";
import { errorMessage } from "../api/client";
import { decorative } from "../components/decorativeIcon";
import MeetingForm from "../features/meetings/MeetingForm.vue";
import { removeTab } from "../stores/tabs";

const BackIcon = decorative(ArrowLeftOutlined);
const router = useRouter();
const form = ref<InstanceType<typeof MeetingForm>>();
const saving = ref(false);
const error = ref("");
let leaveConfirmed = false;

async function confirmLeave() {
  if (!form.value?.isDirty()) return true;
  try {
    await ElMessageBox.confirm(
      "当前会议尚未保存，离开后将丢失已填写的内容。",
      "离开新建会议",
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
  removeTab("/meetings/new");
  await router.push(path);
}

async function back() {
  if (!(await confirmLeave())) return;
  await leaveTo("/meetings");
}

async function openRequirement(id: number) {
  if (!(await confirmLeave())) return;
  await leaveTo(`/requirements/${id}`);
}

async function submit(payload: MeetingCreate) {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const created = await meetingApi.create(payload);
    ElMessage.success("会议记录已创建");
    leaveConfirmed = true;
    removeTab("/meetings/new");
    await router.replace(`/meetings/${created.id}`);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="page-heading">
    <div>
      <h1>新建会议</h1>
      <p>填写会议信息并记录讨论内容，保存后可继续编辑。</p>
    </div>
    <el-button :icon="BackIcon" @click="back">返回会议列表</el-button>
  </div>

  <section class="surface create-card">
    <MeetingForm
      ref="form"
      :saving="saving"
      :error="error"
      @submit="submit"
      @cancel="back"
      @open-requirement="openRequirement"
    />
  </section>
</template>

<style scoped>
.create-card {
  max-width: 1180px;
  padding: 22px 24px;
}
@media (max-width: 700px) {
  .create-card {
    padding: 16px 14px;
  }
}
</style>
