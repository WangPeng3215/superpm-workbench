<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  CheckOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  FieldTimeOutlined,
  FileTextOutlined,
  LeftOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
} from "@ant-design/icons-vue";
import type {
  DailyTask,
  DailyTaskCalendar,
  DailyTaskDay,
  DailyTaskStatus,
  DailyTaskSummaryText,
} from "@superpm/shared";
import { dailyLimitSeconds } from "@superpm/shared";
import { dailyTaskApi } from "../api/daily-tasks";
import { errorMessage } from "../api/client";
import XlyEmpty from "../components/ease-ui/xly-empty/index.vue";
import { decorative } from "../components/decorativeIcon";
import DayCalendar from "../features/daily-tasks/DayCalendar.vue";
import TaskFormDialog from "../features/daily-tasks/TaskFormDialog.vue";
import TimeEntryDialog from "../features/daily-tasks/TimeEntryDialog.vue";
import {
  clockValue,
  dateParts,
  formatDuration,
  formatEstimate,
  formatHours,
  formatTimer,
  monthOf,
  shiftDate,
} from "../features/daily-tasks/format";

const CopyIcon = decorative(CopyOutlined);
const PlusIcon = decorative(PlusOutlined);
const ReloadIcon = decorative(ReloadOutlined);

const route = useRoute();
const router = useRouter();

const day = ref<DailyTaskDay | null>(null);
const selectedDate = ref("");
const month = ref("");
const calendar = ref<DailyTaskCalendar | null>(null);
const loading = ref(false);
const calendarLoading = ref(false);
const loadError = ref("");
const statusFilter = ref<"all" | DailyTaskStatus>("all");
const nowMs = ref(Date.now());

const formOpen = ref(false);
const editingTask = ref<DailyTask | null>(null);
const entryOpen = ref(false);
const entryTask = ref<DailyTask | null>(null);
const busyTaskId = ref<number | null>(null);
const stopping = ref(false);
const draggingId = ref<number | null>(null);

const summaryOpen = ref(false);
const summary = ref<DailyTaskSummaryText | null>(null);
const summaryLoading = ref(false);
const summaryError = ref("");

const stats = computed(
  () =>
    day.value?.stats ?? {
      totalCount: 0,
      completedCount: 0,
      plannedMinutes: 0,
      actualSeconds: 0,
      remainingSeconds: dailyLimitSeconds,
      dailyLimitSeconds,
      percent: 0,
    },
);
const activeTimer = computed(() => day.value?.activeTimer ?? null);
const activeElapsed = computed(() => {
  const timer = activeTimer.value;
  if (!timer) return 0;
  const started = new Date(timer.startedAt).getTime();
  const boundary = new Date(timer.autoEndAt).getTime();
  return Math.max(
    0,
    Math.floor((Math.min(nowMs.value, boundary) - started) / 1000),
  );
});
const isToday = computed(
  () => Boolean(day.value) && day.value?.today === day.value?.date,
);
const dateInfo = computed(() =>
  dateParts(day.value?.date ?? selectedDate.value),
);
const ringCircumference = 2 * Math.PI * 50;
const ringOffset = computed(
  () =>
    ringCircumference *
    (1 - Math.min(100, Math.max(0, stats.value.percent)) / 100),
);
const limitPercent = computed(() =>
  Math.min(
    100,
    Math.round(
      (stats.value.actualSeconds / stats.value.dailyLimitSeconds) * 100,
    ),
  ),
);
const statusCounts = computed(() => {
  const counts: Record<DailyTaskStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
  };
  for (const task of day.value?.tasks ?? []) counts[task.status] += 1;
  return counts;
});
const filterOptions = computed(() => [
  {
    value: "all" as const,
    label: `全部任务 · ${day.value?.tasks.length ?? 0}`,
  },
  {
    value: "pending" as const,
    label: `待开始 · ${statusCounts.value.pending}`,
  },
  {
    value: "in_progress" as const,
    label: `进行中 · ${statusCounts.value.in_progress}`,
  },
  {
    value: "completed" as const,
    label: `已完成 · ${statusCounts.value.completed}`,
  },
]);
const filteredTasks = computed(() => {
  const tasks = day.value?.tasks ?? [];
  return statusFilter.value === "all"
    ? tasks
    : tasks.filter((task) => task.status === statusFilter.value);
});
const summaryPreview = computed(() => day.value?.summaryText ?? "");

function applyDay(data: DailyTaskDay) {
  day.value = data;
  selectedDate.value = data.date;
}

async function loadCalendar(background = false) {
  const target = month.value;
  if (!target) return;
  const seq = ++calendarSeq;
  if (!background) calendarLoading.value = true;
  try {
    const data = await dailyTaskApi.calendar(target);
    if (seq === calendarSeq && month.value === target) calendar.value = data;
  } catch {
    // 月历只是辅助信息，失败不打断当天任务操作
  } finally {
    if (seq === calendarSeq) calendarLoading.value = false;
  }
}
let calendarSeq = 0;

