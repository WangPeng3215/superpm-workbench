import {
  computed,
  onMounted,
  onActivated,
  onBeforeUnmount,
  reactive,
  ref,
  watch,
} from "vue";
import { onBeforeRouteLeave, useRoute } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  dateFields,
  requirementCreateSchema,
  type Requirement,
  type RequirementCreateParsed,
  type RequirementListQuery,
  type RequirementListResult,
  type RequirementUpdate,
  type Stage,
  type StageHistory,
} from "@superpm/shared";
import { requirementApi } from "../../api/requirements";
import { projectApi } from "../../api/projects";
import { ApiError, errorMessage } from "../../api/client";
import { authStore } from "../../stores/auth";
import { registerEditingSession } from "../../stores/editing-sessions";
import {
  scopedRequirementQuery,
  canManageRequirement,
  projectEditingCheck,
} from "./scope";
import {
  readTableDraft,
  stageReasonRequired,
  tableDraftKey,
} from "./table-draft";
import {
  createVersionedAutoSave,
  type VersionedSaveState,
} from "../editing/versioned-autosave";
import type { AutoSave } from "../meetings/autosave";
import {
  columnDefaults,
  restoreColumns,
  columnStorageKey,
  type TableColumn,
} from "./table-config";
export function useEditableTable(
  scope: { projectId?: number; readOnly?: () => boolean } = {},
) {
  const path = useRoute().path;
  const accountId = authStore.user?.id;
  const storageKey = accountId
    ? tableDraftKey(accountId, scope.projectId)
    : undefined;
  const storageError = ref("");
  let rowVersion = 1,
    savedStage: Stage = "analysis",
    stageNote = "";
  let recoveredConflict = false,
    restoreAttempted = false,
    restoring = false,
    disposed = false;
  let permissionBlocked = false;
  let permissionTimer: ReturnType<typeof setInterval> | undefined;
  let unregisterSession: (() => void) | undefined;
  const list = ref<RequirementListResult>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    matchedCount: 0,
  });
  const loading = ref(false),
    saving = ref(false),
    pinning = ref<number>(),
    loadError = ref(""),
    formError = ref("");
  const projectCapabilities = ref<Record<number, boolean>>({});
  const canEditRow = (row: Requirement) =>
    canManageRequirement(
      row.projectId,
      projectCapabilities.value,
      scope.readOnly?.(),
    );
  async function confirmProjectEdit(
    projectId: number | null | undefined,
    clearInvalidDraft = false,
  ) {
    if (scope.readOnly?.()) return false;
    if (!projectId) return true;
    try {
      const response = await projectApi.get(projectId);
      projectCapabilities.value[projectId] =
        response.capabilities.canManageRequirements;
      if (
        !response.capabilities.canManageRequirements &&
        editing.value &&
        form.projectId === projectId
      )
        invalidate();
      if (clearInvalidDraft && !response.capabilities.canManageRequirements)
        clearDraft();
      if (response.capabilities.canManageRequirements && permissionBlocked) {
        permissionBlocked = false;
        formError.value = "";
        if (editing.value && !recoveredConflict && dirty.value)
          autoSave?.schedule();
      }
      return response.capabilities.canManageRequirements;
    } catch (e) {
      projectCapabilities.value[projectId] = false;
      if (editing.value && form.projectId === projectId) pauseProjectEditing(e);
      if (
        e instanceof ApiError &&
        [403, 404].includes(e.status) &&
        form.projectId === projectId
      )
        invalidate();
      if (
        clearInvalidDraft &&
        e instanceof ApiError &&
        [403, 404].includes(e.status)
      )
        clearDraft();
      ElMessage.error(errorMessage(e));
      return false;
    }
  }
  const saveState = ref<VersionedSaveState>("idle");
  function pauseProjectEditing(error: unknown) {
    permissionBlocked = true;
    autoSave?.cancel();
    saveState.value =
      error instanceof ApiError && error.status === 401
        ? "unauthorized"
        : "error";
    formError.value = "无法确认项目编辑权限，自动保存已暂停，本地草稿已保留。";
  }
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
  let autoSave:
    | (Pick<AutoSave, "schedule" | "flush" | "retry" | "dispose"> & {
        cancel: () => void;
      })
    | undefined;
  const blank = (): RequirementCreateParsed =>
    requirementCreateSchema.parse({
      name: "临时名称",
      proposedAt: new Date().toLocaleDateString("sv-SE"),
    });
  const form = reactive<RequirementCreateParsed>({ ...blank(), name: "" });
  function clearDraft() {
    if (!storageKey) return;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {}
  }
  function persistDraft() {
    if (!storageKey || restoring || !editing.value) return;
    try {
      if (dirty.value)
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            requirementId: editingId.value,
            version: editingId.value === null ? null : rowVersion,
            values: { ...form },
            ...(stageNote ? { stageNote } : {}),
          }),
        );
      else clearDraft();
    } catch {
      storageError.value =
        "浏览器无法保存会话草稿，请勿刷新页面，并确认修改已保存到服务。";
    }
  }
  async function updateField(key: string, value: unknown) {
    if (
      key === "currentStage" &&
      editingId.value !== null &&
      stageReasonRequired(savedStage, value as Stage)
    ) {
      try {
        const result = await ElMessageBox.prompt(
          "跳阶段或回退阶段需要说明原因。",
          "阶段变更原因",
          {
            inputType: "textarea",
            inputValue: stageNote,
            inputValidator: (text: string) =>
              !!text?.trim() || "请填写阶段变更原因",
            confirmButtonText: "确认变更",
            cancelButtonText: "取消",
          },
        );
        if (!editing.value || disposed) return;
        stageNote = result.value.trim();
      } catch {
        return;
      }
    } else if (key === "currentStage") stageNote = "";
    Object.assign(form, { [key]: value });
  }
  const columns = ref(restoreColumns()),
    showColumns = ref(false),
    dragged = ref<string>();
  const visibleColumns = computed(() =>
    columns.value
      .filter((c) => c.visible || (editing.value && c.key === "name"))
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
      const result = await requirementApi.list(
        scopedRequirementQuery(filters, scope.projectId),
      );
      const projectIds = [
        ...new Set(
          result.items
            .map((row) => row.projectId)
            .filter((id): id is number => id !== null),
        ),
      ];
      const denied = new Set<number>();
      const readOnly = new Set<number>();
      await Promise.all(
        projectIds.map(async (projectId) => {
          try {
            const capability = (await projectApi.get(projectId)).capabilities
              .canManageRequirements;
            projectCapabilities.value[projectId] = capability;
            if (projectEditingCheck(capability).discardDraft)
              readOnly.add(projectId);
          } catch (error) {
            projectCapabilities.value[projectId] = false;
            if (
              projectEditingCheck(
                undefined,
                error instanceof ApiError ? error : {},
              ).discardDraft
            )
              denied.add(projectId);
            else if (editing.value && form.projectId === projectId)
              pauseProjectEditing(error);
          }
        }),
      );
      if (revision !== loadRevision) return;
      result.items = result.items.filter(
        (row) => !row.projectId || !denied.has(row.projectId),
      );
      if (
        editing.value &&
        form.projectId &&
        (denied.has(form.projectId) || readOnly.has(form.projectId))
      )
        invalidate();
      list.value = result;
      const last = Math.max(
        1,
        Math.ceil(result.total / (filters.pageSize ?? 20)),
      );
      if ((filters.page ?? 1) > last) {
        filters.page = last;
        await load();
      }
      if (!restoreAttempted) await restoreDraft();
    } catch (e) {
      if (e instanceof ApiError && [403, 404].includes(e.status)) {
        stopEditing();
        list.value.items = [];
      }
      if (revision === loadRevision) loadError.value = errorMessage(e);
    } finally {
      if (revision === loadRevision) loading.value = false;
    }
  }
  async function applyFilters() {
    if (!(await finishEditing())) return;
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
  async function clearFilters() {
    if (!(await finishEditing())) return;
    for (const key of Object.keys(filters))
      if (!["pageSize", "sortBy", "sortOrder"].includes(key))
        delete (filters as Record<string, unknown>)[key];
    for (const key of dateFields) dateRanges[key] = null;
    filters.page = 1;
    load();
  }
  const dirty = computed(
    () =>
      editing.value &&
      JSON.stringify(
        editingId.value === null ? form : { ...form, name: form.name.trim() },
      ) !== initial.value,
  );
  let applyingSave = false;
  watch(
    form,
    () => {
      if (!applyingSave && !restoring) {
        persistDraft();
        if (!recoveredConflict && !permissionBlocked) autoSave?.schedule();
      }
    },
    { flush: "sync" },
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
    if (await mayDiscard()) stopEditing();
  }
  function stopEditing(removeDraft = true) {
    autoSave?.dispose();
    autoSave = undefined;
    editing.value = false;
    editingId.value = null;
    formError.value = "";
    saveState.value = "idle";
    recoveredConflict = false;
    permissionBlocked = false;
    stageNote = "";
    if (removeDraft) clearDraft();
  }
  function invalidate() {
    detailRevision++;
    if (form.projectId)
      list.value.items = list.value.items.filter(
        (row) => row.projectId !== form.projectId,
      );
    stopEditing();
    Object.assign(form, blank(), { name: "" });
    selected.value = undefined;
    showDrawer.value = false;
    loadError.value = "编辑权限已失效，已清理本页草稿，请重新读取。";
  }
  async function finishEditing() {
    if (!editing.value) return true;
    if (recoveredConflict) return false;
    if (form.projectId && !(await confirmProjectEdit(form.projectId)))
      return false;
    const current = autoSave;
    if (current) {
      if (!(await current.flush()) || autoSave !== current) return false;
    } else if (!(await mayDiscard())) return false;
    stopEditing();
    return true;
  }
  async function create(
    parentId: number | null = null,
    preset?: Partial<RequirementCreateParsed>,
  ) {
    const projectId =
      scope.projectId ??
      (parentId
        ? list.value.items.find((root) => root.id === parentId)?.projectId
        : filters.projectId) ??
      null;
    if (!(await confirmProjectEdit(projectId))) return;
    if (!(await finishEditing())) return;
    Object.assign(
      form,
      blank(),
      {
        name: "",
        parentId,
        projectId:
          scope.projectId ??
          (parentId
            ? list.value.items.find((root) => root.id === parentId)?.projectId
            : filters.projectId) ??
          null,
      },
      preset,
    );
    editingId.value = null;
    editing.value = true;
    initial.value = JSON.stringify(form);
    formError.value = "";
    persistDraft();
  }
  async function edit(row: Requirement) {
    if (!(await confirmProjectEdit(row.projectId))) return;
    if (isEditing(row) || !(await finishEditing())) return;
    let saved = requirementCreateSchema.parse(
      Object.fromEntries(
        Object.keys(requirementCreateSchema.shape).map((key) => [
          key,
          row[key as keyof Requirement],
        ]),
      ),
    );
    Object.assign(form, saved);
    editingId.value = row.id;
    editing.value = true;
    rowVersion = row.version;
    savedStage = row.currentStage;
    recoveredConflict = false;
    stageNote = "";
    initial.value = JSON.stringify(form);
    formError.value = "";
    autoSave = createVersionedAutoSave({
      initial: row,
      snapshot() {
        if (permissionBlocked) return null;
        const result = requirementCreateSchema.safeParse(form);
        return result.success ? { ...form } : null;
      },
      async persist(changes, expectedVersion) {
        const { projectId: _projectId, ...patch } = changes;
        if (Object.keys(patch).length) {
          const updated = await requirementApi.update(row.id, {
            ...patch,
            ...(patch.currentStage &&
            stageReasonRequired(savedStage, patch.currentStage)
              ? { stageNote }
              : {}),
            expectedVersion,
          });
          return updated;
        }
        return row;
      },
      apply(updated, snapshot) {
        rowVersion = updated.version;
        savedStage = updated.currentStage;
        syncSavedRow(updated);
        const savedFields = Object.fromEntries(
          Object.keys(requirementCreateSchema.shape).map((key) => [
            key,
            updated[key as keyof Requirement],
          ]),
        ) as RequirementCreateParsed;
        applyingSave = true;
        for (const key of Object.keys(
          snapshot,
        ) as (keyof RequirementCreateParsed)[])
          if (form[key] === snapshot[key])
            Object.assign(form, { [key]: savedFields[key] });
        applyingSave = false;
        initial.value = JSON.stringify(savedFields);
        formError.value = "";
        persistDraft();
      },
      onStateChange(state) {
        saveState.value = state;
        if (state === "blocked")
          formError.value = "请填写有效的需求名称和提出时间";
      },
      onError(error) {
        if (error instanceof ApiError && error.status === 409)
          recoveredConflict = true;
        formError.value =
          error instanceof ApiError && error.status === 409
            ? "内容已被其他成员修改。本地草稿已保留，请复制需要的内容后放弃修改并重新读取。"
            : errorMessage(error);
        if (error instanceof ApiError && [403, 404].includes(error.status)) {
          invalidate();
          list.value.items = [];
          loadError.value = "访问权限已失效，请重新进入项目。";
        }
      },
    });
  }
  async function restoreDraft() {
    restoreAttempted = true;
    if (!storageKey || editing.value || disposed) return;
    let stored;
    try {
      stored = readTableDraft(
        sessionStorage.getItem(storageKey),
        scope.projectId,
      );
    } catch {
      storageError.value = "浏览器无法读取会话草稿，请确认修改已保存到服务。";
      return;
    }
    if (!stored) return;
    const { requirementId, values, version } = stored;
    if (!(await confirmProjectEdit(values.projectId, true))) return;
    try {
      const current =
        requirementId === null ? null : await requirementApi.get(requirementId);
      if (disposed) return;
      if (current && current.projectId !== values.projectId) {
        clearDraft();
        return;
      }
      restoring = true;
      if (current) {
        const visible = list.value.items.some(
          (root) =>
            root.id === current.id ||
            root.children.some((child) => child.id === current.id),
        );
        if (!visible) {
          filters.q = current.requirementNo;
          filters.page = 1;
          await load();
        }
        await edit(current);
      } else await create(values.parentId, { projectId: values.projectId });
      if (!editing.value || disposed) return;
      Object.assign(form, values);
      stageNote = stored.stageNote ?? "";
      if (current && current.version !== version) {
        rowVersion = version!;
        recoveredConflict = true;
        saveState.value = "conflict";
        formError.value =
          "服务器内容已有更新。本地会话草稿已恢复，请复制需要的内容后放弃修改并重新读取。";
      }
    } catch (error) {
      if (error instanceof ApiError && [403, 404].includes(error.status))
        clearDraft();
      else loadError.value = errorMessage(error);
    } finally {
      restoring = false;
      persistDraft();
      if (
        editing.value &&
        editingId.value !== null &&
        !recoveredConflict &&
        dirty.value
      )
        autoSave?.schedule();
    }
  }
  function syncSavedRow(updated: Requirement) {
    for (const root of list.value.items) {
      const target =
        root.id === updated.id
          ? root
          : root.children.find((child) => child.id === updated.id);
      if (target) {
        Object.assign(target, updated);
        break;
      }
    }
    if (selected.value?.id === updated.id) selected.value = updated;
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
          version: 1,
          requirementNo: "待生成",
          pinned: false,
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
      flattened.unshift({
        ...form,
        id: -1,
        version: 1,
        requirementNo: "待生成",
        pinned: false,
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
    if (autoSave) {
      if (await finishEditing()) await load();
      return;
    }
    if (!editing.value || saving.value) return;
    saving.value = true;
    formError.value = "";
    try {
      const parsed = requirementCreateSchema.parse(form);
      const updated = await requirementApi.create(parsed);
      stopEditing();
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
  async function retrySave() {
    if (!(await confirmProjectEdit(form.projectId))) return;
    await autoSave?.retry();
  }
  async function setPinned(row: Requirement) {
    if (
      pinning.value !== undefined ||
      !(await finishEditing()) ||
      pinning.value !== undefined
    )
      return;
    pinning.value = row.id;
    try {
      const updated = await requirementApi.update(row.id, {
        pinned: !row.pinned,
        expectedVersion: row.version,
      });
      syncSavedRow(updated);
      if (!row.parentId && updated.pinned) filters.page = 1;
      await load();
    } catch (error) {
      ElMessage.error(errorMessage(error));
    } finally {
      pinning.value = undefined;
    }
  }
  async function changeStage(stage: Stage) {
    if (!selected.value || stageSaving.value) return;
    let reason: string | undefined;
    if (stageReasonRequired(selected.value.currentStage, stage)) {
      try {
        const result = await ElMessageBox.prompt(
          "跳阶段或回退阶段需要说明原因。",
          "阶段变更原因",
          {
            inputType: "textarea",
            inputValidator: (text: string) =>
              !!text?.trim() || "请填写阶段变更原因",
            confirmButtonText: "确认变更",
            cancelButtonText: "取消",
          },
        );
        reason = result.value.trim();
      } catch {
        return;
      }
    }
    stageSaving.value = true;
    const id = selected.value.id;
    const revision = detailRevision;
    try {
      const item = await requirementApi.update(id, {
        currentStage: stage,
        ...(reason ? { stageNote: reason } : {}),
        expectedVersion: selected.value.version,
      });
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
    if (!(await confirmProjectEdit(row.projectId))) return;
    if (!(await finishEditing())) return;
    try {
      await ElMessageBox.confirm(`确定软删除「${row.name}」吗？`, "删除需求", {
        confirmButtonText: "确认删除",
        cancelButtonText: "取消",
        type: "warning",
      });
      await requirementApi.remove(row.id, row.version);
      if (selected.value?.id === row.id) showDrawer.value = false;
      await load();
    } catch (e) {
      if (e !== "cancel" && e !== "close") ElMessage.error(errorMessage(e));
    }
  }
  onBeforeRouteLeave(finishEditing);
  let revalidating = false;
  async function revalidate() {
    if (disposed || document.hidden || revalidating) return;
    revalidating = true;
    try {
      if (editing.value && !(await confirmProjectEdit(form.projectId))) return;
      if (editing.value && editingId.value !== null) {
        const currentId = editingId.value;
        const current = await requirementApi.get(currentId);
        if (
          disposed ||
          editingId.value !== currentId ||
          saveState.value === "saving"
        )
          return;
        if (current.version !== rowVersion && !recoveredConflict) {
          if (dirty.value) {
            autoSave?.cancel();
            recoveredConflict = true;
            saveState.value = "conflict";
            formError.value =
              "服务器内容已有更新。本地草稿已保留，请复制需要的内容后放弃修改并重新读取。";
          } else {
            stopEditing(false);
            await edit(current);
          }
        }
      }
      await load();
    } catch (error) {
      if (error instanceof ApiError && [403, 404].includes(error.status))
        invalidate();
      else loadError.value = errorMessage(error);
    } finally {
      revalidating = false;
    }
  }
  function onVisible() {
    if (!document.hidden) void revalidate();
  }
  watch(
    () => scope.readOnly?.(),
    (value) => {
      if (value && editing.value) invalidate();
    },
  );
  function beforeUnload(event: BeforeUnloadEvent) {
    if (dirty.value || saving.value || saveState.value === "saving") {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  onMounted(() => {
    load();
    if (!scope.projectId)
      unregisterSession = registerEditingSession(path, {
        flush: finishEditing,
        dispose: () => stopEditing(),
        invalidate,
        get projectId() {
          return form.projectId;
        },
      });
    permissionTimer = setInterval(() => void revalidate(), 30_000);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", onVisible);
  });
  let initiallyActivated = false;
  onActivated(() => {
    if (initiallyActivated) void revalidate();
    initiallyActivated = true;
  });
  onBeforeUnmount(() => {
    persistDraft();
    disposed = true;
    loadRevision++;
    detailRevision++;
    autoSave?.dispose();
    unregisterSession?.();
    if (permissionTimer) clearInterval(permissionTimer);
    window.removeEventListener("beforeunload", beforeUnload);
    document.removeEventListener("visibilitychange", onVisible);
  });
  return {
    list,
    loading,
    saving,
    saveState,
    pinning,
    loadError,
    formError,
    storageError,
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
    retrySave,
    finishEditing,
    setPinned,
    rows,
    isEditing,
    canEditRow,
    updateField,
    invalidate,
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
