<script setup lang="ts">
import { ref, watch } from "vue";
import type { ProjectDetail } from "@superpm/shared";
import { projectApi } from "../../api/projects";
import { errorMessage } from "../../api/client";
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ created: [detail: ProjectDetail] }>();
const name = ref(""),
  saving = ref(false),
  error = ref("");
watch(open, (value) => {
  if (value) {
    name.value = "";
    error.value = "";
  }
});
async function create() {
  if (saving.value || !name.value.trim()) return;
  saving.value = true;
  error.value = "";
  try {
    const result = await projectApi.create({ name: name.value.trim() });
    open.value = false;
    emit("created", result);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <el-dialog
    v-model="open"
    title="新建项目"
    width="min(480px, 92vw)"
    :close-on-click-modal="false"
  >
    <p class="dialog-intro">
      先为项目起个名称，目标、计划和成员可以在创建后逐步补充。
    </p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-form label-position="top" @submit.prevent="create">
      <el-form-item label="项目名称" required
        ><el-input
          v-model="name"
          aria-label="项目名称"
          maxlength="200"
          show-word-limit
          autofocus
          placeholder="输入项目名称"
          @keyup.enter="create"
      /></el-form-item>
    </el-form>
    <template #footer
      ><el-button :disabled="saving" @click="open = false">取消</el-button
      ><el-button
        type="primary"
        :loading="saving"
        :disabled="!name.trim()"
        @click="create"
        >创建项目</el-button
      ></template
    >
  </el-dialog>
</template>
<style scoped>
.dialog-intro {
  color: var(--text-secondary);
  line-height: 1.7;
  margin: 0 0 20px;
}
</style>
