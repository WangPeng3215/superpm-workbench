import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { FormInstance } from "element-plus";
import { onBeforeRouteLeave } from "vue-router";

import type {
  Requirement,
  RequirementCreate,
  RequirementListResult,
  RequirementUpdate,
  Stage,
  StageHistory,
} from "@superpm/shared";
import {
  priorities,
  requirementStatuses,
  stages,
  stageLabels,
  statusLabels,
  typeLabels,
  requirementCreateSchema,
} from "@superpm/shared";
import { requirementApi } from "../../api/requirements";
import { errorMessage } from "../../api/client";

export function useRequirements() {
  type Mode = "create" | "edit";
  const loading = ref(false);
  const saving = ref(false);
  const list = ref<RequirementListResult>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    matchedCount: 0,
  });
  const selected = ref<Requirement>();
  const history = ref<StageHistory[]>([]);
  const showDrawer = ref(false);
  const showForm = ref(false);
  const formMode = ref<Mode>("create");
  const formRef = ref<FormInstance>();
  const formError = ref("");
  const editingId = ref<number>();
  const initialForm = ref("");
  const viewingStage = ref<Stage>("analysis");
  const loadError = ref("");
  let loadRevision = 0;
  let detailRevision = 0;
  const stageSaving = ref(false);
  const filters = reactive({
    q: "",
    type: undefined as keyof typeof typeLabels | undefined,
    priority: undefined as (typeof priorities)[number] | undefined,
    status: undefined as (typeof requirementStatuses)[number] | undefined,
    currentStage: undefined as Stage | undefined,
    page: 1,
    pageSize: 20,
    sortBy: "updatedAt" as "updatedAt" | "priority" | "proposedAt" | "name",
    sortOrder: "desc" as "asc" | "desc",
  });
  const form = reactive<RequirementCreate>({
    name: "",
    type: "feature",
    priority: "P2",
    description: "",
    status: "not_started",
    currentStage: "analysis",
    parentId: null,
    proposedAt: new Date().toISOString().slice(0, 10),
    expectedAt: null,
    startedAt: null,
    completedAt: null,
    plannedReleaseAt: null,
    releasedAt: null,
  });
  const formRules = {
    name: [{ required: true, message: "请输入需求名称", trigger: "blur" }],
    proposedAt: [
      { required: true, message: "请选择提出日期", trigger: "change" },
    ],
  };
  const parentOptions = computed(() =>
    list.value.items.map((item) => ({
      id: item.id,
      label: `${item.requirementNo} ${item.name}`,
    })),
  );
  const currentStage = computed(
    () => selected.value?.currentStage ?? "analysis",
  );
  const stageProgress = computed(() => stages.indexOf(currentStage.value) + 1);

  function localDate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }
  function resetForm() {
    Object.assign(form, {
      name: "",
      type: "feature",
      priority: "P2",
      description: "",
      status: "not_started",
      currentStage: "analysis",
      parentId: null,
      proposedAt: localDate(),
      expectedAt: null,
      startedAt: null,
      completedAt: null,
      plannedReleaseAt: null,
      releasedAt: null,
    });
    formError.value = "";
  }
  function message(error: unknown) {
    ElMessage({ message: errorMessage(error), type: "error", duration: 4000 });
  }
  async function load() {
    const revision = ++loadRevision;
    loading.value = true;
    loadError.value = "";
    try {
      const result = await requirementApi.list(filters);
      if (revision === loadRevision) {
        list.value = result;
        const lastPage = Math.max(
          1,
          Math.ceil(result.total / filters.pageSize),
        );
        if (filters.page > lastPage) {
          filters.page = lastPage;
          await load();
        }
      }
    } catch (error) {
      if (revision === loadRevision) loadError.value = errorMessage(error);
    } finally {
      if (revision === loadRevision) loading.value = false;
    }
  }
  async function openDetail(requirement: Requirement) {
    const revision = ++detailRevision;
    try {
      const [detail, records] = await Promise.all([
        requirementApi.get(requirement.id),
        requirementApi.history(requirement.id),
      ]);
      if (revision !== detailRevision) return;
      selected.value = detail;
      viewingStage.value = detail.currentStage;
      history.value = records;
      showDrawer.value = true;
    } catch (error) {
      message(error);
    }
  }
  function openCreate(parentId: number | null = null) {
    resetForm();
    form.parentId = parentId;
    editingId.value = undefined;
    formMode.value = "create";
    initialForm.value = JSON.stringify(form);
    showForm.value = true;
  }
  function openEdit(requirement: Requirement) {
    resetForm();
    for (const key of Object.keys(form) as (keyof RequirementCreate)[])
      Object.assign(form, { [key]: requirement[key] });
    editingId.value = requirement.id;
    formMode.value = "edit";
    initialForm.value = JSON.stringify(form);
    showForm.value = true;
  }
  async function mayDiscard() {
    if (saving.value) return false;
    if (JSON.stringify(form) !== initialForm.value) {
      try {
        await ElMessageBox.confirm(
          "当前修改尚未保存，确定放弃吗？",
          "未保存的修改",
          {
            confirmButtonText: "放弃修改",
            cancelButtonText: "继续编辑",
            type: "warning",
          },
        );
      } catch {
        return false;
      }
    }
    return true;
  }
  onBeforeRouteLeave(async () => !showForm.value || (await mayDiscard()));
  async function closeForm(done?: () => void) {
    if (!(await mayDiscard())) return;
    if (done) done();
    else showForm.value = false;
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (showForm.value && JSON.stringify(form) !== initialForm.value) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  onMounted(() => window.addEventListener("beforeunload", beforeUnload));
  onBeforeUnmount(() =>
    window.removeEventListener("beforeunload", beforeUnload),
  );
  async function save() {
    if (saving.value) return;
    formError.value = "";
    saving.value = true;
    try {
      const valid = await formRef.value?.validate().catch(() => false);
      if (!valid) return;
      const parsed = requirementCreateSchema.parse(form);
      if (formMode.value === "create") {
        const created = await requirementApi.create(parsed);
        ElMessage.success(`已创建 ${created.requirementNo}`);
        showForm.value = false;
        await load();
        await openDetail(created);
      } else if (editingId.value) {
        const update: RequirementUpdate = { ...parsed };
        delete update.parentId;
        const updated = await requirementApi.update(editingId.value, update);
        ElMessage.success("需求已保存");
        showForm.value = false;
        const revision = detailRevision;
        if (selected.value?.id === updated.id) {
          const records = await requirementApi.history(updated.id);
          if (
            detailRevision === revision &&
            selected.value?.id === updated.id
          ) {
            selected.value = updated;
            history.value = records;
          }
        }
        await load();
      }
    } catch (error) {
      formError.value = errorMessage(error);
    } finally {
      saving.value = false;
    }
  }
  async function remove(requirement: Requirement) {
    try {
      await ElMessageBox.confirm(
        `确定软删除「${requirement.name}」吗？已有子需求的主需求需要先处理子需求。`,
        "删除需求",
        {
          type: "warning",
          confirmButtonText: "确认删除",
          cancelButtonText: "取消",
        },
      );
      await requirementApi.remove(requirement.id);
      ElMessage.success("需求已移入回收状态");
      showDrawer.value = false;
      await load();
    } catch (error) {
      if (error !== "cancel" && error !== "close") message(error);
    }
  }
  async function changeStage(stage: Stage) {
    if (
      stageSaving.value ||
      !selected.value ||
      stage === selected.value.currentStage
    )
      return;
    stageSaving.value = true;
    const targetId = selected.value.id;
    const revision = detailRevision;
    try {
      const updated = await requirementApi.update(targetId, {
        currentStage: stage,
        stageNote: `在详情工作区切换到${stageLabels[stage]}`,
      });
      const records = await requirementApi.history(updated.id);
      if (detailRevision === revision && selected.value?.id === targetId) {
        selected.value = updated;
        history.value = records;
      }
      await load();
      ElMessage.success(`已切换到${stageLabels[stage]}`);
    } catch (error) {
      message(error);
    } finally {
      stageSaving.value = false;
    }
  }
  function clearFilters() {
    Object.assign(filters, {
      q: "",
      type: undefined,
      priority: undefined,
      status: undefined,
      currentStage: undefined,
      page: 1,
    });
    load();
  }
  function statusType(status: Requirement["status"]) {
    return (
      {
        in_progress: "primary",
        completed: "success",
        blocked: "danger",
        paused: "warning",
        cancelled: "info",
        not_started: "info",
      } as const
    )[status];
  }
  function priorityType(priority: Requirement["priority"]) {
    return (
      { P0: "danger", P1: "warning", P2: "primary", P3: "info" } as const
    )[priority];
  }
  function typeLabel(row: Requirement) {
    return typeLabels[row.type];
  }
  function statusLabel(row: Requirement) {
    return statusLabels[row.status];
  }
  function stageLabel(row: Requirement) {
    return stageLabels[row.currentStage];
  }
  onMounted(load);

  return {
    loading,
    saving,
    list,
    selected,
    history,
    showDrawer,
    showForm,
    formMode,
    formRef,
    formError,
    filters,
    form,
    formRules,
    parentOptions,
    currentStage,
    viewingStage,
    loadError,
    load,
    openDetail,
    openCreate,
    openEdit,
    save,
    remove,
    changeStage,
    closeForm,
    clearFilters,
    statusType,
    priorityType,
    typeLabel,
    statusLabel,
    stageLabel,
    stageSaving,
  };
}
