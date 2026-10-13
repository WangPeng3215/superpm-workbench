import {
  computed,
  onMounted,
  onBeforeUnmount,
  reactive,
  ref,
  watch,
} from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  dateFields,
  requirementCreateSchema,
  type Requirement,
  type RequirementCreateParsed,
  type RequirementListQuery,
  type RequirementListResult,
  type Stage,
  type StageHistory,
} from "@superpm/shared";
import { requirementApi } from "../../api/requirements";
import { errorMessage } from "../../api/client";
import {
  columnDefaults,
  restoreColumns,
  columnStorageKey,
  type TableColumn,
} from "./table-config";
export function useEditableTable() {
  const list = ref<RequirementListResult>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    matchedCount: 0,
  });
  const loading = ref(false),
    saving = ref(false),
    loadError = ref(""),
    formError = ref("");
  const filters = reactive<RequirementListQuery>({
    q: "",
    page: 1,
    pageSize: 20,
    sortBy: "updatedAt",
    sortOrder: "desc",
  });
  const dateRanges = reactive<Record<string, string[] | null>>({});
  const expandedDates = ref(false);
  const editingId = ref<number | null>(null),
    editing = ref(false),
    initial = ref("");
  const blank = (): RequirementCreateParsed =>
    requirementCreateSchema.parse({
      name: "临时名称",
      proposedAt: new Date().toLocaleDateString("sv-SE"),
    });
  const form = reactive<RequirementCreateParsed>({ ...blank(), name: "" });
  const columns = ref(restoreColumns()),
    showColumns = ref(false),
    dragged = ref<string>();
  const visibleColumns = computed(() =>
    columns.value
      .filter((c) => c.visible)
      .sort(
        (a, b) =>
          ({ left: 0, "": 1, right: 2 })[a.fixed] -
          { left: 0, "": 1, right: 2 }[b.fixed],
      ),
  );
  watch(
    columns,
    (value) => {
      try {
        localStorage.setItem(columnStorageKey, JSON.stringify(value));
      } catch {}
    },
    { deep: true },
  );
  function moveColumn(target: string) {
    const source = columns.value.findIndex((c) => c.key === dragged.value);
    const destination = columns.value.findIndex((c) => c.key === target);
    if (source < 0 || destination < 0 || source === destination) return;
    const [item] = columns.value.splice(source, 1);
    columns.value.splice(destination, 0, item);
    dragged.value = undefined;
  }
  function setVisible(column: TableColumn, value: boolean) {
    if (!value && columns.value.filter((c) => c.visible).length === 1) {
      ElMessage.info("至少保留一个字段");
      return;
    }
    column.visible = value;
  }
  function resetColumns() {
    columns.value = columnDefaults();
  }
  let loadRevision = 0,
    detailRevision = 0;
  async function load() {
    const revision = ++loadRevision;
    loading.value = true;
    loadError.value = "";
    try {
      const result = await requirementApi.list(filters);
      if (revision !== loadRevision) return;
      list.value = result;
      const last = Math.max(
        1,
        Math.ceil(result.total / (filters.pageSize ?? 20)),
      );
      if ((filters.page ?? 1) > last) {
        filters.page = last;
        await load();
      }
    } catch (e) {
      if (revision === loadRevision) loadError.value = errorMessage(e);
    } finally {
      if (revision === loadRevision) loading.value = false;
    }
  }
  function applyFilters() {
    for (const key of dateFields) {
      const range = dateRanges[key];
      Object.assign(filters, {
        [`${key}From`]: range?.[0] || undefined,
        [`${key}To`]: range?.[1] || undefined,
      });
    }
    filters.page = 1;
    load();
  }
  function clearFilters() {
    for (const key of Object.keys(filters))
      if (!["pageSize", "sortBy", "sortOrder"].includes(key))
        delete (filters as Record<string, unknown>)[key];
    for (const key of dateFields) dateRanges[key] = null;
    filters.page = 1;
    load();
  }
  const dirty = computed(
    () => editing.value && JSON.stringify(form) !== initial.value,
  );
  async function mayDiscard() {
    if (saving.value) return false;
    if (!dirty.value) return true;
    try {
      await ElMessageBox.confirm(
        "行内修改尚未保存，确定放弃吗？",
        "未保存的修改",
        {
          confirmButtonText: "放弃修改",
          cancelButtonText: "继续编辑",
          type: "warning",
        },
      );
      return true;
    } catch {
      return false;
    }
  }
  async function cancel() {
    if (await mayDiscard()) {
      editing.value = false;
      formError.value = "";
    }
  }
  async function create(
    parentId: number | null = null,
    preset?: Partial<RequirementCreateParsed>,
  ) {
    if (editing.value && !(await mayDiscard())) return;
    Object.assign(form, blank(), { name: "", parentId }, preset);
    editingId.value = null;
    editing.value = true;
    initial.value = JSON.stringify(form);
    formError.value = "";
  }
  async function edit(row: Requirement) {
    if (editing.value && !(await mayDiscard())) return;
    const data = requirementCreateSchema.parse(
      Object.fromEntries(
        Object.keys(requirementCreateSchema.shape).map((key) => [
          key,
          row[key as keyof Requirement],
        ]),
      ),
    );
    Object.assign(form, data);
    editingId.value = row.id;
    editing.value = true;
    initial.value = JSON.stringify(form);
    formError.value = "";
  }
  const rows = computed(() => {
    const flattened: Array<
      Requirement & { draft?: boolean; lastChild?: boolean }
    > = [];
    for (const root of list.value.items) {
      // The API returns children for relationship rendering, but the table
      // receives an already flattened list so Element Plus does not render
      // the same children a second time through its tree-data convention.
      const { children: _children, ...rootRow } = root;
      flattened.push(
        rootRow as Requirement & { draft?: boolean; lastChild?: boolean },
      );
      root.children.forEach((child, index) =>
        flattened.push({
          ...child,
          lastChild:
            index === root.children.length - 1 &&
            !(
              editing.value &&
              editingId.value === null &&
              form.parentId === root.id
            ),
        }),
      );
      if (
        editing.value &&
        editingId.value === null &&
        form.parentId === root.id
      )
        flattened.push({
          ...form,
          id: -1,
          requirementNo: "待生成",
          createdAt: "",
          updatedAt: "",
          deletedAt: null,
          draft: true,
          lastChild: true,
        });
    }
    if (
      editing.value &&
      editingId.value === null &&
      !flattened.some((row) => row.draft)
    )
      flattened.push({
        ...form,
        id: -1,
        requirementNo: "待生成",
        createdAt: "",
        updatedAt: "",
        deletedAt: null,
        draft: true,
        lastChild: true,
      });
    return flattened;
  });
  function isEditing(row: Requirement & { draft?: boolean }) {
    return editing.value && (row.draft || row.id === editingId.value);
  }
  const selected = ref<Requirement>(),
    history = ref<StageHistory[]>([]),
    showDrawer = ref(false),
    viewingStage = ref<Stage>("analysis"),
    stageSaving = ref(false);
  async function openDetail(row: Requirement) {
    const revision = ++detailRevision;
    try {
      const [item, records] = await Promise.all([
        requirementApi.get(row.id),
        requirementApi.history(row.id),
      ]);
      if (revision !== detailRevision) return;
      selected.value = item;
      history.value = records;
      viewingStage.value = item.currentStage;
      showDrawer.value = true;
    } catch (e) {
      ElMessage.error(errorMessage(e));
    }
  }
  async function save() {
    if (saving.value) return;
    saving.value = true;
    formError.value = "";
    try {
      const parsed = requirementCreateSchema.parse(form);
      const updated =
        editingId.value === null
          ? await requirementApi.create(parsed)
          : await requirementApi.update(editingId.value, parsed);
      editing.value = false;
      if (selected.value?.id === updated.id) selected.value = updated;
      await load();
      ElMessage.success(`${updated.requirementNo} 已保存`);
    } catch (e) {
      formError.value =
        e instanceof Error && "issues" in e
          ? "请填写有效的需求名称和提出时间"
          : errorMessage(e);
    } finally {
      saving.value = false;
    }
  }
  async function changeStage(stage: Stage) {
    if (!selected.value || stageSaving.value) return;
    stageSaving.value = true;
    const id = selected.value.id;
    const revision = detailRevision;
    try {
      const item = await requirementApi.update(id, { currentStage: stage });
      const records = await requirementApi.history(id);
      if (detailRevision === revision && selected.value?.id === id) {
        selected.value = item;
        history.value = records;
      }
      await load();
      ElMessage.success("当前阶段已更新");
    } catch (e) {
      ElMessage.error(errorMessage(e));
    } finally {
      stageSaving.value = false;
    }
  }
  async function remove(row: Requirement) {
    try {
      await ElMessageBox.confirm(`确定软删除「${row.name}」吗？`, "删除需求", {
        confirmButtonText: "确认删除",
        cancelButtonText: "取消",
        type: "warning",
      });
      await requirementApi.remove(row.id);
      if (selected.value?.id === row.id) showDrawer.value = false;
      await load();
    } catch (e) {
      if (e !== "cancel" && e !== "close") ElMessage.error(errorMessage(e));
    }
  }
  onBeforeRouteLeave(async () => !editing.value || (await mayDiscard()));
  function beforeUnload(event: BeforeUnloadEvent) {
    if (dirty.value) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  onMounted(() => {
    load();
    window.addEventListener("beforeunload", beforeUnload);
  });
  onBeforeUnmount(() =>
    window.removeEventListener("beforeunload", beforeUnload),
  );
  return {
    list,
    loading,
    saving,
    loadError,
    formError,
    filters,
    dateRanges,
    expandedDates,
    form,
    editingId,
    editing,
    columns,
    showColumns,
    dragged,
    visibleColumns,
    moveColumn,
    setVisible,
    resetColumns,
    load,
    applyFilters,
    clearFilters,
    create,
    edit,
    cancel,
    save,
    rows,
    isEditing,
    selected,
    history,
    showDrawer,
    viewingStage,
    stageSaving,
    openDetail,
    changeStage,
    remove,
  };
}