async function loadDay(
  date?: string,
  options: { background?: boolean; notify?: boolean } = {},
) {
  const { background = false, notify = false } = options;
  if (!background) {
    loading.value = true;
    loadError.value = "";
  }
  try {
    const data = await dailyTaskApi.day(date);
    applyDay(data);
    const targetMonth = monthOf(data.date);
    if (!month.value || month.value !== targetMonth) {
      month.value = targetMonth;
      await loadCalendar();
    } else if (!calendar.value) {
      void loadCalendar();
    }
    return data;
  } catch (error) {
    if (notify) ElMessage.error(errorMessage(error));
    else if (!background) loadError.value = errorMessage(error);
    return null;
  } finally {
    if (!background) loading.value = false;
  }
}

async function reloadAfterChange() {
  const data = await loadDay(selectedDate.value, {
    background: true,
    notify: true,
  });
  if (data) void loadCalendar(true);
}

let refreshBusy = false;
async function refreshBackground() {
  if (refreshBusy || loading.value) return;
  refreshBusy = true;
  try {
    await loadDay(selectedDate.value, { background: true });
  } finally {
    refreshBusy = false;
  }
}

let boundaryBusy = false;
async function refreshAtBoundary() {
  if (boundaryBusy) return;
  boundaryBusy = true;
  try {
    await refreshBackground();
    void loadCalendar(true);
  } finally {
    boundaryBusy = false;
  }
}

async function selectDate(date: string) {
  if (!date) return;
  if (monthOf(date) !== month.value) {
    month.value = monthOf(date);
    void loadCalendar();
  }
  if (date === selectedDate.value && day.value) return;
  await loadDay(date);
}

function moveDay(delta: number) {
  if (!day.value) return;
  void selectDate(shiftDate(day.value.date, delta));
}

async function goToday() {
  await loadDay();
}

function onMonthChange(next: string) {
  month.value = next;
  void loadCalendar();
}

function isTaskActive(task: DailyTask) {
  return activeTimer.value?.taskId === task.id;
}

function plannedLabel(task: DailyTask) {
  if (task.plannedStartAt && task.plannedEndAt)
    return `${task.plannedStartAt} – ${task.plannedEndAt}`;
  if (task.plannedStartAt) return `${task.plannedStartAt} 开始`;
  return "未设计划时段";
}

function taskPercent(task: DailyTask) {
  if (task.status === "completed") return 100;
  if (!task.estimatedMinutes) return 0;
  return Math.min(
    100,
    Math.round((task.actualSeconds / (task.estimatedMinutes * 60)) * 100),
  );
}

function openCreate() {
  editingTask.value = null;
  formOpen.value = true;
}

function openEdit(task: DailyTask) {
  editingTask.value = task;
  formOpen.value = true;
}

function openEntries(task: DailyTask) {
  entryTask.value = task;
  entryOpen.value = true;
}

async function onTaskSaved(task: DailyTask) {
  if (task.planDate !== selectedDate.value)
    await loadDay(task.planDate, { notify: true });
  else await reloadAfterChange();
  void loadCalendar(true);
}

async function startTask(task: DailyTask) {
  if (busyTaskId.value) return;
  busyTaskId.value = task.id;
  try {
    await dailyTaskApi.start(task.id);
    ElMessage.success(`开始计时：${task.title}`);
    await reloadAfterChange();
  } catch (error) {
    ElMessage.error(errorMessage(error));
    void refreshBackground();
  } finally {
    busyTaskId.value = null;
  }
}

async function stopActive() {
  const timer = activeTimer.value;
  if (!timer || stopping.value) return;
  stopping.value = true;
  try {
    await dailyTaskApi.stop(timer.taskId);
    ElMessage.success("计时已结束");
    await reloadAfterChange();
  } catch (error) {
    ElMessage.error(errorMessage(error));
    void refreshBackground();
  } finally {
    stopping.value = false;
  }
}

async function toggleComplete(task: DailyTask) {
  if (isTaskActive(task)) {
    ElMessage.warning("任务正在计时，请先结束计时再修改状态");
    return;
  }
  if (busyTaskId.value) return;
  busyTaskId.value = task.id;
  const next: DailyTaskStatus =
    task.status === "completed" ? "pending" : "completed";
  try {
    await dailyTaskApi.update(task.id, { status: next });
    ElMessage.success(next === "completed" ? "已标记为完成" : "已重新打开任务");
    await reloadAfterChange();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    busyTaskId.value = null;
  }
}

