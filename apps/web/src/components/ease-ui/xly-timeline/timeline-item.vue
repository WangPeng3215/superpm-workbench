<template>
  <div
    class="xly-timeline-item"
    :class="[
      `xly-timeline-item--${status}`,
      `xly-timeline-item--${computedDirection}`,
    ]"
  >
    <!-- 连接线 -->
    <div class="xly-timeline-item__line" />

    <!-- 时间线节点 -->
    <div
      class="xly-timeline-item__node"
      :class="[`xly-timeline-item__node--${status}`]"
    >
      <!-- 自定义插槽（最高优先级） -->
      <slot v-if="$slots.dot" name="dot" />

      <!-- 默认状态图标 -->
      <el-icon v-else-if="status === 'finish'" class="xly-timeline-item__icon">
        <Check />
      </el-icon>
      <el-icon v-else-if="status === 'error'" class="xly-timeline-item__icon">
        <Close />
      </el-icon>
      <el-icon
        v-else-if="status === 'process'"
        class="xly-timeline-item__icon is-loading"
      >
        <Loading />
      </el-icon>
    </div>

    <!-- 内容区域 -->
    <div class="xly-timeline-item__content">
      <div
        v-if="$slots.timestamp || timestamp"
        class="xly-timeline-item__timestamp"
      >
        <slot name="timestamp">{{ timestamp }}</slot>
      </div>
      <div class="xly-timeline-item__body">
        <slot />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, type ComputedRef } from "vue";
import { Check, Close, Loading } from "@element-plus/icons-vue";

defineOptions({ name: "XlyTimelineItem" });

export interface TimelineItemProps {
  /** 节点状态 */
  status?: "wait" | "process" | "finish" | "error";
  /** 时间戳 */
  timestamp?: string;
}

const props = withDefaults(defineProps<TimelineItemProps>(), {
  status: "finish",
  timestamp: "",
});

const timeline = inject<ComputedRef<{ direction: string }>>("timeline");

const computedDirection = computed(
  () => timeline?.value?.direction ?? "vertical",
);
</script>

<style scoped lang="scss">
/* ========== 设计令牌 ========== */
$color-primary: #4f6ef7;
$color-success: #67c23a;
$color-warning: #e6a23c;
$color-danger: #f56c6c;
$color-default: var(--border-line);
$color-text-secondary: var(--text-regular);
$color-text-placeholder: var(--text-muted);

/* ========== 时间线项 ========== */
.xly-timeline-item {
  position: relative;
  padding-bottom: 24px;

  &--vertical {
    display: flex;
    flex-direction: row;

    .xly-timeline-item__content {
      flex: 1;
      margin-left: 16px;
      padding-top: 2px;
    }
  }

  &--horizontal {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
    padding-bottom: 0;

    .xly-timeline-item__content {
      margin-top: 8px;
      text-align: center;
    }
  }

  &--wait {
    .xly-timeline-item__node--wait {
      background-color: var(--bg-surface);
      border-color: $color-default;
      color: var(--text-muted);
    }
  }

  &--process {
    .xly-timeline-item__node--process {
      background-color: $color-primary;
      border-color: $color-primary;
      color: #fff;
      box-shadow: 0 0 0 4px var(--brand-ring);
    }
  }

  &--finish {
    .xly-timeline-item__node--finish {
      background-color: $color-success;
      border-color: $color-success;
      color: #fff;
    }
  }

  &--error {
    .xly-timeline-item__node--error {
      background-color: $color-danger;
      border-color: $color-danger;
      color: #fff;
    }
  }
}

/* ========== 连接线 ========== */
.xly-timeline-item__line {
  position: absolute;
  background-color: $color-default;

  .xly-timeline-item--vertical & {
    left: 9px;
    top: 20px;
    bottom: 0;
    width: 2px;
  }

  /* 横向：节点居中，连接线从本节点连到下一个节点 */
  .xly-timeline-item--horizontal & {
    top: 9px;
    left: calc(50% + 12px);
    right: calc(-50% + 12px);
    height: 2px;
  }

  .xly-timeline-item--wait & {
    background-color: $color-default;
  }

  .xly-timeline-item--process & {
    background: linear-gradient(to bottom, $color-primary, $color-default);
  }

  .xly-timeline-item--horizontal.xly-timeline-item--process & {
    background: linear-gradient(to right, $color-primary, $color-default);
  }

  .xly-timeline-item--finish & {
    background-color: $color-success;
  }

  .xly-timeline-item--error & {
    background-color: $color-danger;
  }
}

/* ========== 节点 ========== */
.xly-timeline-item__node {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid;
  background-color: var(--bg-surface);
  flex-shrink: 0;
  z-index: 1;
  transition: all 0.3s ease;

  &--wait {
    background-color: var(--bg-surface);
    border-color: $color-default;
    color: var(--text-muted);
  }

  &--process {
    background-color: $color-primary;
    border-color: $color-primary;
    color: #fff;
  }

  &--finish {
    background-color: $color-success;
    border-color: $color-success;
    color: #fff;
  }

  &--error {
    background-color: $color-danger;
    border-color: $color-danger;
    color: #fff;
  }
}

.xly-timeline-item__icon {
  font-size: 12px;
}

/* ========== 内容区域 ========== */
.xly-timeline-item__content {
  min-width: 0;
}

.xly-timeline-item__timestamp {
  font-size: 13px;
  color: $color-text-placeholder;
  margin-bottom: 8px;
  line-height: 1.4;
}

.xly-timeline-item__body {
  font-size: 14px;
  color: $color-text-secondary;
  line-height: 1.6;

  p {
    margin: 0;
  }
}
</style>
