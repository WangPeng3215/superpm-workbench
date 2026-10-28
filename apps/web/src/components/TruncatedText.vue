<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

defineOptions({ inheritAttrs: false });
const props = defineProps<{ text: string }>();
const element = ref<HTMLElement>();
const truncated = ref(false);
let observer: ResizeObserver | undefined;

function measure() {
  const current = element.value;
  truncated.value = Boolean(
    current && current.scrollWidth > current.clientWidth,
  );
}

onMounted(() => {
  measure();
  if (element.value) {
    observer = new ResizeObserver(measure);
    observer.observe(element.value);
  }
});
watch(
  () => props.text,
  async () => {
    await nextTick();
    measure();
  },
);
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <el-tooltip :content="text" placement="top" :disabled="!truncated">
    <span ref="element" class="truncated-text" v-bind="$attrs">{{ text }}</span>
  </el-tooltip>
</template>

<style scoped>
.truncated-text {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