async function deleteTask(task: DailyTask) {
  try {
    await ElMessageBox.confirm(
      `确定删除“${task.title}”吗？如有工时记录，删除后会归档保留。`,
      "删除任务",
      {
        type: "warning",
        confirmButtonText: "删除",
        cancelButtonText: "取消",
        confirmButtonClass: "el-button--danger",
      },
    );
  } catch {
    return;
  }
  try {
    const result = await dailyTaskApi.remove(task.id);
    ElMessage.success(
      result.archived ? "任务已删除，工时记录已归档" : "任务已删除",
    );
    await reloadAfterChange();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

function onTaskCommand(command: string | number | object, task: DailyTask) {
  const action = String(command);
  if (action === "edit") openEdit(task);
  else if (action === "entries") openEntries(task);
  else if (action === "delete") void deleteTask(task);
}

function onDragStart(event: DragEvent, task: DailyTask) {
  draggingId.value = task.id;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(task.id));
  }
}

async function dropTask(target: DailyTask) {
  const sourceId = draggingId.value;
  draggingId.value = null;
  const current = day.value;
  if (!sourceId || sourceId === target.id || !current) return;
  const ids = current.tasks.map((task) => task.id);
  const from = ids.indexOf(sourceId);
  const to = ids.indexOf(target.id);
  if (from < 0 || to < 0) return;
  const nextIds = [...ids];
  nextIds.splice(from, 1);
  nextIds.splice(to, 0, sourceId);
  const lookup = new Map(current.tasks.map((task) => [task.id, task]));
  day.value = {
    ...current,
    tasks: nextIds.map((id) => lookup.get(id)!),
  };
  try {
    await dailyTaskApi.reorder(current.date, nextIds);
    void refreshBackground();
  } catch (error) {
    ElMessage.error(errorMessage(error));
    void refreshBackground();
  }
}

async function goToActiveTask() {
  const timer = activeTimer.value;
  if (!timer) return;
  await selectDate(timer.taskPlanDate);
}

function onEntrySaved() {
  void loadDay(selectedDate.value, { background: true });
  void loadCalendar(true);
}

async function openSummary() {
  summaryOpen.value = true;
  summaryLoading.value = true;
  summaryError.value = "";
  summary.value = null;
  try {
    summary.value = await dailyTaskApi.summary(selectedDate.value);
  } catch (error) {
    summaryError.value = errorMessage(error);
  } finally {
    summaryLoading.value = false;
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    if (!copied) throw new Error("copy failed");
  }
}

async function copySummary(text?: string) {
  const value = text ?? day.value?.summaryText ?? "";
  if (!value) return;
  try {
    await copyText(value);
    ElMessage.success("工作小结已复制");
  } catch {
    ElMessage.error("复制失败，请打开全文手动选择");
  }
}

function onVisibilityChange() {
  if (!document.hidden) void refreshBackground();
}

function deepLinkParams() {
  const date = typeof route.query.date === "string" ? route.query.date : "";
  const taskId = Number(route.query.task);
  if (!date || !Number.isInteger(taskId) || taskId <= 0) return null;
  return { date, taskId };
}

async function openDeepLinkedTask() {
  const target = deepLinkParams();
  if (!target) return;
  const data = await loadDay(target.date);
  if (data) {
    const task = data.tasks.find((item) => item.id === target.taskId);
    if (task) {
      editingTask.value = task;
      formOpen.value = true;
    } else {
      ElMessage.warning("目标任务不存在或已被删除");
    }
  }
  const query = { ...route.query };
  delete query.date;
  delete query.task;
  void router.replace({ path: route.path, query });
}

watch(
  () => [route.query.date, route.query.task],
  () => {
    if (deepLinkParams()) void openDeepLinkedTask();
  },
);

watch(nowMs, () => {
  const timer = activeTimer.value;
  if (!timer) return;
  if (nowMs.value >= new Date(timer.autoEndAt).getTime() + 500)
    void refreshAtBoundary();
});

