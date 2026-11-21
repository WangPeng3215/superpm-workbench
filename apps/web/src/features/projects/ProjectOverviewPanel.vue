<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useProjectOverview } from "./useProjectOverview";
import {
  formatProjectEventTime,
  projectActionTarget,
  projectEventLabel,
  projectEventTarget,
  projectRiskItems,
  type ProjectNavigationTarget,
} from "./project-panels";

const props = withDefaults(
  defineProps<{ projectId: number; readonly?: boolean }>(),
  { readonly: false },
);
const emit = defineEmits<{ navigate: [target: ProjectNavigationTarget] }>();
const { overview, loading, error, load } = useProjectOverview(
  () => props.projectId,
);
const risks = computed(() =>
  overview.value ? projectRiskItems(overview.value) : [],
);
const requirementStatuses: Record<string, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  completed: "已完成",
  blocked: "阻塞",
  paused: "已暂停",
  cancelled: "已取消",
};
const taskStatuses: Record<string, string> = {
  pending: "待开始",
  in_progress: "进行中",
  pending_confirmation: "待确认",
  completed: "已完成",
  blocked: "已阻塞",
  cancelled: "已取消",
};
const deliveryStatuses: Record<string, string> = {
  planning: "计划中",
  active: "进行中",
  awaiting_acceptance: "待验收",
  accepted: "已验收",
  cancelled: "已取消",
};
const scopeStates: Record<string, string> = {
  unconfirmed: "尚未确认范围",
  empty: "已确认但当前范围为空",
  confirmed: "已确认范围",
};
const actionLabels: Record<string, string> = {
  submit: "提交任务",
  confirm: "确认任务",
  accept: "开始验收",
  confirm_scope: "确认范围",
};
function statusLines(
  counts: Record<string, number>,
  labels: Record<string, string>,
) {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({
      status,
      label: labels[status] ?? status,
      count,
    }));
}
function open(target: ProjectNavigationTarget) {
  emit("navigate", target);
}
function openEvent(event: {
  action: string;
  payload: Record<string, unknown>;
}) {
  const target = projectEventTarget(event);
  if (target) open(target);
}
async function refresh() {
  await load();
}
onMounted(refresh);
watch(() => props.projectId, refresh);
defineExpose({ refresh });
</script>

<template>
  <section class="project-overview" v-loading="loading" aria-label="项目概览">
    <div class="overview-heading">
      <div>
        <h2>项目概览</h2>
        <p>统计范围为项目当前全部需求、任务和交付记录。</p>
      </div>
      <el-tag v-if="readonly" size="small" type="info">只读</el-tag>
      <el-button size="small" :loading="loading" @click="refresh">
        刷新
      </el-button>
    </div>

    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    >
      <template #default>
        <el-button size="small" @click="refresh">重试</el-button>
      </template>
    </el-alert>

    <template v-if="overview">
      <div class="metric-grid">
        <article class="metric-card">
          <div class="metric-head">
            <h3>需求</h3>
            <strong>{{ overview.requirements.total }}</strong>
          </div>
          <div class="metric-emphasis">
            已完成 {{ overview.requirements.completed }}
          </div>
          <div class="status-list">
            <span
              v-for="item in statusLines(
                overview.requirements.byStatus,
                requirementStatuses,
              )"
              :key="item.status"
              >{{ item.label }} <b>{{ item.count }}</b></span
            >
          </div>
        </article>
        <article class="metric-card">
          <div class="metric-head">
            <h3>执行任务</h3>
            <strong>{{ overview.tasks.total }}</strong>
          </div>
          <div class="metric-emphasis">
            待处理 {{ overview.tasks.pending }} · 逾期
            {{ overview.tasks.overdue }}
          </div>
          <div class="status-list">
            <span
              v-for="item in statusLines(overview.tasks.byStatus, taskStatuses)"
              :key="item.status"
              >{{ item.label }} <b>{{ item.count }}</b></span
            >
          </div>
        </article>
        <article class="metric-card">
          <div class="metric-head">
            <h3>交付批次</h3>
            <strong>{{ overview.deliveries.total }}</strong>
          </div>
          <div class="metric-emphasis">
            进行中 {{ overview.deliveries.active }} · 待验收
            {{ overview.deliveries.awaitingAcceptance }}
          </div>
          <div class="status-list">
            <span
              v-for="item in statusLines(
                overview.deliveries.byStatus,
                deliveryStatuses,
              )"
              :key="item.status"
              >{{ item.label }} <b>{{ item.count }}</b></span
            >
          </div>
        </article>
      </div>

      <section class="overview-section scope-summary" aria-labelledby="overview-scope">
        <div class="section-heading">
          <h3 id="overview-scope">当前交付范围</h3>
          <span>{{ scopeStates[overview.deliveryScope.state] }}</span>
        </div>
        <div v-if="overview.deliveryScope.state === 'confirmed'" class="scope-progress">
          <div class="scope-stat">
            <span>执行完成</span>
            <strong>{{ overview.deliveryScope.executionCompleted }} / {{ overview.deliveryScope.total }}</strong>
            <el-progress :percentage="overview.deliveryScope.executionPercent ?? 0" :show-text="false" :stroke-width="6" />
          </div>
          <div class="scope-stat">
            <span>已验收</span>
            <strong>{{ overview.deliveryScope.accepted }} / {{ overview.deliveryScope.total }}</strong>
            <el-progress :percentage="overview.deliveryScope.acceptancePercent ?? 0" :show-text="false" status="success" :stroke-width="6" />
          </div>
          <div class="scope-stat scope-failed">
            <span>验收未通过</span>
            <strong>{{ overview.deliveryScope.failed }}</strong>
          </div>
        </div>
        <el-empty v-else description="当前没有可统计的承诺需求" :image-size="48" />
      </section>

      <section class="overview-section action-summary" aria-labelledby="overview-actions">
        <div class="section-heading">
          <h3 id="overview-actions">待我处理</h3>
          <span>{{ overview.myActions.items.length }} 项</span>
        </div>
        <el-empty v-if="!overview.myActions.items.length" description="暂无待处理事项" :image-size="48" />
        <ul v-else class="action-list">
          <li v-for="item in overview.myActions.items" :key="item.kind + ':' + item.id + ':' + item.action">
            <div class="action-copy">
              <strong>{{ item.title }}</strong>
              <span>{{ actionLabels[item.action] ?? item.action }}<template v-if="item.dueDate"> · {{ item.dueDate }}</template></span>
            </div>
            <el-button link type="primary" @click="open(projectActionTarget(item))">查看</el-button>
          </li>
        </ul>
      </section>

      <section class="overview-section" aria-labelledby="overview-risks">
        <div class="section-heading">
          <h3 id="overview-risks">风险提示</h3>
          <span>{{ risks.length }} 项</span>
        </div>
        <el-empty
          v-if="!risks.length"
          description="当前没有需要关注的风险"
          :image-size="56"
        />
        <ul v-else class="risk-list">
          <li v-for="risk in risks" :key="risk.key">
            <div class="risk-copy">
              <el-button link type="danger" @click="open(risk.target)">{{
                risk.title
              }}</el-button>
              <span v-if="risk.detail">{{ risk.detail }}</span>
            </div>
          </li>
        </ul>
      </section>

      <section class="overview-section" aria-labelledby="overview-events">
        <div class="section-heading">
          <h3 id="overview-events">最近动态</h3>
        </div>
        <el-empty
          v-if="!overview.recentEvents.length"
          description="暂无项目动态"
          :image-size="56"
        />
        <ul v-else class="recent-list">
          <li v-for="event in overview.recentEvents" :key="event.id">
            <span class="recent-event">
              <b>{{ event.actorNameSnapshot }}</b>
              <el-button
                v-if="projectEventTarget(event)"
                link
                type="primary"
                @click="openEvent(event)"
                >{{ projectEventLabel(event) }}</el-button
              >
              <span v-else>{{ projectEventLabel(event) }}</span>
            </span>
            <time :datetime="event.createdAt">{{
              formatProjectEventTime(event.createdAt)
            }}</time>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>

