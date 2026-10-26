<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type { FormInstance, FormRules } from "element-plus";
import {
  isAllowedExternalUrl,
  onlineToolCategories,
  onlineToolCategoryLabels,
  onlineToolDescriptionMaxLength,
  onlineToolHost,
  onlineToolIconKeys,
  onlineToolIconLabels,
  onlineToolNameMaxLength,
  type OnlineTool,
  type OnlineToolCategory,
  type OnlineToolIconKey,
} from "@superpm/shared";
import { categoryDefaultIcon, onlineToolIcons } from "./icons";
import type { OnlineToolPayload } from "./types";

const props = defineProps<{
  visible: boolean;
  tool: OnlineTool | null;
  saving: boolean;
  error: string;
}>();
const emit = defineEmits<{
  "update:visible": [value: boolean];
  submit: [payload: OnlineToolPayload];
}>();

const formRef = ref<FormInstance>();
const form = reactive({
  name: "",
  url: "",
  icon: null as OnlineToolIconKey | null,
  category: "diagram" as OnlineToolCategory,
  description: "",
  enabled: true,
  isFavorite: false,
});

const title = computed(() => (props.tool ? "编辑工具" : "添加工具"));
const urlHint = computed(() => {
  if (!form.url.trim()) return "支持 http / https，点击后在新标签页打开";
  if (!isAllowedExternalUrl(form.url))
    return "网址需要以 http:// 或 https:// 开头";
  return `将打开 ${onlineToolHost(form.url)}`;
});

const iconOptions = computed(() => [
  {
    key: null as OnlineToolIconKey | null,
    label: "默认",
    icon: onlineToolIcons[categoryDefaultIcon[form.category]],
  },
  ...onlineToolIconKeys.map((key) => ({
    key,
    label: onlineToolIconLabels[key],
    icon: onlineToolIcons[key],
  })),
]);

const rules: FormRules = {
  name: [
    {
      validator: (_rule, value: string, callback) => {
        if (!value.trim()) callback(new Error("请输入工具名称"));
        else callback();
      },
      trigger: "blur",
    },
  ],
  url: [
    {
      validator: (_rule, value: string, callback) => {
        if (!value.trim()) callback(new Error("请输入工具网址"));
        else if (!isAllowedExternalUrl(value))
          callback(new Error("请输入以 http:// 或 https:// 开头的有效网址"));
        else callback();
      },
      trigger: "blur",
    },
  ],
  category: [{ required: true, message: "请选择分类", trigger: "change" }],
};

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    form.name = props.tool?.name ?? "";
    form.url = props.tool?.url ?? "";
    form.icon = props.tool?.icon ?? null;
    form.category = props.tool?.category ?? "diagram";
    form.description = props.tool?.description ?? "";
    form.enabled = props.tool?.enabled ?? true;
    form.isFavorite = props.tool?.isFavorite ?? false;
    formRef.value?.clearValidate();
  },
);

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  emit("submit", {
    name: form.name.trim(),
    url: form.url.trim(),
    icon: form.icon,
    category: form.category,
    description: form.description.trim(),
    enabled: form.enabled,
    isFavorite: form.isFavorite,
  });
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="title"
    width="min(540px, 94vw)"
    :close-on-click-modal="false"
    @update:model-value="emit('update:visible', $event)"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="88px"
      class="tool-form"
      @submit.prevent="submit"
    >
      <el-form-item label="工具名称" prop="name">
        <el-input
          v-model="form.name"
          :maxlength="onlineToolNameMaxLength"
          show-word-limit
          placeholder="例如 draw.io"
          autocomplete="off"
        />
      </el-form-item>
      <el-form-item label="工具网址" prop="url">
        <el-input
          v-model="form.url"
          :maxlength="2048"
          placeholder="https://..."
          autocomplete="off"
          spellcheck="false"
        />
        <p
          class="field-hint"
          :class="{ invalid: form.url && !isAllowedExternalUrl(form.url) }"
        >
          {{ urlHint }}
        </p>
      </el-form-item>
      <el-form-item label="分类" prop="category">
        <el-select v-model="form.category" class="category-select">
          <el-option
            v-for="value in onlineToolCategories"
            :key="value"
            :label="onlineToolCategoryLabels[value]"
            :value="value"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="图标">
        <div class="icon-picker" role="group" aria-label="选择工具图标">
          <button
            v-for="option in iconOptions"
            :key="option.key ?? 'default'"
            type="button"
            class="icon-option"
            :class="{ active: form.icon === option.key }"
            :aria-label="`图标：${option.label}`"
            :aria-pressed="form.icon === option.key"
            :title="option.label"
            @click="form.icon = option.key"
          >
            <el-icon :size="17"><component :is="option.icon" /></el-icon>
            <span>{{ option.label }}</span>
          </button>
        </div>
      </el-form-item>
      <el-form-item label="简介">
        <el-input
          v-model="form.description"
          type="textarea"
          :rows="2"
          resize="none"
          :maxlength="onlineToolDescriptionMaxLength"
          show-word-limit
          placeholder="一句话说明这个工具的用途"
        />
      </el-form-item>
      <el-form-item label="启用状态">
        <div class="switch-row">
          <el-switch v-model="form.enabled" aria-label="启用该工具" />
          <span class="field-hint"
            >停用后即使已收藏，也不会出现在快捷工具箱</span
          >
        </div>
      </el-form-item>
      <el-form-item label="快捷入口">
        <div class="switch-row">
          <el-switch v-model="form.isFavorite" aria-label="加入快捷工具箱" />
          <span class="field-hint">开启后会出现在全局悬浮弹窗中</span>
        </div>
      </el-form-item>
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
        show-icon
        class="form-error"
      />
    </el-form>
    <template #footer>
      <el-button @click="emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">
        保存
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.tool-form :deep(.el-form-item__label) {
  color: var(--text-secondary);
  font-size: 12px;
}
.field-hint {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}
.field-hint.invalid {
  color: var(--danger-text);
}
.category-select {
  width: 100%;
}
.switch-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 2px;
}
.icon-picker {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(58px, 1fr));
  gap: 6px;
  width: 100%;
}
.icon-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 7px 4px 5px;
  border: 1px solid var(--border-base);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 1.2;
  cursor: pointer;
  transition:
    border-color var(--duration-fast) var(--ease-standard),
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard);
}
.icon-option:hover {
  border-color: var(--border-brand);
  color: var(--brand);
  transform: translateY(-1px);
}
.icon-option.active {
  border-color: var(--brand);
  background: var(--bg-brand-soft);
  color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-ring);
}
.icon-option:focus-visible {
  outline-offset: 1px;
}
.form-error {
  margin-top: 2px;
}
</style>
