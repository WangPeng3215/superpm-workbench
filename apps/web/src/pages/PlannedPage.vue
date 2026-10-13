<script setup lang="ts">
import { useRoute } from "vue-router";
import XlyEmpty from "../components/ease-ui/xly-empty/index.vue";
const route = useRoute();
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>{{ route.meta.title }}</h1>
      <p>
        {{
          route.meta.module === "tasks"
            ? "记录每天的计划、执行与工作结果。"
            : "集中查看需要你关注的系统事件。"
        }}
      </p>
    </div>
    <el-tag type="info" effect="plain">规划中</el-tag>
  </div>
  <section class="surface planned-surface">
    <XlyEmpty
      type="list"
      :description="
        route.meta.module === 'tasks'
          ? '任务历史将在后续模块中实现'
          : '通知模块将在后续迭代中实现'
      "
    />
    <p class="muted">
      当前可先在需求工作台建立需求与父子关系，整理状态和阶段。
    </p>
    <RouterLink to="/requirements"
      ><el-button type="primary" plain>进入需求工作台</el-button></RouterLink
    >
  </section>
</template>
