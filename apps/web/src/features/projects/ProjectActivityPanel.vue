<script setup lang="ts">
import { onMounted, watch } from "vue";
import type { ProjectEvent } from "../../api/projects";
import { useProjectActivity } from "./useProjectActivity";
import {
  formatProjectEventTime,
  projectEventLabel,
  projectEventTarget,
  type ProjectNavigationTarget,
} from "./project-panels";

const props = withDefaults(
  defineProps<{ projectId: number; readonly?: boolean }>(),
  { readonly: false },
);
const emit = defineEmits<{ navigate: [target: ProjectNavigationTarget] }>();
const { items, loading, loadingMore, error, hasMore, refresh, loadMore } =
  useProjectActivity(() => props.projectId);

function open(event: ProjectEvent) {
  const target = projectEventTarget(event);
  if (target) emit("navigate", target);
}

function targetFor(event: ProjectEvent) {
  return projectEventTarget(event);
}

onMounted(() => void refresh());
watch(
  () => props.projectId,
  () => void refresh(),
);
defineExpose({ refresh, loadMore });
</script>

<template>
  <section class="project-activity" v-loading="loading" aria-label="项目动态">
    <header class="activity-heading">
      <div>
        <h2>项目动态</h2>
        <p>按发生时间倒序记录项目协作操作。</p>
      </div>
      <div class="activity-actions">
        <el-tag v-if="readonly" size="small" type="info">只读</el-tag>
        <el-button size="small" :loading="loading" @click="refresh"
          >刷新</el-button
        >
      </div>
    </header>

    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    >
      <template #default>
        <el-button size="small" @click="items.length ? loadMore() : refresh()"
          >重试</el-button
        >
      </template>
    </el-alert>

    <el-empty
      v-if="!loading && !items.length && !error"
      description="暂无项目动态"
      :image-size="72"
    />
    <ol v-else-if="items.length" class="activity-list">
      <li v-for="event in items" :key="event.id" class="activity-item">
        <span class="activity-dot" aria-hidden="true"></span>
        <div class="activity-content">
          <div class="activity-summary">
            <strong>{{
              event.actorNameSnapshot || event.actorName || "项目成员"
            }}</strong>
            <el-button
              v-if="targetFor(event)"
              link
              type="primary"
              @click="open(event)"
              >{{ projectEventLabel(event) }}</el-button
            >
            <span v-else>{{ projectEventLabel(event) }}</span>
          </div>
          <time :datetime="event.createdAt">{{
            formatProjectEventTime(event.createdAt)
          }}</time>
        </div>
      </li>
    </ol>
    <div v-if="hasMore" class="load-more">
      <el-button :loading="loadingMore" :disabled="loading" @click="loadMore"
        >加载更多</el-button
      >
    </div>
  </section>
</template>

<style scoped>
.project-activity {
  display: grid;
  gap: 16px;
  padding: 16px 0;
}
.activity-heading,
.activity-actions,
.activity-summary {
  display: flex;
  align-items: center;
  gap: 10px;
}
.activity-heading {
  justify-content: space-between;
}
.activity-heading h2 {
  margin: 0;
  font-size: 17px;
}
.activity-heading p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}
.activity-actions {
  flex: none;
}
.activity-list {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.activity-item {
  position: relative;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 12px;
  min-height: 62px;
}
.activity-item:not(:last-child)::before {
  position: absolute;
  top: 10px;
  bottom: -1px;
  left: 6px;
  width: 1px;
  background: var(--border-base);
  content: "";
}
.activity-dot {
  z-index: 1;
  width: 13px;
  height: 13px;
  margin-top: 4px;
  border: 3px solid var(--bg-brand-soft);
  border-radius: 50%;
  background: var(--brand);
}
.activity-content {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 0 0 14px;
  border-bottom: 1px solid var(--border-soft);
}
.activity-summary {
  flex-wrap: wrap;
  align-content: flex-start;
  color: var(--text-regular);
  font-size: 13px;
}
.activity-summary strong {
  color: var(--text-title);
  font-weight: 600;
}
.activity-content time {
  flex: none;
  color: var(--text-muted);
  font-size: 12px;
}
.load-more {
  display: flex;
  justify-content: center;
}
@media (max-width: 600px) {
  .activity-content {
    flex-direction: column;
    gap: 5px;
  }
}
</style>
