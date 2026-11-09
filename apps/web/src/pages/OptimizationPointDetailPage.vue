<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  SwapOutlined,
} from "@ant-design/icons-vue";
import {
  optimizationPointStatusLabels,
  type OptimizationPoint,
  type OptimizationPointConvert,
  type OptimizationPointUpdate,
} from "@superpm/shared";
import { optimizationPointApi } from "../api/optimization-points";
import { errorMessage } from "../api/client";
import { decorative } from "../components/decorativeIcon";
import { removeTab, setTabLabel } from "../stores/tabs";
import OptimizationPointForm from "../features/optimization-points/OptimizationPointForm.vue";
import ConvertToRequirementDialog from "../features/optimization-points/ConvertToRequirementDialog.vue";
import {
  formatPointDate,
  optimizationStatusTone,
} from "../features/optimization-points/format";

const BackIcon = decorative(ArrowLeftOutlined);
const DeleteIcon = decorative(DeleteOutlined);
const ConvertIcon = decorative(SwapOutlined);

const route = useRoute();
const router = useRouter();
const id = ref(Number(route.params.id));
const point = ref<OptimizationPoint>();
const loading = ref(false);
const loadError = ref("");
const saving = ref(false);
const saveError = ref("");
const dirty = ref(false);
const deleting = ref(false);
const converting = ref(false);
const convertVisible = ref(false);
const form = ref<InstanceType<typeof OptimizationPointForm>>();
let revision = 0;

// 已转换且关联有效时不能再转；关联需求被删除后可重新转换
const convertBlocked = computed(
  () => point.value?.status === "converted" && Boolean(point.value.requirement),
);
const convertHint = computed(() =>
  dirty.value
    ? "请先保存当前修改再转换"
    : "按现有建需流程生成正式需求，内容整段作为需求详情",
);
// 关联需求仍存在时的跳转入口；需求被删除后 requirement.exists 为 false
const linkedRequirement = computed(() => {
  const requirement = point.value?.requirement;
  return requirement?.exists ? requirement : null;
});

async function load() {
  if (!Number.isInteger(id.value) || id.value <= 0) {
    loadError.value = "优化点 ID 无效";
    return;
  }
  const token = ++revision;
  loading.value = true;
  loadError.value = "";
  try {
    const detail = await optimizationPointApi.get(id.value);
    if (token !== revision) return;
    point.value = detail;
    dirty.value = false;
    setTabLabel(route.path, detail.name);
    // 列表操作列的「转为正式需求」带着 ?convert=1 进来：加载完直接打开确认弹窗，
    // 随后清掉 query，避免刷新或返回时重复弹出
    if (route.query.convert === "1") {
      void router.replace({ path: route.path, query: {} });
      if (!convertBlocked.value) convertVisible.value = true;
    }
  } catch (error) {
    if (token === revision) loadError.value = errorMessage(error);
  } finally {
    if (token === revision) loading.value = false;
  }
}

watch(id, load, { immediate: true });
// 同一组件在不同优化点之间跳转时实例会被复用，需要跟随路由参数重新加载
watch(
  () => route.params.id,
  (value) => {
    const next = Number(value);
    if (next !== id.value) id.value = next;
  },
);

function onFormChange() {
  dirty.value = true;
  saveError.value = "";
}

async function save() {
  if (!point.value || saving.value) return;
  const payload = form.value?.validate();
  if (!payload) return;
  saving.value = true;
  saveError.value = "";
  try {
    const updated = await optimizationPointApi.update(
      point.value.id,
      payload as OptimizationPointUpdate,
    );
    point.value = updated;
    dirty.value = false;
    setTabLabel(route.path, updated.name);
    ElMessage.success("优化点已保存");
  } catch (error) {
    saveError.value = errorMessage(error);
  } finally {
    saving.value = false;
  }
}

/** 离开前提示未保存改动，避免静默丢失 */
async function confirmLeave() {
  if (!dirty.value) return true;
  try {
    await ElMessageBox.confirm(
      "当前优化点有未保存的修改，离开后会丢失。仍要离开吗？",
      "内容未保存",
      {
        type: "warning",
        confirmButtonText: "仍要离开",
        cancelButtonText: "继续编辑",
      },
    );
    return true;
  } catch {
    return false;
  }
}

