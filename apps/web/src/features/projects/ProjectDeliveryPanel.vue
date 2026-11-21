<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  projectStatusLabels,
  type AcceptanceRound,
  type Delivery,
  type ProjectDetail,
  type Requirement,
} from "@superpm/shared";
import { ElMessage, ElMessageBox } from "element-plus";
import { deliveryApi } from "../../api/deliveries";
import { projectApi } from "../../api/projects";
import { issueApi } from "../../api/issues";
import { requirementApi } from "../../api/requirements";
import { ApiError, errorMessage } from "../../api/client";
import { authStore } from "../../stores/auth";
import { buildScopeChangeDrafts, isAcceptanceResultSetComplete, type ScopeChangeDraft } from "./project-delivery-acceptance";

const props = defineProps<{
  projectId: number;
  detail: ProjectDetail;
  beforeAction: () => Promise<boolean>;
}>();
const emit = defineEmits<{ updated: [detail: ProjectDetail]; denied: [] }>();
const deliveries = ref<Delivery[]>([]),
  requirements = ref<Requirement[]>([]),
  rounds = ref<AcceptanceRound[]>([]);
const selectedId = ref<number>(),
  loading = ref(false),
  busy = ref(false),
  error = ref(""),
  createOpen = ref(false),
  scopeOpen = ref(false),
  submitOpen = ref(false);
const createForm = ref({ name: "", plannedDeliveryDate: null as string | null, acceptanceOwnerUserId: null as number | null, description: "" });
const scopeIds = ref<number[]>([]),
  scopeReason = ref(""),
  scopeChangeDrafts = ref<Record<number, ScopeChangeDraft>>({}),
  deliveryNotes = ref(""),
  evidenceText = ref(""),
  evidenceFileId = ref<number>();
const customerName = ref(""),
  customerRole = ref(""),
  customerConfirmedAt = ref(""),
  customerEvidence = ref("");
const results = ref<Record<number, { result: "passed" | "failed"; reason: string; issueId: number | null }>>({});
const issueOptions = ref<Record<number, Array<{ id: number; title: string }>>>({});
const availableIssues = ref<Array<{ id: number; title: string }>>([]);
const blockers = ref<Awaited<ReturnType<typeof deliveryApi.blockingIssues>>>([]);
const blockerIssueId = ref<number>();
const blockerImpact = ref("");
const selected = computed(() => deliveries.value.find((item) => item.id === selectedId.value));
const canPrepare = computed(() => props.detail.capabilities.canPrepareDelivery);
const canConfirmScope = computed(() => props.detail.capabilities.canConfirmScope);
const isProjectOwner = computed(() => props.detail.members.some((member) => member.userId === authStore.user?.id && member.status === "active" && member.roles.includes("owner")));
const canMarkBlocker = computed(() => props.detail.members.some((member) => member.userId === authStore.user?.id && member.status === "active" && member.roles.some((role) => role === "owner" || role === "product_owner")));
const isAcceptanceOwner = computed(() => selected.value?.acceptanceOwnerUserId === authStore.user?.id);
const activeMembers = computed(() => props.detail.members.filter((member) => member.status === "active" && member.accountStatus === "active" && member.roles.some((role) => role !== "viewer")));
const memberNames = computed(() => new Map(props.detail.members.map((member) => [member.userId, member.displayName])));
const pendingRound = computed(() => rounds.value.find((round) => round.status === "pending"));
const customerConfirmationStarted = computed(() => Boolean(customerName.value.trim() || customerRole.value.trim() || customerConfirmedAt.value || customerEvidence.value.trim()));
const customerConfirmationComplete = computed(() => !customerConfirmationStarted.value || Boolean(customerName.value.trim() && customerRole.value.trim() && customerConfirmedAt.value && customerEvidence.value.trim()));
const acceptanceResultsComplete = computed(() =>
  pendingRound.value
    ? isAcceptanceResultSetComplete(
        pendingRound.value.items.map((item) => item.scopeItemId),
        results.value,
      )
    : false,
);
const selectedRequirements = computed(() => requirements.value.filter((requirement) => scopeIds.value.includes(requirement.id)));
const removedRequirements = computed(() => selected.value?.scopeVersion?.items.filter((item) => !scopeIds.value.includes(item.requirementId)) ?? []);
const followUpDeliveries = computed(() => deliveries.value.filter((delivery) => delivery.id !== selected.value?.id && delivery.status !== "cancelled"));
const visibleFiles = ref<Array<{ id: number; requirementId: number; label: string }>>([]);
let revision = 0;
watch(removedRequirements, (items) => {
  const removedIds = new Set(items.map((item) => item.requirementId));
  for (const key of Object.keys(scopeChangeDrafts.value)) {
    if (!removedIds.has(Number(key))) delete scopeChangeDrafts.value[Number(key)];
  }
  for (const item of items) {
    scopeChangeDrafts.value[item.requirementId] ??= {
      type: "",
      reason: "",
      followUpDeliveryId: null,
      followUpOwnerUserId: null,
      followUpDate: null,
    };
  }
}, { immediate: true, flush: "sync" });

