<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { SystemInfo } from "@superpm/shared";
import { errorMessage, request } from "../api/client";
import UpdatePanel from "../features/settings/UpdatePanel.vue";
const info = ref<SystemInfo>();
const loading = ref(false);
const error = ref("");
async function load() {
  loading.value = true;
  error.value = "";
  try {
    info.value = await request<SystemInfo>("/system");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>系统设置</h1>
      <p>本地数据位置、版本与更新。</p>
    </div>
    <el-button @click="load" :loading="loading">刷新信息</el-button>
  </div>
  <el-alert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
    show-icon
    class="error-alert"
  />
  <section class="surface settings-section" v-loading="loading">
    <h2>本地存储</h2>
    <p class="muted">数据库保存结构化事实，工作区保存文件产物。</p>
    <el-descriptions v-if="info" :column="1" border>
      <el-descriptions-item label="应用版本">{{
        info.version
      }}</el-descriptions-item>
      <el-descriptions-item label="数据库位置"
        ><code>{{ info.databasePath }}</code></el-descriptions-item
      >
      <el-descriptions-item label="文件工作区"
        ><code>{{ info.workspacePath }}</code></el-descriptions-item
      >
      <el-descriptions-item label="数据库版本">{{
        info.schemaVersion
      }}</el-descriptions-item>
    </el-descriptions>
    <p class="setting-note">
      目前可在项目根目录的 .env
      中配置存储位置，重启服务后生效。备份与恢复通过命令行工具完成，见 README
      的「用户数据与备份」。
    </p>
  </section>
  <UpdatePanel />
  <section v-if="info" class="surface settings-section">
    <h2>功能模块</h2>
    <div v-for="module in info.modules" :key="module.key" class="module-row">
      <span>{{ module.name }}</span
      ><el-tag
        :type="module.status === 'available' ? 'success' : 'info'"
        effect="plain"
        >{{ module.status === "available" ? "已接入" : "规划中" }}</el-tag
      >
    </div>
  </section>
</template>