<style scoped>
.project-overview {
  display: grid;
  gap: 20px;
  padding: 16px 0;
}
.overview-heading,
.section-heading,
.metric-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.overview-heading > div {
  flex: 1;
}
.overview-heading h2,
.section-heading h3,
.metric-head h3 {
  margin: 0;
}
.overview-heading h2 {
  font-size: 17px;
}
.overview-heading p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.metric-card {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border-base);
  border-radius: 8px;
  background: var(--bg-surface);
}
.metric-head h3 {
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
}
.metric-head strong {
  font-size: 24px;
  font-variant-numeric: tabular-nums;
}
.metric-emphasis {
  margin-top: 10px;
  color: var(--text-title);
  font-size: 12px;
}
.status-list {
  display: flex;
  flex-wrap: wrap;
  gap: 7px 12px;
  margin-top: 12px;
  color: var(--text-secondary);
  font-size: 12px;
}
.status-list b {
  margin-left: 3px;
  color: var(--text-title);
}
.overview-section {
  display: grid;
  gap: 10px;
}
.scope-progress {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  align-items: center;
  padding: 12px 0;
}
.scope-stat {
  display: grid;
  gap: 8px;
  min-width: 0;
  color: var(--text-secondary);
  font-size: 12px;
}
.scope-stat strong {
  color: var(--text-title);
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}
.scope-stat.scope-failed strong {
  color: var(--color-danger, #cf3434);
}
.action-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}
.action-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-soft);
}
.action-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.action-copy strong {
  overflow: hidden;
  color: var(--text-title);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.action-copy span {
  color: var(--text-secondary);
  font-size: 12px;
}
.section-heading h3 {
  font-size: 14px;
}
.section-heading > span {
  color: var(--text-secondary);
  font-size: 12px;
}
.risk-list,
.recent-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.risk-list li,
.recent-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 38px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-soft);
}
.risk-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.risk-copy span {
  color: var(--text-secondary);
  font-size: 12px;
}
.recent-event {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
.recent-event b {
  font-weight: 600;
}
.recent-list li {
  color: var(--text-regular);
  font-size: 12px;
}
.recent-list time {
  flex: none;
  color: var(--text-muted);
}
@media (max-width: 800px) {
  .metric-grid,
  .scope-progress {
    grid-template-columns: 1fr;
  }
}
</style>