function report(e: unknown) {
  error.value = errorMessage(e);
  if (e instanceof ApiError && [403, 404].includes(e.status)) emit("denied");
}
async function load() {
  const token = ++revision;
  loading.value = true;
  error.value = "";
  try {
    const [deliveryResult, requirementResult] = await Promise.all([
      deliveryApi.list(props.projectId),
      requirementApi.list({ projectId: props.projectId, page: 1, pageSize: 100, sortBy: "requirementNo", sortOrder: "asc" }),
    ]);
    if (token !== revision) return;
    const allRoots = [...requirementResult.items];
    for (let page = 2; (page - 1) * requirementResult.pageSize < requirementResult.total; page++) {
      const nextPage = await requirementApi.list({ projectId: props.projectId, page, pageSize: requirementResult.pageSize, sortBy: "requirementNo", sortOrder: "asc" });
      if (token !== revision) return;
      allRoots.push(...nextPage.items);
    }
    deliveries.value = deliveryResult.items;
    requirements.value = allRoots.flatMap((item) => item.children?.length ? item.children : [item]);
    if (!deliveries.value.some((item) => item.id === selectedId.value))
      selectedId.value = deliveries.value[0]?.id;
    await loadSelected(token);
  } catch (e) {
    if (token === revision) report(e);
  } finally {
    if (token === revision) loading.value = false;
  }
}
async function loadSelected(token = revision) {
  const delivery = selected.value;
  if (!delivery) { rounds.value = []; blockers.value = []; return; }
  try {
    const nextRounds = await deliveryApi.acceptanceRounds(delivery.id);
    if (token === revision && selectedId.value === delivery.id) {
      rounds.value = nextRounds;
      blockers.value = await deliveryApi.blockingIssues(delivery.id);
      const pending = nextRounds.find((round) => round.status === "pending");
      if (pending) await loadIssuesForPendingRound(pending);
      else issueOptions.value = {};
      await loadIssuesForRequirements(delivery.scopeVersion?.items.map((item) => item.requirementId) ?? []);
    }
  } catch (e) { if (token === revision) report(e); }
}
async function refreshDelivery() {
  if (!selected.value) return;
  const [delivery, allRounds] = await Promise.all([
    deliveryApi.get(selected.value.id),
    deliveryApi.acceptanceRounds(selected.value.id),
  ]);
  const index = deliveries.value.findIndex((item) => item.id === delivery.id);
  if (index >= 0) deliveries.value.splice(index, 1, delivery);
  rounds.value = allRounds;
  const pending = allRounds.find((round) => round.status === "pending");
  if (pending) await loadIssuesForPendingRound(pending);
  else issueOptions.value = {};
  blockers.value = await deliveryApi.blockingIssues(delivery.id);
}
watch(selectedId, () => { void loadSelected(); visibleFiles.value = []; });
onMounted(() => { void load(); });

async function openDeliveryById(deliveryId: number) {
  if (!Number.isInteger(deliveryId) || deliveryId <= 0) return false;
  if (!deliveries.value.some((delivery) => delivery.id === deliveryId)) {
    await load();
  }
  if (!deliveries.value.some((delivery) => delivery.id === deliveryId)) {
    ElMessage.warning("未找到对应的交付批次");
    return false;
  }
  selectedId.value = deliveryId;
  await loadSelected();
  return true;
}

