<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import type { FormInstance, FormRules } from "element-plus";
import { ElMessage } from "element-plus";
import type { DailyTask, DailyTaskCreate, Requirement } from "@superpm/shared";
import { dailyEstimatedMinuteMax } from "@superpm/shared";
import { dailyTaskApi } from "../../api/daily-tasks";
import { requirementApi } from "../../api/requirements";
import { errorMessage } from "../../api/client";
import { formatEstimate } from "./format";

const props = defineProps<{
  modelValue: boolean;
  date: string;
  task: DailyTask | null;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [task: DailyTask];
}>();

interface RequirementOption {
  id: number;
  requirementNo: string;
  name: string;
  depth: number;
  label: string;
}

const formRef = ref<FormInstance>();
const form = reactive({
  title: "",
  description: "",
  planDate: "",
  requirementId: null as number | null,
  estimatedMinutes: 60,
});
const plannedRange = ref<[string, string] | null>(null);
const formError = ref("");
const saving = ref(false);
const requirementOptions = ref<RequirementOption[]>([]);
const requirementLoading = ref(false);
let requirementSeq = 0;
let requirementTimer: number | undefined;

const rules: FormRules = {
  title: [{ required: true, message: "请输入任务名称", trigger: "blur" }],
  planDate: [{ required: true, message: "请选择计划日期", trigger: "change" }],
  estimatedMinutes: [
    { required: true, message: "请选择预计耗时", trigger: "change" },
  ],
};

const estimateOptions = computed(() =>
  Array.from(
    { length: (dailyEstimatedMinuteMax - 30) / 30 + 1 },
    (_, index) => {
      const minutes = 30 + index * 30;
      return { value: minutes, label: formatEstimate(minutes) };
    },
  ),
);

function flatten(
  items: Array<Requirement & { children?: Requirement[] }>,
  depth = 0,
  out: RequirementOption[] = [],
) {
  for (const item of items) {
    out.push({
      id: item.id,
      requirementNo: item.requirementNo,
      name: item.name,
      depth,
      label: `${item.requirementNo} · ${item.name}`,
    });
    if (item.children?.length) flatten(item.children, depth + 1, out);
  }
  return out;
}

function rememberSelected(items: RequirementOption[]) {
  const linked = props.task?.requirement;
  if (linked && !items.some((item) => item.id === linked.id))
    items.unshift({
      id: linked.id,
      requirementNo: linked.requirementNo,
      name: linked.name,
      depth: 0,
      label: `${linked.requirementNo} · ${linked.name}`,
    });
  if (
    form.requirementId &&
    !items.some((item) => item.id === form.requirementId)
  ) {
    const option = requirementOptions.value.find(
      (item) => item.id === form.requirementId,
    );
    if (option) items.unshift(option);
  }
  requirementOptions.value = items;
}

async function loadRequirements(query = "") {
  const seq = ++requirementSeq;
  requirementLoading.value = true;
  try {
    const result = await requirementApi.list({
      q: query,
      page: 1,
      pageSize: 50,
      sortBy: "updatedAt",
      sortOrder: "desc",
    });
    if (seq !== requirementSeq) return;
    rememberSelected(flatten(result.items));
  } catch {
    // 需求下拉加载失败不影响任务本身的编辑
  } finally {
    if (seq === requirementSeq) requirementLoading.value = false;
  }
}

function searchRequirements(query: string) {
  window.clearTimeout(requirementTimer);
  requirementTimer = window.setTimeout(() => void loadRequirements(query), 250);
}

function resetForm() {
  const task = props.task;
  form.title = task?.title ?? "";
  form.description = task?.description ?? "";
  form.planDate = task?.planDate ?? props.date;
  form.requirementId = task?.requirementId ?? null;
  form.estimatedMinutes = task?.estimatedMinutes ?? 60;
  plannedRange.value =
    task?.plannedStartAt && task?.plannedEndAt
      ? [task.plannedStartAt, task.plannedEndAt]
      : null;
  formError.value = "";
  requirementOptions.value = [];
  requirementSeq += 1;
  rememberSelected([]);
  void loadRequirements();
  void nextTick(() => formRef.value?.clearValidate());
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) resetForm();
  },
);

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  if (!form.title.trim()) {
    formError.value = "请输入任务名称";
    return;
  }
  if (plannedRange.value && plannedRange.value[0] >= plannedRange.value[1]) {
    formError.value = "计划结束时间必须晚于开始时间";
    return;
  }
  formError.value = "";
  saving.value = true;
  const payload: DailyTaskCreate = {
    title: form.title.trim(),
    description: form.description,
    planDate: form.planDate,
    requirementId: form.requirementId ?? null,
    plannedStartAt: plannedRange.value?.[0] ?? null,
    plannedEndAt: plannedRange.value?.[1] ?? null,
    estimatedMinutes: form.estimatedMinutes,
  };
  try {
    const saved = props.task
      ? await dailyTaskApi.update(props.task.id, payload)
      : await dailyTaskApi.create(payload);
    ElMessage.success(props.task ? "任务已更新" : "任务已创建");
    emit("saved", saved);
    emit("update:modelValue", false);
  } catch (error) {
    formError.value = errorMessage(error);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="task ? '编辑任务' : '新建任务'"
    width="min(620px, 94vw)"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form
      ref="formRef"
      label-position="top"
      :model="form"
      :rules="rules"
      class="task-form"
      @submit.prevent="submit"
    >
      <el-alert
        v-if="formError"
        :title="formError"
        type="error"
        :closable="false"
        show-icon
        class="form-alert"
      />
      <el-form-item label="任务名称" prop="title">
        <el-input
          v-model="form.title"
          maxlength="200"
          placeholder="今天要完成什么？"
          autofocus
          @keyup.enter="submit"
        />
      </el-form-item>
      <div class="form-row">
        <el-form-item label="计划日期" prop="planDate">
          <el-date-picker
            v-model="form.planDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择日期"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="预计耗时" prop="estimatedMinutes">
          <el-select v-model="form.estimatedMinutes" style="width: 100%">
            <el-option
              v-for="option in estimateOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
      </div>
      <div class="form-row">
        <el-form-item label="计划时段（可选）">
          <el-time-picker
            v-model="plannedRange"
            is-range
            format="HH:mm"
            value-format="HH:mm"
            range-separator="至"
            start-placeholder="开始"
            end-placeholder="结束"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="关联需求（可选）">
          <el-select
            v-model="form.requirementId"
            filterable
            remote
            clearable
            :remote-method="searchRequirements"
            :loading="requirementLoading"
            placeholder="搜索编号或名称"
            style="width: 100%"
          >
            <el-option
              v-for="option in requirementOptions"
              :key="option.id"
              :label="option.label"
              :value="option.id"
            >
              <div class="requirement-option">
                <span class="requirement-no">{{ option.requirementNo }}</span>
                <span class="requirement-name">{{ option.name }}</span>
              </div>
            </el-option>
          </el-select>
        </el-form-item>
      </div>
      <el-form-item label="备注">
        <el-input
          v-model="form.description"
          type="textarea"
          :rows="3"
          maxlength="4000"
          resize="none"
          placeholder="补充执行要点、验收口径或依赖信息"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">
        {{ task ? "保存修改" : "创建任务" }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.task-form {
  display: flex;
  flex-direction: column;
}
.form-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 14px;
}
.form-alert {
  margin-bottom: 14px;
}
.requirement-option {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.requirement-no {
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.requirement-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 560px) {
  .form-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
