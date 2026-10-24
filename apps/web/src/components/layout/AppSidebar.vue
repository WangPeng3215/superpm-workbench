<script setup lang="ts">
import { SettingOutlined } from "@ant-design/icons-vue";
import type { Component } from "vue";

defineProps<{
  items: { path: string; label: string; icon: Component }[];
}>();
</script>

<template>
  <aside class="sidebar">
    <RouterLink to="/requirements" class="brand" aria-label="superPM 首页">
      <img class="brand-logo" src="/logo-mark.png" alt="" />
      <span>superPM<small>workbench</small></span>
    </RouterLink>
    <nav class="navigation" aria-label="主导航">
      <RouterLink
        v-for="item in items"
        :key="item.path"
        :to="item.path"
        class="nav-item"
        :title="item.label"
      >
        <el-icon aria-hidden="true"><component :is="item.icon" /></el-icon>
        <span>{{ item.label }}</span>
      </RouterLink>
    </nav>
    <div class="sidebar-bottom">
      <RouterLink
        to="/settings"
        class="nav-item"
        aria-label="系统设置"
        title="系统设置"
      >
        <el-icon aria-hidden="true"><SettingOutlined /></el-icon>
        <span>系统设置</span>
      </RouterLink>
    </div>
  </aside>
</template>