let tickTimer = 0;
let pollTimer = 0;
onMounted(() => {
  if (deepLinkParams()) void openDeepLinkedTask();
  else void loadDay();
  tickTimer = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
  pollTimer = window.setInterval(() => {
    if (!document.hidden) void refreshBackground();
  }, 30_000);
  document.addEventListener("visibilitychange", onVisibilityChange);
});
onUnmounted(() => {
  window.clearInterval(tickTimer);
  window.clearInterval(pollTimer);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<template>
  <section
    v-if="!day && loading"
    v-loading="true"
    class="daily-skeleton surface"
  />
  <section v-else-if="!day" class="daily-failure surface">
    <el-alert
      :title="loadError || '每日任务加载失败'"
      type="error"
      :closable="false"
      show-icon
    />
    <el-button type="primary" @click="loadDay()">重新加载</el-button>
  </section>
  <div v-else-if="day" class="daily-page">
    <section class="daily-hero">
      <span class="hero-aurora aurora-a" aria-hidden="true" />
      <span class="hero-aurora aurora-b" aria-hidden="true" />
      <span class="hero-aurora aurora-c" aria-hidden="true" />
      <div class="hero-inner">
        <div class="hero-main">
          <div class="hero-kicker">
            <span class="kicker-dot" />每日任务
            <span class="hero-tz">{{ day.timezone }}</span>
          </div>
          <h1 class="hero-title">
            {{ dateInfo.monthDayLabel }}
            <span class="hero-weekday">{{ dateInfo.weekdayLabel }}</span>
            <span v-if="isToday" class="today-badge">今天</span>
          </h1>
          <p class="hero-sub">
            <template v-if="stats.totalCount">
              共 {{ stats.totalCount }} 项任务 · 计划
              {{ formatEstimate(stats.plannedMinutes) }} · 已记录
              {{ formatHours(stats.actualSeconds) }}
            </template>
            <template v-else>还没有安排，给自己定一个今天的小目标。</template>
          </p>
          <div class="hero-controls">
            <div class="date-nav">
              <button type="button" aria-label="前一天" @click="moveDay(-1)">
                <el-icon aria-hidden="true"><LeftOutlined /></el-icon>
              </button>
              <button
                type="button"
                class="today-btn"
                :class="{ current: isToday }"
                @click="goToday"
              >
                今天
              </button>
              <button type="button" aria-label="后一天" @click="moveDay(1)">
                <el-icon aria-hidden="true"><RightOutlined /></el-icon>
              </button>
            </div>
            <el-button
              type="primary"
              :icon="PlusIcon"
              class="create-button"
              @click="openCreate"
            >
              新建任务
            </el-button>
          </div>
        </div>
        <div class="hero-side">
          <div class="progress-ring">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <defs>
                <linearGradient
                  id="dailyRingGradient"
                  x1="0"
                  y1="0"
                  x2="1"
                  y2="1"
                >
                  <stop offset="0%" stop-color="var(--brand)" />
                  <stop offset="100%" stop-color="var(--tone-teal-fg)" />
                </linearGradient>
              </defs>
              <circle class="ring-track" cx="60" cy="60" r="50" />
              <circle
                class="ring-value"
                cx="60"
                cy="60"
                r="50"
                :style="{
                  strokeDasharray: `${ringCircumference}`,
                  strokeDashoffset: `${ringOffset}`,
                }"
              />
            </svg>
            <div class="ring-center">
              <strong>{{ stats.percent }}%</strong>
              <span>计划达成</span>
            </div>
          </div>
        </div>
      </div>
      <div class="hero-metrics">
        <div class="metric">
          <span>计划</span><strong>{{ stats.totalCount }}</strong
          ><em>项</em>
        </div>
        <div class="metric">
          <span>完成</span><strong>{{ stats.completedCount }}</strong
          ><em>项</em>
        </div>
        <div class="metric">
          <span>实际</span
          ><strong>{{ formatHours(stats.actualSeconds) }}</strong>
        </div>
        <div class="metric meter">
          <div class="meter-head">
            <span>每日工时额度</span>
            <b>
              {{ formatHours(stats.actualSeconds) }} /
              {{ formatHours(stats.dailyLimitSeconds) }}
            </b>
          </div>
          <div class="meter-track">
            <i :style="{ width: `${limitPercent}%` }" />
          </div>
        </div>
      </div>
    </section>

    <section v-if="activeTimer" class="timer-bar">
      <span class="timer-orb"
        ><el-icon aria-hidden="true"><FieldTimeOutlined /></el-icon
      ></span>
      <div class="timer-body">
        <div class="timer-title">
          <span class="timer-live"><i />LIVE</span>
          <strong>{{ activeTimer.taskTitle }}</strong>
        </div>
        <div class="timer-meta">
          <span
            >开始于 {{ clockValue(activeTimer.startedAt, day.timezone) }}</span
          >
          <span>
            预计 {{ clockValue(activeTimer.autoEndAt, day.timezone) }}
            自动结束
          </span>
          <button
            v-if="activeTimer.taskPlanDate !== day.date"
            type="button"
            class="timer-link"
            @click="goToActiveTask"
          >
            前往 {{ activeTimer.taskPlanDate }}
          </button>
        </div>
      </div>
      <div class="timer-clock">{{ formatTimer(activeElapsed) }}</div>
      <el-button
        type="primary"
        class="timer-stop"
        :loading="stopping"
        @click="stopActive"
      >
        结束计时
      </el-button>
    </section>

    <div class="daily-grid">
      <section class="task-column">
        <div class="task-toolbar">
          <el-select
            v-model="statusFilter"
            size="small"
            class="status-filter"
            aria-label="按状态筛选任务"
          >
            <el-option
              v-for="option in filterOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
          <span class="task-count">
            {{ filteredTasks.length }} / {{ day.tasks.length }} 项
          </span>
          <span class="toolbar-spacer" />
          <el-button
            text
            size="small"
            :icon="ReloadIcon"
            :loading="loading"
            @click="loadDay(day.date)"
          >
            刷新
          </el-button>
        </div>
        <el-alert
          v-if="loadError"
          :title="loadError"
          type="error"
          :closable="false"
          show-icon
          class="task-alert"
        />
        <div v-loading="loading" class="task-list">
          <template v-if="filteredTasks.length">
            <article
              v-for="task in filteredTasks"
              :key="task.id"
              class="task-card"
              :class="[
                `status-${task.status}`,
                {
                  active: isTaskActive(task),
                  completed: task.status === 'completed',
                  dragging: draggingId === task.id,
                },
              ]"
              @dragover.prevent
              @drop="dropTask(task)"
            >
              <button
                type="button"
                class="drag-handle"
                draggable="true"
                title="拖动调整顺序"
                aria-label="拖动调整顺序"
                @dragstart="onDragStart($event, task)"
                @dragend="draggingId = null"
              >
                ⠿
              </button>
              <button
                type="button"
                class="task-check"
                :class="{ checked: task.status === 'completed' }"
                :disabled="isTaskActive(task) || busyTaskId === task.id"
                :aria-pressed="task.status === 'completed'"
                :aria-label="
                  task.status === 'completed' ? '标记为待开始' : '标记为已完成'
                "
                @click="toggleComplete(task)"
              >
                <el-icon aria-hidden="true" v-if="task.status === 'completed'"
                  ><CheckOutlined
                /></el-icon>
              </button>
              <div class="task-main">
                <div class="task-head">
                  <h3 :title="task.title">{{ task.title }}</h3>
                  <span v-if="isTaskActive(task)" class="live-badge">
                    <i />计时中
                  </span>
                  <span
                    v-else-if="task.status === 'completed'"
                    class="done-badge"
                  >
                    已完成
                  </span>
                </div>
                <div class="task-meta">
                  <RouterLink
                    v-if="task.requirement"
                    :to="`/requirements/${task.requirement.id}`"
                    class="requirement-chip"
                    :title="task.requirement.name"
                  >
                    {{ task.requirement.requirementNo }}
                  </RouterLink>
                  <span>
                    <el-icon aria-hidden="true"><ClockCircleOutlined /></el-icon
                    >{{ plannedLabel(task) }}
                  </span>
                  <span>
                    {{ formatDuration(task.actualSeconds) }} / 预计
                    {{ formatEstimate(task.estimatedMinutes) }}
                  </span>
                  <span v-if="task.timeEntries.length">
                    {{ task.timeEntries.length }} 段记录
                  </span>
                </div>
                <p v-if="task.description" class="task-desc">
                  {{ task.description }}
                </p>
                <div class="task-progress">
                  <i :style="{ width: `${taskPercent(task)}%` }" />
                </div>
              </div>
              <div class="task-actions">
                <el-button
                  v-if="isTaskActive(task)"
                  type="primary"
                  size="small"
                  class="action-btn"
                  :loading="stopping"
                  @click="stopActive"
                >
                  结束
                </el-button>
                <el-button
                  v-else-if="task.status !== 'completed'"
                  size="small"
                  class="action-btn start"
                  :disabled="Boolean(activeTimer) || busyTaskId === task.id"
                  :title="activeTimer ? '请先结束当前计时' : '开始计时'"
                  @click="startTask(task)"
                >
                  开始
                </el-button>
                <el-dropdown
                  trigger="click"
                  @command="onTaskCommand($event, task)"
                >
                  <button type="button" class="more-btn" aria-label="更多操作">
                    <el-icon aria-hidden="true"><MoreOutlined /></el-icon>
                  </button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="edit">
                        编辑任务
                      </el-dropdown-item>
                      <el-dropdown-item command="entries">
                        工时校正
                      </el-dropdown-item>
                      <el-dropdown-item command="delete" divided>
                        删除任务
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </article>
          </template>
          <XlyEmpty
            v-else
            type="list"
            :description="
              statusFilter === 'all' ? '这一天还没有任务' : '当前筛选下没有任务'
            "
          >
            <el-button
              v-if="statusFilter !== 'all'"
              plain
              @click="statusFilter = 'all'"
            >
              清除筛选
            </el-button>
            <el-button v-else type="primary" plain @click="openCreate">
              新建任务
            </el-button>
          </XlyEmpty>
        </div>
      </section>

      <aside class="daily-aside">
        <DayCalendar
          :month="month"
          :selected="day.date"
          :today="day.today"
          :calendar="calendar"
          :loading="calendarLoading"
          @select="selectDate"
          @update:month="onMonthChange"
        />
        <section class="summary-card surface">
          <div class="summary-head">
            <span class="summary-icon">
              <el-icon aria-hidden="true"><FileTextOutlined /></el-icon>
            </span>
            <div>
              <strong>工作小结</strong>
              <small>按完成情况与工时自动汇总</small>
            </div>
          </div>
          <p class="summary-preview">{{ summaryPreview }}</p>
          <div class="summary-actions">
            <el-button text size="small" @click="openSummary">
              查看全文
            </el-button>
            <el-button
              text
              size="small"
              :icon="CopyIcon"
              @click="copySummary()"
            >
              复制
            </el-button>
          </div>
        </section>
      </aside>
    </div>

    <TaskFormDialog
      :model-value="formOpen"
      :date="day.date"
      :task="editingTask"
      @saved="onTaskSaved"
      @update:model-value="
        (open) => {
          formOpen = open;
          if (!open) editingTask = null;
        }
      "
    />
    <TimeEntryDialog
      v-model="entryOpen"
      :task="entryTask"
      :time-zone="day.timezone"
      @saved="onEntrySaved"
    />
    <el-dialog
      v-model="summaryOpen"
      title="每日工作总结"
      width="min(680px, 94vw)"
    >
      <div v-if="summaryLoading" v-loading="true" class="summary-loading" />
      <el-alert
        v-else-if="summaryError"
        :title="summaryError"
        type="error"
        :closable="false"
        show-icon
      />
      <pre v-else class="summary-text">{{ summary?.text }}</pre>
      <template #footer>
        <el-button @click="summaryOpen = false">关闭</el-button>
        <el-button
          type="primary"
          :icon="CopyIcon"
          :disabled="summaryLoading || Boolean(summaryError)"
          @click="copySummary(summary?.text)"
        >
          复制全文
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.daily-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1500px;
  margin: 0 auto;
}
.daily-skeleton {
  min-height: 340px;
  border-radius: var(--radius-lg);
}
.daily-failure {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
  padding: 24px;
}
.daily-hero {
  position: relative;
  overflow: hidden;
  padding: 20px 22px 0;
  border: 1px solid color-mix(in srgb, var(--brand) 20%, var(--border-base));
  border-radius: 18px;
  background: linear-gradient(
    130deg,
    color-mix(in srgb, var(--brand) 13%, var(--bg-surface)) 0%,
    var(--bg-surface) 46%,
    color-mix(in srgb, var(--tone-teal-fg) 9%, var(--bg-surface)) 100%
  );
  box-shadow:
    0 24px 50px -42px var(--brand),
    var(--shadow-sm);
}
.hero-aurora {
  position: absolute;
  width: 420px;
  height: 420px;
  border-radius: 50%;
  filter: blur(72px);
  pointer-events: none;
}
.aurora-a {
  top: -230px;
  right: 5%;
  background: radial-gradient(circle, var(--brand), transparent 66%);
  opacity: 0.45;
  animation: aurora-drift 22s ease-in-out infinite alternate;
}
.aurora-b {
  bottom: -280px;
  left: 24%;
  background: radial-gradient(circle, var(--tone-teal-fg), transparent 66%);
  opacity: 0.3;
  animation: aurora-drift 27s ease-in-out infinite alternate-reverse;
}
.aurora-c {
  top: -170px;
  left: -140px;
  background: radial-gradient(circle, var(--tone-purple-fg), transparent 66%);
  opacity: 0.22;
}
html.dark .hero-aurora {
  opacity: 0.28;
}
.hero-inner {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
.hero-main {
  min-width: 0;
}
.hero-kicker {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.kicker-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
  box-shadow: 0 0 0 4px var(--brand-ring);
}
.hero-tz {
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.06em;
}
.hero-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 7px 0 0;
  color: var(--text-heading);
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -1.2px;
  line-height: 1.15;
}
.hero-weekday {
  color: var(--text-muted);
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 0;
}
.today-badge {
  margin-left: 2px;
  padding: 2px 8px;
  border: 1px solid var(--border-brand);
  border-radius: 99px;
  background: var(--bg-brand-soft);
  color: var(--brand);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
}
.hero-sub {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.hero-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 15px;
}
.date-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border-base);
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-surface) 62%, transparent);
  backdrop-filter: blur(10px);
}
.date-nav button {
  display: grid;
  place-items: center;
  height: 28px;
  min-width: 28px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}