onBeforeRouteLeave(() => confirmLeave());
onBeforeRouteUpdate(() => confirmLeave());

async function back() {
  if (!(await confirmLeave())) return;
  dirty.value = false;
  await router.push("/optimization-points");
}

async function openRequirement(requirementId: number) {
  if (!(await confirmLeave())) return;
  dirty.value = false;
  await router.push(`/requirements/${requirementId}`);
}

async function removePoint() {
  if (!point.value || deleting.value) return;
  try {
    await ElMessageBox.confirm(
      "删除后该优化点记录将不可恢复；已转换生成的正式需求不受影响。",
      "删除优化点",
      {
        type: "warning",
        confirmButtonText: "删除",
        cancelButtonText: "取消",
        confirmButtonClass: "el-button--danger",
      },
    );
  } catch {
    return;
  }
  deleting.value = true;
  try {
    await optimizationPointApi.remove(point.value.id);
    ElMessage.success("优化点已删除");
    dirty.value = false;
    removeTab(route.path);
    await router.push("/optimization-points");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    deleting.value = false;
  }
}

async function convert(payload: OptimizationPointConvert) {
  if (!point.value || converting.value) return;
  converting.value = true;
  try {
    const result = await optimizationPointApi.convert(point.value.id, payload);
    point.value = result.point;
    dirty.value = false;
    convertVisible.value = false;
    setTabLabel(route.path, result.point.name);
    if (result.requirement.workspaceReady)
      ElMessage.success(
        `已生成正式需求 ${result.requirement.requirementNo}，需求文件夹与标准目录已初始化`,
      );
    else
      ElMessage.warning(
        `已生成正式需求 ${result.requirement.requirementNo}，但需求文件夹初始化失败，可在需求详情中重试`,
      );
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    converting.value = false;
  }
}
</script>

<template>
  <div class="point-detail" v-loading="loading">
    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
      class="load-error"
    />
    <template v-if="point">
      <section class="surface detail-head">
        <div class="head-row">
          <button
            type="button"
            class="back-button"
            title="返回优化点列表"
            aria-label="返回优化点列表"
            @click="back"
          >
            <el-icon aria-hidden="true"><component :is="BackIcon" /></el-icon>
          </button>
          <div class="head-identity">
            <el-tag
              size="small"
              class="enum-tag"
              :class="optimizationStatusTone[point.status]"
            >
              {{ optimizationPointStatusLabels[point.status] }}
            </el-tag>
            <h1 class="head-title" :title="point.name">{{ point.name }}</h1>
            <span v-if="dirty" class="dirty-flag">未保存</span>
          </div>
          <div class="head-actions">
            <el-button
              v-if="!convertBlocked"
              size="small"
              :icon="ConvertIcon"
              :loading="converting"
              :disabled="converting || dirty"
              :title="convertHint"
              @click="convertVisible = true"
            >
              转为正式需求
            </el-button>
            <el-button
              type="primary"
              size="small"
              :loading="saving"
              :disabled="!dirty || saving"
              @click="save"
            >
              保存
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              :icon="DeleteIcon"
              :loading="deleting"
              @click="removePoint"
            >
              删除
            </el-button>
          </div>
        </div>
      </section>

      <section class="surface edit-surface">
        <OptimizationPointForm
          ref="form"
          :key="`${point.id}-${point.updatedAt}`"
          :point="point"
          show-status
          fill
          :disabled="saving"
          @change="onFormChange"
        >
          <template #side>
            <section class="side-section">
              <h2>记录信息</h2>
              <div class="meta-row">
                <span class="meta-label">发现</span>
                <span class="meta-value">
                  {{ formatPointDate(point.createdAt, true) }}
                </span>
              </div>
              <div class="meta-row">
                <span class="meta-label">更新</span>
                <span class="meta-value">
                  {{ formatPointDate(point.updatedAt, true) }}
                </span>
              </div>
              <div class="meta-row">
                <span class="meta-label">来源</span>
                <span class="meta-value">手动记录</span>
              </div>
            </section>

            <section class="side-section">
              <h2>正式需求</h2>
              <template v-if="linkedRequirement">
                <button
                  type="button"
                  class="requirement-row"
                  :title="`${linkedRequirement.requirementNo} ${linkedRequirement.name}`"
                  @click="openRequirement(linkedRequirement.id)"
                >
                  <span class="chip-no">{{
                    linkedRequirement.requirementNo
                  }}</span>
                  <span class="chip-name">{{ linkedRequirement.name }}</span>
                </button>
                <p class="side-hint">
                  已转换的优化点保留原始记录，不随需求后续修改而改变。
                </p>
              </template>
              <template v-else>
                <p v-if="point.status === 'converted'" class="side-warning">
                  关联的正式需求已被删除，优化点内容保留，可重新转为正式需求。
                </p>
                <p v-else class="muted empty-text">尚未转换。</p>
                <p v-if="point.status !== 'converted'" class="side-hint">
                  评估通过后在页头点「转为正式需求」，按现有建需流程生成正式需求。
                </p>
              </template>
            </section>
          </template>
        </OptimizationPointForm>
        <el-alert
          v-if="saveError"
          :title="saveError"
          type="error"
          :closable="false"
          show-icon
          class="save-error"
        />
      </section>

      <ConvertToRequirementDialog
        v-model="convertVisible"
        :point="point"
        :loading="converting"
        @confirm="convert"
      />
    </template>
  </div>