async function createDelivery() {
  if (busy.value || !canPrepare.value || !(await props.beforeAction())) return;
  busy.value = true; error.value = "";
  try {
    const delivery = await deliveryApi.create(props.projectId, { ...createForm.value, acceptanceOwnerUserId: createForm.value.acceptanceOwnerUserId ?? props.detail.project.productOwnerUserId });
    deliveries.value.push(delivery);
    selectedId.value = delivery.id;
    createOpen.value = false;
    createForm.value = { name: "", plannedDeliveryDate: null, acceptanceOwnerUserId: null, description: "" };
  } catch (e) { report(e); } finally { busy.value = false; }
}
function openScope() {
  if (!selected.value || !canConfirmScope.value || busy.value) return;
  scopeIds.value = selected.value.scopeVersion?.items.map((item) => item.requirementId) ?? [];
  scopeReason.value = "";
  scopeChangeDrafts.value = {};
  scopeOpen.value = true;
}
async function confirmScope() {
  if (!selected.value || busy.value || !canConfirmScope.value || !(await props.beforeAction())) return;
  busy.value = true; error.value = "";
  try {
    const hasPriorScope = Boolean(selected.value.scopeVersion);
    const existingIds = selected.value.scopeVersion?.items.map((item) => item.requirementId) ?? [];
    const existing = new Set(existingIds);
    const added = scopeIds.value.filter((id) => !existing.has(id));
    const dispositionChanges = buildScopeChangeDrafts(existingIds, scopeIds.value, scopeChangeDrafts.value);
    if (dispositionChanges === null) {
      error.value = "请为每个移出范围的需求选择延期或豁免，并填写原因和后续去向。";
      return;
    }
    const changes = [
      ...added.map((requirementId) => ({ type: "add" as const, requirementId, reason: scopeReason.value.trim() })),
      ...dispositionChanges,
    ];
    const result = await deliveryApi.confirmScope(selected.value.id, {
      expectedVersion: selected.value.version,
      requirementIds: scopeIds.value,
      changeReason: hasPriorScope ? scopeReason.value.trim() : "",
      changes: hasPriorScope ? changes : [],
    });
    const index = deliveries.value.findIndex((item) => item.id === result.id);
    if (index >= 0) deliveries.value.splice(index, 1, result);
    scopeOpen.value = false;
    await loadSelected();
  } catch (e) { report(e); } finally { busy.value = false; }
}
async function openSubmission() {
  if (!selected.value || !canPrepare.value || !(await props.beforeAction())) return;
  deliveryNotes.value = ""; evidenceText.value = ""; evidenceFileId.value = undefined;
  customerName.value = ""; customerRole.value = ""; customerConfirmedAt.value = ""; customerEvidence.value = "";
  visibleFiles.value = [];
  try {
    const scopedIds = selected.value.scopeVersion?.items.map((item) => item.requirementId) ?? [];
    for (const requirementId of scopedIds) {
      const listing = await requirementApi.files(requirementId);
      for (const group of listing.groups)
        for (const file of group.files)
          if (["file", "text"].includes(file.resourceType) && file.status !== "missing")
            visibleFiles.value.push({ id: file.id, requirementId, label: file.name });
    }
    submitOpen.value = true;
  } catch (e) { report(e); }
}
async function loadIssuesForPendingRound(round: AcceptanceRound) {
  try {
    const entries = await Promise.all(round.items.map(async (item) => {
      const result = await issueApi.list(item.requirementId);
      return [item.scopeItemId, result.items.map((issue) => ({ id: issue.id, title: issue.title }))] as const;
    }));
    issueOptions.value = Object.fromEntries(entries);
  } catch (e) { report(e); }
}
async function loadIssuesForRequirements(requirementIds: number[]) {
  try {
    const entries = await Promise.all(requirementIds.map(async (requirementId) => (await issueApi.list(requirementId)).items.map((issue) => ({ id: issue.id, title: issue.title }))));
    availableIssues.value = entries.flat().filter((issue, index, all) => all.findIndex((candidate) => candidate.id === issue.id) === index);
  } catch (e) { report(e); }
}
async function addBlocker() {
  if (!selected.value || !blockerIssueId.value || busy.value || !canMarkBlocker.value || !(await props.beforeAction())) return;
  busy.value = true; error.value = "";
  try {
    await deliveryApi.addBlockingIssue(selected.value.id, { issueId: blockerIssueId.value, expectedVersion: selected.value.version, impact: blockerImpact.value.trim() });
    blockerIssueId.value = undefined; blockerImpact.value = "";
    await refreshDelivery(); blockers.value = await deliveryApi.blockingIssues(selected.value.id);
  } catch (e) { report(e); } finally { busy.value = false; }
}
async function acceptBlockerRisk(blockerId: number) {
  if (!selected.value || !isProjectOwner.value || busy.value || !(await props.beforeAction())) return;
  try {
    const reason = (await ElMessageBox.prompt("填写风险接受原因；该操作将记录操作者和证据。", "接受交付风险", { inputType: "textarea", inputValidator: (value) => !!value?.trim() || "请填写原因" })).value.trim();
    busy.value = true; error.value = "";
    await deliveryApi.acceptRisk(blockerId, { expectedVersion: selected.value.version, reason, evidence: { kind: "text", label: "风险接受记录", content: reason } });
    await refreshDelivery(); blockers.value = await deliveryApi.blockingIssues(selected.value.id);
  } catch (e) { if (e !== "cancel") report(e); } finally { busy.value = false; }
}
async function resolveBlocker(blockerId: number) {
  if (!selected.value || !canMarkBlocker.value || busy.value || !(await props.beforeAction())) return;
  busy.value = true; error.value = "";
  try {
    await deliveryApi.resolveBlockingIssue(selected.value.id, blockerId, { expectedVersion: selected.value.version });
    await refreshDelivery(); blockers.value = await deliveryApi.blockingIssues(selected.value.id);
  } catch (e) { report(e); } finally { busy.value = false; }
}
async function submitAcceptance() {
  if (!selected.value || busy.value || !canPrepare.value || !customerConfirmationComplete.value) return;
  busy.value = true; error.value = "";
  try {
    const evidence = [] as Array<{ kind: "text"; label: string; content: string } | { kind: "file"; label: string; sourceResourceId: number }>;
    if (evidenceText.value.trim()) evidence.push({ kind: "text", label: "交付说明", content: evidenceText.value.trim() });
    if (evidenceFileId.value) {
      const file = visibleFiles.value.find((item) => item.id === evidenceFileId.value);
      if (file) evidence.push({ kind: "file", label: file.label, sourceResourceId: file.id });
    }
    const result = await deliveryApi.submitAcceptance(selected.value.id, {
      expectedVersion: selected.value.version,
      scopeVersionId: selected.value.scopeVersion!.id,
      deliveryNotes: deliveryNotes.value.trim(),
      evidence,
      customerConfirmation: customerName.value.trim() || customerRole.value.trim() || customerConfirmedAt.value || customerEvidence.value.trim()
        ? {
            confirmedByName: customerName.value.trim(),
            confirmedByRole: customerRole.value.trim(),
            confirmedAt: new Date(customerConfirmedAt.value).toISOString(),
            evidence: { kind: "text", label: "客户确认凭证", content: customerEvidence.value.trim() },
          }
        : null,
    });
    submitOpen.value = false;
    await refreshDelivery();
    emit("updated", props.detail);
    void result;
  } catch (e) { report(e); } finally { busy.value = false; }
}
function setResult(scopeItemId: number, result: "passed" | "failed") {
  results.value[scopeItemId] ??= { result, reason: "", issueId: null };
  results.value[scopeItemId].result = result;
  if (result === "passed") results.value[scopeItemId].issueId = null;
}
async function recordResults() {
  const delivery = selected.value, round = pendingRound.value;
  if (!delivery || !round || busy.value || !isAcceptanceOwner.value || !acceptanceResultsComplete.value || !(await props.beforeAction())) return;
  busy.value = true; error.value = "";
  try {
    await deliveryApi.recordAcceptanceResults(round.id, {
      expectedVersion: delivery.version,
      scopeVersionId: round.scopeVersionId,
      results: round.items.map((item) => ({
        scopeItemId: item.scopeItemId,
        result: results.value[item.scopeItemId]?.result ?? "failed",
        reason: results.value[item.scopeItemId]?.reason ?? "",
        issueId: results.value[item.scopeItemId]?.issueId ?? null,
      })),
    });
    await refreshDelivery();
    results.value = {};
  } catch (e) { report(e); } finally { busy.value = false; }
}
defineExpose({
  openDeliveryById,
  invalidate: () => {
    revision++;
    deliveries.value = [];
    rounds.value = [];
    visibleFiles.value = [];
  },
});
</script>
<template>
  <div class="delivery-panel" v-loading="loading">
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <div class="panel-toolbar">
      <el-select v-model="selectedId" aria-label="选择交付批次" placeholder="选择交付批次" class="delivery-picker">
        <el-option v-for="delivery in deliveries" :key="delivery.id" :value="delivery.id" :label="`${delivery.name}${delivery.isDefault ? '（默认）' : ''}`" />
      </el-select>
      <el-tag v-if="selected" size="small">{{ selected.isDefault ? '默认交付' : selected.status }}</el-tag>
      <span v-if="selected?.plannedDeliveryDate" class="muted">计划 {{ selected.plannedDeliveryDate }}</span>
      <span class="toolbar-spacer" />
      <el-button v-if="canConfirmScope && selected" size="small" :disabled="busy" @click="openScope">{{ selected.scopeVersion ? '调整范围' : '确认范围' }}</el-button>
      <el-button v-if="canPrepare && selected?.scopeVersion && !pendingRound" size="small" type="primary" @click="openSubmission">提交验收</el-button>
      <el-button v-if="canPrepare" size="small" @click="createOpen = true">新增批次</el-button>
    </div>
    <el-empty v-if="!selected && !loading" description="当前项目暂无交付批次" />
    <template v-if="selected">
      <div class="delivery-meta">
        <span>交付版本 {{ selected.version }}</span>
        <span>范围版本 {{ selected.scopeVersion?.version ?? '未确认' }}</span>
        <span>验收负责人：{{ activeMembers.find((member) => member.userId === selected?.acceptanceOwnerUserId)?.displayName ?? '未指定' }}</span>
      </div>
      <section v-if="selected.scopeVersion" class="scope-section">
        <div class="section-title"><h3>本次交付范围</h3><span class="muted">{{ selected.scopeVersion.items.length }} 项 · v{{ selected.scopeVersion.version }}</span></div>
        <el-table :data="selected.scopeVersion.items" size="small" max-height="270">
          <el-table-column prop="requirementNo" label="需求编号" width="145" />
          <el-table-column prop="requirementName" label="需求名称" min-width="190" show-overflow-tooltip />
          <el-table-column prop="acceptanceCriteria" label="验收标准" min-width="230" show-overflow-tooltip />
        </el-table>
      </section>
      <section class="blocker-section">
        <div class="section-title"><h3>交付阻断</h3><span class="muted">{{ blockers.filter((item) => !item.resolvedAt).length }} 项待处理</span></div>
        <div v-for="blocker in blockers" :key="blocker.id" class="blocker-row">
          <span>问题 #{{ blocker.issueId }} · {{ blocker.impact || '未填写影响' }}</span><el-tag size="small" :type="blocker.resolvedAt ? 'success' : blocker.riskAcceptance ? 'warning' : 'danger'">{{ blocker.resolvedAt ? '已解除' : blocker.riskAcceptance ? '已接受风险' : '阻断中' }}</el-tag>
          <el-button v-if="!blocker.resolvedAt && canMarkBlocker" size="small" @click="resolveBlocker(blocker.id)">解除阻断</el-button>
          <el-button v-if="!blocker.resolvedAt && !blocker.riskAcceptance && isProjectOwner" size="small" @click="acceptBlockerRisk(blocker.id)">接受风险</el-button>
        </div>
        <div v-if="canMarkBlocker && selected.scopeVersion" class="blocker-create"><el-select v-model="blockerIssueId" filterable clearable placeholder="选择本交付范围的问题"><el-option v-for="issue in availableIssues" :key="issue.id" :value="issue.id" :label="issue.title" /></el-select><el-input v-model="blockerImpact" maxlength="2000" placeholder="说明对交付的影响" /><el-button size="small" :disabled="!blockerIssueId || !blockerImpact.trim()" :loading="busy" @click="addBlocker">标记阻断</el-button></div>
      </section>
      <section v-if="pendingRound" class="acceptance-section">
        <div class="section-title"><h3>待验收 · 第 {{ pendingRound.round }} 轮</h3><span class="muted">提交于 {{ new Date(pendingRound.submittedAt).toLocaleString('zh-CN') }}</span></div>
        <div class="evidence-list"><span v-for="evidence in pendingRound.evidence" :key="evidence.id" class="evidence-line"><a v-if="evidence.kind === 'url'" :href="evidence.url!" target="_blank" rel="noreferrer">{{ evidence.label }}</a><a v-else :href="deliveryApi.evidenceUrl(pendingRound.id, evidence.id)" target="_blank" rel="noreferrer">{{ evidence.label }} · SHA-256 {{ evidence.contentHash?.slice(0, 12) }}</a></span></div>
        <el-alert v-if="!isAcceptanceOwner" title="当前账号不是指定验收人，验收结果为只读。" type="info" :closable="false" />
        <template v-else>
          <div class="result-table">
            <div v-for="item in pendingRound.items" :key="item.scopeItemId" class="result-row">
              <div class="result-name"><strong>{{ item.requirementNo }} · {{ item.requirementName }}</strong><span>{{ item.acceptanceCriteria || '未填写验收标准' }}</span></div>
              <el-radio-group :model-value="results[item.scopeItemId]?.result" @update:model-value="setResult(item.scopeItemId, $event)"><el-radio-button value="passed">通过</el-radio-button><el-radio-button value="failed">不通过</el-radio-button></el-radio-group>
              <el-input v-if="results[item.scopeItemId]?.result === 'failed'" v-model="results[item.scopeItemId].reason" size="small" maxlength="2000" placeholder="填写不通过原因" />
              <el-select v-if="results[item.scopeItemId]?.result === 'failed'" v-model="results[item.scopeItemId].issueId" size="small" clearable placeholder="关联问题（可选）"><el-option v-for="issue in issueOptions[item.scopeItemId]" :key="issue.id" :value="issue.id" :label="issue.title" /><el-option v-if="!issueOptions[item.scopeItemId]?.length" disabled label="该需求暂无问题" :value="0" /></el-select>
            </div>
          </div>
          <el-button type="primary" :loading="busy" :disabled="!acceptanceResultsComplete" @click="recordResults">提交验收结果</el-button>
        </template>
      </section>
      <section class="history-section">
        <div class="section-title"><h3>验收历史</h3><span class="muted">{{ rounds.length }} 轮</span></div>
        <el-table v-if="rounds.length" :data="rounds" size="small">
          <el-table-column prop="round" label="轮次" width="75"><template #default="{ row }">第 {{ row.round }} 轮</template></el-table-column>
          <el-table-column prop="submittedAt" label="提交时间" min-width="180"><template #default="{ row }">{{ new Date(row.submittedAt).toLocaleString('zh-CN') }}</template></el-table-column>
          <el-table-column label="系统提交人" min-width="140"><template #default="{ row }">{{ memberNames.get(row.submittedBy) || `账号 #${row.submittedBy}` }}</template></el-table-column>
          <el-table-column label="轮次处理人" min-width="180"><template #default="{ row }"><template v-if="row.completedBy != null">{{ row.status === 'superseded' ? '范围修订人' : '系统验收人' }}：{{ memberNames.get(row.completedBy) || `账号 #${row.completedBy}` }}</template><span v-else>尚未完成验收</span></template></el-table-column>
          <el-table-column label="客户确认人" min-width="240"><template #default="{ row }"><template v-if="row.customerConfirmation"><div>{{ row.customerConfirmation.confirmedByName }} · {{ row.customerConfirmation.confirmedByRole }}</div><div>{{ new Date(row.customerConfirmation.confirmedAt).toLocaleString('zh-CN') }}</div><a :href="row.customerConfirmation.evidence.kind === 'url' ? row.customerConfirmation.evidence.url : deliveryApi.customerConfirmationEvidenceUrl(row.id)" target="_blank" rel="noreferrer">查看确认凭证</a></template><span v-else>未录入</span></template></el-table-column>
          <el-table-column prop="status" label="结果" width="110"><template #default="{ row }"><el-tag size="small" :type="row.status === 'passed' ? 'success' : row.status === 'failed' ? 'danger' : row.status === 'superseded' ? 'info' : 'warning'">{{ ({ pending: '待验收', passed: '通过', failed: '未通过', superseded: '已失效' } as Record<string, string>)[row.status] }}</el-tag></template></el-table-column>
          <el-table-column label="结果明细" min-width="220"><template #default="{ row }">{{ row.items.filter((item: AcceptanceRound['items'][number]) => item.result === 'passed').length }} 通过 / {{ row.items.filter((item: AcceptanceRound['items'][number]) => item.result === 'failed').length }} 未通过</template></el-table-column>
        </el-table>
        <el-empty v-else description="尚无验收记录" :image-size="48" />
      </section>
    </template>
    <el-dialog v-model="createOpen" title="新增交付批次" width="min(520px, 94vw)">
      <el-form label-position="top"><el-form-item label="批次名称" required><el-input v-model="createForm.name" maxlength="200" /></el-form-item><el-form-item label="计划交付日"><el-date-picker v-model="createForm.plannedDeliveryDate" value-format="YYYY-MM-DD" type="date" /></el-form-item><el-form-item label="验收负责人"><el-select v-model="createForm.acceptanceOwnerUserId" clearable placeholder="默认产品负责人"><el-option v-for="member in activeMembers" :key="member.userId" :value="member.userId" :label="member.displayName" /></el-select></el-form-item><el-form-item label="交付说明"><el-input v-model="createForm.description" type="textarea" :rows="2" maxlength="5000" /></el-form-item></el-form>
      <template #footer><el-button @click="createOpen = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="!createForm.name.trim()" @click="createDelivery">创建批次</el-button></template>
    </el-dialog>
    <el-dialog v-model="scopeOpen" :title="selected?.scopeVersion ? '修订交付范围' : '确认交付范围'" width="min(800px, 94vw)">
      <el-alert v-if="selected?.scopeVersion" title="范围修订会使当前待验收轮次失效。移出项需记录延期或豁免及后续去向，并保留在历史快照中。" type="warning" :closable="false" />
      <p class="muted">勾选纳入本批次的需求；首次确认后将生成不可变范围快照。</p>
      <el-checkbox-group v-model="scopeIds" class="scope-choices"><el-checkbox v-for="requirement in requirements" :key="requirement.id" :value="requirement.id"><span class="choice-no">{{ requirement.requirementNo }}</span>{{ requirement.name }}</el-checkbox></el-checkbox-group>
      <el-input v-if="selected?.scopeVersion" v-model="scopeReason" type="textarea" :rows="3" maxlength="2000" placeholder="填写本次范围变更原因" />
      <div v-for="item in removedRequirements" :key="item.requirementId" class="scope-disposition">
        <strong>{{ item.requirementNo }} · {{ item.requirementName }}</strong>
        <el-select v-model="scopeChangeDrafts[item.requirementId].type" placeholder="选择延期或豁免"><el-option label="延期" value="postpone" /><el-option label="豁免" value="waive" /></el-select>
        <el-input v-model="scopeChangeDrafts[item.requirementId].reason" maxlength="2000" placeholder="填写处置原因" />
        <el-select v-model="scopeChangeDrafts[item.requirementId].followUpDeliveryId" clearable placeholder="后续交付批次"><el-option v-for="delivery in followUpDeliveries" :key="delivery.id" :value="delivery.id" :label="delivery.name" /></el-select>
        <template v-if="!scopeChangeDrafts[item.requirementId].followUpDeliveryId"><el-select v-model="scopeChangeDrafts[item.requirementId].followUpOwnerUserId" clearable placeholder="跟进责任人"><el-option v-for="member in activeMembers" :key="member.userId" :value="member.userId" :label="member.displayName" /></el-select><el-date-picker v-model="scopeChangeDrafts[item.requirementId].followUpDate" value-format="YYYY-MM-DD" type="date" placeholder="跟进日期" /></template>
      </div>
      <template #footer><el-button @click="scopeOpen = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="scopeIds.length === 0 || (!!selected?.scopeVersion && !scopeReason.trim())" @click="confirmScope">{{ selected?.scopeVersion ? '保存范围修订' : '确认范围' }}</el-button></template>
    </el-dialog>
    <el-dialog v-model="submitOpen" title="提交交付验收" width="min(600px, 94vw)">
      <el-alert title="至少提交文本说明或范围内的需求附件快照；外链仅作为补充引用。" type="info" :closable="false" />
      <el-form label-position="top" class="submit-form"><el-form-item label="交付备注"><el-input v-model="deliveryNotes" type="textarea" :rows="2" maxlength="5000" /></el-form-item><el-form-item label="不可变文本证据"><el-input v-model="evidenceText" type="textarea" :rows="4" maxlength="100000" placeholder="发布说明、部署版本或测试结论" /></el-form-item><el-form-item label="需求附件快照（可选）"><el-select v-model="evidenceFileId" clearable placeholder="选择当前范围内的文件"><el-option v-for="file in visibleFiles" :key="file.id" :value="file.id" :label="file.label" /></el-select></el-form-item><el-divider content-position="left">客户确认（可选）</el-divider><el-form-item label="客户确认人"><el-input v-model="customerName" maxlength="200" /></el-form-item><el-form-item label="身份说明"><el-input v-model="customerRole" maxlength="200" /></el-form-item><el-form-item label="确认时间"><el-date-picker v-model="customerConfirmedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" /></el-form-item><el-form-item label="确认凭证文本"><el-input v-model="customerEvidence" type="textarea" :rows="2" maxlength="100000" /></el-form-item><el-alert v-if="!customerConfirmationComplete" title="客户确认信息需完整填写，或全部留空。" type="warning" :closable="false" /></el-form>
      <template #footer><el-button @click="submitOpen = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="(!evidenceText.trim() && !evidenceFileId) || !customerConfirmationComplete" @click="submitAcceptance">提交给验收人</el-button></template>
    </el-dialog>
  </div>
