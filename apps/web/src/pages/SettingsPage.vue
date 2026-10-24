<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { SystemInfo } from "@superpm/shared";
import { errorMessage, request } from "../api/client";
import UpdatePanel from "../features/settings/UpdatePanel.vue";
const info = ref<SystemInfo>();
const loading = ref(false);
const error = ref("");
const activeSection = ref<"storage" | "updates" | "modules">("storage");
const sections = [
  { key: "storage", label: "本地存储" },
  { key: "updates", label: "版本与更新" },
  { key: "modules", label: "功能模块" },
] as const;
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
  <div class="settings-layout">
    <nav class="settings-nav" aria-label="设置分类">
      <button
        v-for="section in sections"
        :key="section.key"
        type="button"
        :class="{ active: activeSection === section.key }"
        :aria-pressed="activeSection === section.key"
        @click="activeSection = section.key"
      >
        {{ section.label }}
      </button>
    </nav>
    <div class="settings-content">
      <section
        v-show="activeSection === 'storage'"
        class="surface settings-section"
        v-loading="loading"
      >
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
      <div v-show="activeSection === 'updates'">
        <UpdatePanel />
      </div>
      <section
        v-if="info"
        v-show="activeSection === 'modules'"
        class="surface settings-section"
      >
        <h2>功能模块</h2>
        <div
          v-for="module in info.modules"
          :key="module.key"
          class="module-row"
        >
          <span>{{ module.name }}</span
          ><el-tag
            :type="module.status === 'available' ? 'success' : 'info'"
            effect="plain"
            >{{ module.status === "available" ? "已接入" : "规划中" }}</el-tag
          >
        </div>
      </section>
    </div>
  </div>
</template>
<style scoped>
.settings-layout {
  display: grid;
  grid-template-columns: 176px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.settings-nav {
  display: grid;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--border-base);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
}
.settings-nav button {
  min-height: 36px;
  padding: 8px 12px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.settings-nav button:hover {
  background: var(--bg-hover);
  color: var(--text-heading);
}
.settings-nav button.active {
  background: var(--bg-brand-soft);
  color: var(--brand);
  font-weight: 600;
}
.settings-nav button:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}
.settings-content {
  min-width: 0;
}
.settings-content .settings-section {
  margin: 0;
  padding: 20px 22px;
}
@media (max-width: 700px) {
  .settings-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .settings-nav {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .settings-nav button {
    padding: 8px 6px;
    text-align: center;
  }
}
</style>
