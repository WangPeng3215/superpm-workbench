<script setup lang="ts">
import { computed } from "vue";
import { LeftOutlined, RightOutlined } from "@ant-design/icons-vue";
import type { DailyTaskCalendar, DailyTaskCalendarDay } from "@superpm/shared";
import { formatHours, monthCells, monthLabel, shiftMonth } from "./format";

const props = defineProps<{
  month: string;
  selected: string;
  today: string;
  calendar: DailyTaskCalendar | null;
  loading?: boolean;
}>();
const emit = defineEmits<{
  select: [date: string];
  "update:month": [month: string];
}>();

const cells = computed(() => monthCells(props.month));
const days = computed(() => {
  const map = new Map<string, DailyTaskCalendarDay>();
  if (props.calendar?.month === props.month)
    for (const day of props.calendar.days) map.set(day.date, day);
  return map;
});
const monthHours = computed(() => {
  if (props.calendar?.month !== props.month) return "";
  const seconds = props.calendar.days.reduce(
    (sum, item) => sum + item.actualSeconds,
    0,
  );
  return seconds > 0 ? `本月 ${formatHours(seconds)}` : "";
});

function dayOf(date: string) {
  return days.value.get(date);
}
function progress(date: string) {
  const value = dayOf(date);
  if (!value?.taskCount) return "0%";
  return `${Math.round((value.completedCount / value.taskCount) * 100)}%`;
}
function isDone(date: string) {
  const value = dayOf(date);
  return Boolean(value?.taskCount && value.completedCount >= value.taskCount);
}
function moveMonth(delta: number) {
  emit("update:month", shiftMonth(props.month, delta));
}
</script>

<template>
  <section class="day-calendar surface" :class="{ 'is-loading': loading }">
    <header class="calendar-head">
      <div>
        <strong>{{ monthLabel(month) }}</strong>
        <span class="calendar-sub">任务与工时分布</span>
      </div>
      <div class="calendar-nav">
        <button type="button" aria-label="上个月" @click="moveMonth(-1)">
          <el-icon aria-hidden="true"><LeftOutlined /></el-icon>
        </button>
        <button type="button" aria-label="下个月" @click="moveMonth(1)">
          <el-icon aria-hidden="true"><RightOutlined /></el-icon>
        </button>
      </div>
    </header>
    <div class="calendar-weekdays" aria-hidden="true">
      <span
        v-for="label in ['一', '二', '三', '四', '五', '六', '日']"
        :key="label"
      >
        {{ label }}
      </span>
    </div>
    <div class="calendar-grid">
      <button
        v-for="cell in cells"
        :key="cell.date"
        type="button"
        class="calendar-cell"
        :class="{
          outside: !cell.inMonth,
          selected: cell.date === selected,
          today: cell.date === today,
          done: isDone(cell.date),
          live: dayOf(cell.date)?.hasActive,
        }"
        :aria-current="cell.date === today ? 'date' : undefined"
        :aria-label="`${cell.date} ${dayOf(cell.date)?.taskCount ?? 0} 项任务`"
        @click="emit('select', cell.date)"
      >
        <span class="cell-top">
          <span class="cell-day">{{ Number(cell.date.slice(-2)) }}</span>
          <i v-if="dayOf(cell.date)?.hasActive" class="live-dot" />
        </span>
        <span v-if="dayOf(cell.date)?.taskCount" class="cell-track">
          <i :style="{ width: progress(cell.date) }" />
        </span>
        <span v-if="dayOf(cell.date)?.taskCount" class="cell-meta">
          {{ dayOf(cell.date)!.completedCount }}/{{
            dayOf(cell.date)!.taskCount
          }}
        </span>
      </button>
    </div>
    <footer class="calendar-legend">
      <span><i class="legend-dot done" />已完成</span>
      <span><i class="legend-dot live" />计时中</span>
      <span v-if="monthHours" class="legend-hours">{{ monthHours }}</span>
    </footer>
  </section>
</template>

<style scoped>
.day-calendar {
  --cell-gap: 3px;
  padding: 16px;
  border-radius: var(--radius-lg);
  background:
    radial-gradient(
      circle at 100% 0,
      color-mix(in srgb, var(--brand) 8%, transparent),
      transparent 55%
    ),
    var(--bg-surface);
  transition: opacity var(--duration-normal) var(--ease-standard);
}
.day-calendar.is-loading {
  opacity: 0.72;
}
.calendar-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.calendar-head strong {
  display: block;
  color: var(--text-heading);
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.2px;
}
.calendar-sub {
  display: block;
  margin-top: 2px;
  color: var(--text-faint);
  font-size: 11px;
}
.calendar-nav {
  display: flex;
  gap: 4px;
}
.calendar-nav button {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border-base);
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    border-color var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard),
    background var(--duration-fast) var(--ease-standard);
}
.calendar-nav button:hover {
  color: var(--brand);
  background: var(--bg-hover);
  border-color: var(--border-brand);
}
.calendar-weekdays,
.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: var(--cell-gap);
}
.calendar-weekdays {
  margin-bottom: 6px;
  color: var(--text-faint);
  font-size: 10px;
  text-align: center;
}
.calendar-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 42px;
  padding: 5px 5px 4px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-body);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard);
}
.calendar-cell:hover {
  background: var(--bg-hover);
}
.calendar-cell:active {
  transform: scale(0.97);
}
.calendar-cell.outside {
  color: var(--text-faint);
  opacity: 0.5;
}
.calendar-cell.today {
  border-color: var(--border-brand);
  background: var(--bg-brand-soft);
}
.calendar-cell.selected {
  border-color: var(--brand);
  box-shadow:
    0 0 0 2px var(--brand-ring),
    0 6px 16px -12px var(--brand);
  background: var(--bg-surface);
}
.calendar-cell.selected .cell-day {
  color: var(--brand);
  font-weight: 700;
}
.cell-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 3px;
}
.cell-day {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.live-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--tone-teal-fg);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone-teal-fg) 18%, transparent);
  animation: live-pulse 1.8s ease-out infinite;
}
.cell-track {
  display: block;
  height: 3px;
  border-radius: 99px;
  background: var(--bg-code);
  overflow: hidden;
}
.cell-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--brand), var(--tone-teal-fg));
  transition: width var(--duration-normal) var(--ease-standard);
}
.calendar-cell.done .cell-track i {
  background: linear-gradient(90deg, var(--tone-green-fg), var(--tone-teal-fg));
}
.cell-meta {
  color: var(--text-faint);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}
.calendar-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border-soft);
  color: var(--text-faint);
  font-size: 10px;
}
.calendar-legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.legend-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.legend-dot.done {
  background: var(--tone-green-fg);
}
.legend-dot.live {
  background: var(--tone-teal-fg);
}
.legend-hours {
  margin-left: auto;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
@keyframes live-pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone-teal-fg) 42%, transparent);
  }
  70% {
    box-shadow: 0 0 0 6px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}
</style>