</template>

<style scoped>
.point-detail {
  /* 视口限高：页头固定，正文区消化溢出（与会议详情一致） */
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  height: calc(100dvh - var(--app-header-h) - 40px);
  min-height: 0;
  margin: 0 auto;
}
.load-error {
  flex: none;
  margin-bottom: 0;
}
.detail-head {
  flex: none;
  padding: 8px 18px;
}
.head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.back-button {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border-base);
  border-radius: 7px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    color var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard),
    background var(--duration-fast) var(--ease-standard);
}
.back-button:hover {
  border-color: var(--border-brand);
  background: var(--bg-brand-soft);
  color: var(--brand);
}
.head-identity {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
}
.head-title {
  margin: 0;
  overflow: hidden;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.2px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dirty-flag {
  flex: none;
  padding: 1px 7px;
  border-radius: 99px;
  background: var(--tone-amber-bg);
  color: var(--tone-amber-fg);
  font-size: 11px;
}
.head-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}
.head-actions :deep(.el-button) {
  margin: 0;
}
/* 编辑区铺满剩余高度：表单内部左编辑器右属性各自消化溢出 */
.edit-surface {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  padding: 14px 18px;
  overflow: hidden;
}
.save-error {
  position: absolute;
  top: 8px;
  right: 18px;
  left: 18px;
  z-index: 2;
}
/* 插槽卡片由详情页渲染，样式随父组件作用域（表单的 scoped 样式不会穿透插槽） */
.side-section {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.side-section h2 {
  margin: 0;
  color: var(--text-heading);
  font-size: 12px;
  font-weight: 600;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  font-size: 12px;
}
.meta-label {
  flex: none;
  width: 32px;
  color: var(--text-faint);
  font-size: 11px;
}
.meta-value {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.requirement-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  background: var(--bg-subtle);
  color: var(--text-regular);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--duration-fast) var(--ease-standard),
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}
.requirement-row:hover {
  border-color: var(--border-brand);
  background: var(--bg-brand-soft);
  color: var(--brand);
}
.chip-no {
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-text {
  margin: 0 0 10px;
}
.side-hint {
  margin: 8px 0 0;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
}
.side-warning {
  margin: 0 0 10px;
  color: var(--warning-text);
  font-size: 11px;
  line-height: 1.6;
}
@media (max-width: 980px) {
  .point-detail {
    height: auto;
  }
  .edit-surface {
    overflow: visible;
    padding: 14px 12px;
  }
  .save-error {
    position: static;
    margin-bottom: 10px;
  }
}
@media (max-width: 700px) {
  .detail-head {
    padding-inline: 12px;
  }
  .head-row {
    flex-wrap: wrap;
  }
  .head-identity {
    flex-basis: calc(100% - 38px);
  }
  .head-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