.date-nav button:hover {
  background: var(--bg-hover);
  color: var(--text-title);
}
.today-btn {
  padding: 0 9px;
}
.today-btn.current {
  color: var(--brand);
  font-weight: 600;
}
.create-button {
  box-shadow: 0 8px 20px -12px var(--brand);
}
.hero-side {
  flex: none;
  width: 136px;
  display: grid;
  place-items: center;
}
.progress-ring {
  position: relative;
  width: 124px;
  height: 124px;
  filter: drop-shadow(
    0 0 16px color-mix(in srgb, var(--brand) 34%, transparent)
  );
}
.progress-ring svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.ring-track {
  fill: none;
  stroke: color-mix(in srgb, var(--text-faint) 16%, transparent);
  stroke-width: 8;
}
.ring-value {
  fill: none;
  stroke: url(#dailyRingGradient);
  stroke-width: 8;
  stroke-linecap: round;
  transition: stroke-dashoffset 700ms var(--ease-standard);
}
.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
}
.ring-center strong {
  color: var(--text-heading);
  font-size: 27px;
  font-weight: 700;
  letter-spacing: -1.2px;
  font-variant-numeric: tabular-nums;
}
.ring-center span {
  color: var(--text-faint);
  font-size: 10px;
}
.hero-metrics {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 17px;
  padding: 11px 2px 13px;
  border-top: 1px solid color-mix(in srgb, var(--border-base) 72%, transparent);
}
.metric {
  display: flex;
  align-items: baseline;
  gap: 3px;
  min-width: 74px;
  padding-right: 18px;
  border-right: 1px solid var(--border-soft);
}
.metric > span {
  margin-right: auto;
  color: var(--text-faint);
  font-size: 10px;
  letter-spacing: 0.08em;
}
.metric strong {
  color: var(--text-heading);
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.4px;
  font-variant-numeric: tabular-nums;
}
.metric em {
  color: var(--text-muted);
  font-size: 10px;
  font-style: normal;
}
.metric.meter {
  flex: 1;
  display: block;
  min-width: 170px;
  padding-right: 0;
  border-right: 0;
}
.meter-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  color: var(--text-faint);
  font-size: 10px;
  letter-spacing: 0.04em;
}
.meter-head b {
  color: var(--text-body);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.meter-track {
  height: 6px;
  margin-top: 6px;
  overflow: hidden;
  border-radius: 99px;
  background: color-mix(in srgb, var(--text-faint) 14%, transparent);
}
.meter-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--brand), var(--tone-teal-fg));
  box-shadow: 0 0 12px color-mix(in srgb, var(--brand) 55%, transparent);
  transition: width 600ms var(--ease-standard);
}
.timer-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border: 1px solid transparent;
  border-radius: 16px;
  background:
    linear-gradient(var(--bg-surface), var(--bg-surface)) padding-box,
    linear-gradient(
        120deg,
        var(--brand),
        var(--tone-teal-fg),
        var(--tone-purple-fg),
        var(--brand)
      )
      border-box;
  background-size:
    100% 100%,
    300% 300%;
  box-shadow: 0 14px 34px -30px var(--brand);
  animation: border-flow 7s linear infinite;
}
.timer-orb {
  display: grid;
  flex: none;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  background: linear-gradient(135deg, var(--brand), var(--tone-teal-fg));
  color: #fff;
  font-size: 19px;
  box-shadow: 0 0 20px color-mix(in srgb, var(--brand) 42%, transparent);
}
.timer-body {
  min-width: 0;
}
.timer-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.timer-title strong {
  overflow: hidden;
  color: var(--text-heading);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timer-live {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 1px 6px;
  border-radius: 99px;
  background: var(--tone-teal-bg);
  color: var(--tone-teal-fg);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
}
.timer-live i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  animation: live-pulse 1.6s ease-out infinite;
}
.timer-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 2px;
  color: var(--text-faint);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.timer-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--brand);
  font: inherit;
  font-size: 10px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.timer-clock {
  margin-left: auto;
  color: var(--text-heading);
  font-size: 26px;
  font-weight: 650;
  letter-spacing: 0.06em;
  font-variant-numeric: tabular-nums;
}
.timer-stop {
  flex: none;
}
.daily-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 336px;
  gap: 16px;
  align-items: start;
}
.task-column {
  min-width: 0;
}
.task-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
  margin-bottom: 10px;
}
.status-filter {
  width: 138px;
}
.task-count {
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.toolbar-spacer {
  flex: 1;
}
.task-alert {
  margin-bottom: 10px;
}
.task-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-height: 160px;
}
.task-card {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 12px 11px 12px 6px;
  border: 1px solid var(--border-base);
  border-radius: 12px;
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
  transition:
    border-color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-normal) var(--ease-standard),
    transform var(--duration-normal) var(--ease-standard),
    opacity var(--duration-fast) var(--ease-standard);
}
.task-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
.task-card.dragging {
  opacity: 0.45;
}
.task-card.active {
  border-color: color-mix(in srgb, var(--tone-teal-fg) 45%, var(--border-base));
  box-shadow: 0 14px 34px -28px var(--tone-teal-fg);
}
.task-card.completed {
  background: color-mix(in srgb, var(--bg-subtle) 72%, var(--bg-surface));
}
.drag-handle {
  width: 13px;
  min-height: 30px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-faint);
  font-size: 13px;
  line-height: 1;
  cursor: grab;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-standard);
}
.task-card:hover .drag-handle,
.drag-handle:focus-visible {
  opacity: 0.75;
}
.drag-handle:active {
  cursor: grabbing;
}
.task-check {
  display: grid;
  place-items: center;
  flex: none;
  width: 21px;
  height: 21px;
  margin-top: 1px;
  padding: 0;
  border: 1.5px solid var(--border-strong);
  border-radius: 50%;
  background: transparent;
  color: transparent;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color var(--duration-fast) var(--ease-standard),
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard);
}
.task-check:hover {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-ring);
}
.task-check.checked {
  border-color: transparent;
  background: linear-gradient(135deg, var(--brand), var(--tone-teal-fg));
  color: #fff;
  box-shadow: 0 0 12px var(--brand-ring);
}
.task-check:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.task-main {
  flex: 1;
  min-width: 0;
}
.task-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.task-head h3 {
  overflow: hidden;
  margin: 0;
  color: var(--text-title);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-card.completed .task-head h3 {
  color: var(--text-muted);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--text-faint) 55%, transparent);
}
.live-badge,
.done-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 1px 7px;
  border-radius: 99px;
  font-size: 9px;
  font-weight: 600;
}
.live-badge {
  background: var(--tone-teal-bg);
  color: var(--tone-teal-fg);
}
.live-badge i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  animation: live-pulse 1.6s ease-out infinite;
}
.done-badge {
  background: var(--tone-green-bg);
  color: var(--tone-green-fg);
}
.task-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  margin-top: 5px;
  color: var(--text-faint);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.task-meta > span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.requirement-chip {
  max-width: 150px;
  overflow: hidden;
  padding: 0 6px;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    border-color var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}