</template>
<style scoped>
.delivery-panel{display:flex;flex-direction:column;gap:14px;min-width:0}.panel-toolbar,.delivery-meta,.section-title{display:flex;align-items:center;gap:10px;min-width:0}.panel-toolbar{min-height:34px}.delivery-picker{width:min(300px,50vw)}.toolbar-spacer{flex:1}.muted{color:var(--text-secondary);font-size:12px}.delivery-meta{padding:8px 0;border-bottom:1px solid var(--border-color);flex-wrap:wrap;color:var(--text-secondary);font-size:12px}.section-title{justify-content:space-between;margin-bottom:8px}.section-title h3{font-size:14px;font-weight:600;margin:0}.scope-section,.acceptance-section,.history-section{min-width:0}.acceptance-section{display:flex;flex-direction:column;gap:10px;padding-top:4px}.evidence-list{display:flex;gap:8px;flex-wrap:wrap}.evidence-line{font-size:12px}.result-table{display:flex;flex-direction:column;border-top:1px solid var(--border-color)}.result-row{display:grid;grid-template-columns:minmax(200px,1fr) auto minmax(180px,260px);align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-color)}.result-name{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12px}.result-name strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.result-name span{color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.scope-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:360px;overflow:auto;padding:8px 0}.scope-choices :deep(.el-checkbox){margin:0;min-width:0}.choice-no{font-family:Consolas,monospace;color:var(--text-secondary);margin-right:8px}.submit-form{margin-top:16px}.submit-form :deep(.el-select){width:100%}@media(max-width:760px){.panel-toolbar{flex-wrap:wrap}.delivery-picker{width:100%}.result-row{grid-template-columns:minmax(0,1fr);gap:8px}.scope-choices{grid-template-columns:minmax(0,1fr)}}
</style>
