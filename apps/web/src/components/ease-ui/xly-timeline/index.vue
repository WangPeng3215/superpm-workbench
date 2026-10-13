<template>
  <div class="xly-timeline" :class="[`xly-timeline--${direction}`]">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed, provide } from "vue";

defineOptions({ name: "XlyTimeline" });

export interface TimelineContext {
  direction: "horizontal" | "vertical";
}

const props = withDefaults(
  defineProps<{
    /** 时间线方向 */
    direction?: "horizontal" | "vertical";
  }>(),
  {
    direction: "vertical",
  },
);

provide(
  "timeline",
  computed<TimelineContext>(() => ({ direction: props.direction })),
);
</script>

<style scoped lang="scss">
.xly-timeline {
  &--vertical {
    padding-left: 0;
  }

  &--horizontal {
    display: flex;
    align-items: flex-start;
    width: 100%;

    :deep(.xly-timeline-item) {
      flex: 1;
    }
  }

  // 最后一项不再向右延伸连接线
  :deep(.xly-timeline-item:last-child) .xly-timeline-item__line {
    display: none;
  }
}
</style>