.requirement-chip:hover {
  border-color: var(--border-brand);
  color: var(--brand);
}
.task-desc {
  overflow: hidden;
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-progress {
  height: 3px;
  margin-top: 9px;
  overflow: hidden;
  border-radius: 99px;
  background: var(--bg-code);
}
.task-progress i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--brand), var(--tone-teal-fg));
  transition: width var(--duration-normal) var(--ease-standard);
}
.task-card.completed .task-progress i {
  background: linear-gradient(90deg, var(--tone-green-fg), var(--tone-teal-fg));
}
.task-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.action-btn {
  height: 27px;
  padding: 0 11px;
  border-radius: 7px;
  font-size: 11px;
}
.action-btn.start {
  border-color: var(--border-brand);
  background: var(--bg-brand-soft);
  color: var(--brand);
}
.action-btn.start:hover {
  border-color: var(--brand);
  background: var(--bg-active);
  color: var(--brand-strong);
}
.more-btn {
  display: grid;
  place-items: center;
  width: 27px;
  height: 27px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}
.more-btn:hover {
  background: var(--bg-hover);
  color: var(--text-title);
}
.daily-aside {
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.summary-card {
  padding: 15px 16px;
  border-radius: var(--radius-lg);
  background:
    radial-gradient(
      circle at 100% 0,
      color-mix(in srgb, var(--tone-purple-fg) 9%, transparent),
      transparent 60%
    ),
    var(--bg-surface);
}
.summary-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 9px;
}
.summary-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--tone-purple-fg) 14%, transparent);
  color: var(--tone-purple-fg);
  font-size: 16px;
}
.summary-head strong {
  display: block;
  color: var(--text-heading);
  font-size: 13px;
  font-weight: 600;
}
.summary-head small {
  display: block;
  margin-top: 1px;
  color: var(--text-faint);
  font-size: 10px;
}
.summary-preview {
  display: -webkit-box;
  overflow: hidden;
  margin: 0;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 11px;
  line-height: 1.7;
  white-space: pre-line;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
}
.summary-actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  margin-top: 7px;
}
.summary-loading {
  min-height: 200px;
}
.summary-text {
  max-height: 52vh;
  overflow: auto;
  margin: 0;
  padding: 15px;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  background: var(--bg-subtle);
  color: var(--text-body);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.85;
  white-space: pre-wrap;
}
@keyframes aurora-drift {
  from {
    transform: translate3d(0, 0, 0) scale(1);
  }
  to {
    transform: translate3d(28px, 18px, 0) scale(1.12);
  }
}
@keyframes border-flow {
  from {
    background-position:
      0 0,
      0% 50%;
  }
  to {
    background-position:
      0 0,
      300% 50%;
  }
}
@keyframes live-pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 45%, transparent);
  }
  70% {
    box-shadow: 0 0 0 5px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}
@media (max-width: 1180px) {
  .daily-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .daily-aside {
    position: static;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 320px);
    align-items: start;
  }
}
@media (max-width: 860px) {
  .hero-side {
    display: none;
  }
  .daily-aside {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 640px) {
  .daily-hero {
    padding: 16px 14px 0;
    border-radius: 14px;
  }
  .hero-title {
    flex-wrap: wrap;
    font-size: 26px;
  }
  .hero-metrics {
    flex-wrap: wrap;
    gap: 10px 16px;
  }
  .metric {
    min-width: 64px;
    padding-right: 14px;
  }
  .metric.meter {
    flex-basis: 100%;
  }
  .timer-bar {
    flex-wrap: wrap;
    gap: 10px;
  }
  .timer-clock {
    margin-left: 0;
    font-size: 22px;
  }
  .timer-stop {
    margin-left: auto;
  }
  .task-card {
    flex-wrap: wrap;
  }
  .task-main {
    flex-basis: calc(100% - 62px);
  }
  .task-actions {
    margin-left: auto;
  }
  .daily-aside {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
