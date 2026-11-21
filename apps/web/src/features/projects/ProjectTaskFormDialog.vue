<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type { ProjectMember } from "@superpm/shared";
import {
  projectTaskApi,
  type ProjectTask,
  type ProjectTaskInput,
  type ProjectTaskType,
  type TaskRequirementOption,
} from "../../api/project-tasks";

const props = defineProps<{
  modelValue: boolean;
  projectId: number;
  members: ProjectMember[];
  requirementId?: number;
  lockRequirement?: boolean;
  task?: ProjectTask | null;
  loading?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  submit: [value: ProjectTaskInput];
}>();
const formRef = ref();
const requirements = ref<TaskRequirementOption[]>([]);
const requirementSearch = ref("");
const requirementsLoading = ref(false);
const form = reactive({
  title: "",
  type: "development" as ProjectTaskType,
  requirementId: undefined as number | undefined,
  assigneeUserId: undefined as number | undefined,
  confirmerUserId: undefined as number | undefined,
  dueDate: null as string | null,
  description: "",
});
const candidates = computed(() =>
  props.members.filter(
    (member) =>
      member.status === "active" &&
      member.accountStatus === "active" &&
      member.roles.some((role) => role !== "viewer"),
  ),
);
const labels: Record<ProjectTaskType, string> = {
  design: "设计",
  development: "开发",
  testing: "测试",
  deployment: "部署",
  other: "其他",
};
let searchTimer: ReturnType<typeof setTimeout> | undefined;
async function loadRequirements() {
  requirementsLoading.value = true;
  try {
    const response = await projectTaskApi.requirements(
      props.projectId,
      requirementSearch.value.trim(),
      form.requirementId,
    );
    requirements.value = response.items;
  } finally {
    requirementsLoading.value = false;
  }
}
function searchRequirements(value: string) {
  requirementSearch.value = value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadRequirements(), 200);
}
watch(
  () => [props.modelValue, props.task, props.requirementId],
  async () => {
    if (!props.modelValue) return;
    form.title = props.task?.title ?? "";
    form.type = props.task?.type ?? "development";
    form.requirementId = props.task?.requirementId ?? props.requirementId;
    form.assigneeUserId =
      props.task?.assigneeUserId ?? candidates.value[0]?.userId;
    form.confirmerUserId =
      props.task?.confirmerUserId ??
      candidates.value.find((member) => member.userId !== form.assigneeUserId)
        ?.userId ??
      candidates.value[0]?.userId;
    form.dueDate = props.task?.dueDate ?? null;
    form.description = props.task?.description ?? "";
    await loadRequirements();
  },
  { immediate: true },
);
async function submit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  emit("submit", {
    title: form.title.trim(),
    type: form.type,
    requirementId: props.task
      ? (form.requirementId ?? null)
      : form.requirementId,
    assigneeUserId: form.assigneeUserId!,
    confirmerUserId: form.confirmerUserId!,
    dueDate: form.dueDate,
    description: form.description,
  });
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="task ? '编辑任务' : '拆分项目任务'"
    width="540px"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form ref="formRef" :model="form" label-position="top">
      <el-form-item
        label="任务名称"
        prop="title"
        :rules="[
          { required: true, message: '请输入任务名称', trigger: 'blur' },
          { max: 200, message: '任务名称不能超过 200 字', trigger: 'blur' },
        ]"
      >
        <el-input
          v-model="form.title"
          maxlength="200"
          show-word-limit
          placeholder="例如：完成登录流程原型"
        />
      </el-form-item>
      <div class="form-row">
        <el-form-item label="任务类型" class="half">
          <el-select v-model="form.type" style="width: 100%">
            <el-option
              v-for="(label, value) in labels"
              :key="value"
              :label="label"
              :value="value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="截止日期" class="half">
          <el-date-picker
            v-model="form.dueDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="不设置"
            clearable
            style="width: 100%"
          />
        </el-form-item>
      </div>
      <el-form-item v-if="!lockRequirement" label="关联末级需求">
        <el-select
          v-model="form.requirementId"
          filterable
          remote
          clearable
          :remote-method="searchRequirements"
          :loading="requirementsLoading"
          placeholder="项目任务（不关联需求）"
          style="width: 100%"
        >
          <el-option
            v-for="option in requirements"
            :key="option.id"
            :label="option.requirementNo + ' · ' + option.name"
            :value="option.id"
            :disabled="!option.canCreate && option.id !== task?.requirementId"
          />
        </el-select>
        <small class="field-hint"
          >仅显示当前项目的末级需求。项目任务可以不关联需求。</small
        >
      </el-form-item>
      <el-form-item v-else-if="requirementId" label="关联末级需求">
        <el-input
          :model-value="
            requirements.find((option) => option.id === requirementId)
              ?.requirementNo +
            ' · ' +
            (requirements.find((option) => option.id === requirementId)?.name ||
              '')
          "
          disabled
        />
      </el-form-item>
      <div class="form-row">
        <el-form-item
          label="执行人"
          class="half"
          prop="assigneeUserId"
          :rules="[
            { required: true, message: '请选择执行人', trigger: 'change' },
          ]"
        >
          <el-select
            v-model="form.assigneeUserId"
            placeholder="选择项目成员"
            style="width: 100%"
          >
            <el-option
              v-for="member in candidates"
              :key="member.userId"
              :label="member.displayName"
              :value="member.userId"
            />
          </el-select>
        </el-form-item>
        <el-form-item
          label="确认人"
          class="half"
          prop="confirmerUserId"
          :rules="[
            { required: true, message: '请选择确认人', trigger: 'change' },
          ]"
        >
          <el-select
            v-model="form.confirmerUserId"
            placeholder="选择项目成员"
            style="width: 100%"
          >
            <el-option
              v-for="member in candidates"
              :key="member.userId"
              :label="member.displayName"
              :value="member.userId"
            />
          </el-select>
        </el-form-item>
      </div>
      <el-form-item label="任务说明">
        <el-input
          v-model="form.description"
          type="textarea"
          :rows="4"
          maxlength="4000"
          show-word-limit
          placeholder="补充交付内容或完成标准"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="loading" @click="submit"
        >保存任务</el-button
      >
    </template>
  </el-dialog>
</template>

<style scoped>
.form-row {
  display: flex;
  gap: 16px;
}
.half {
  flex: 1;
  min-width: 0;
}
.field-hint {
  display: block;
  width: 100%;
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}
@media (max-width: 560px) {
  .form-row {
    display: block;
  }
}
</style>
