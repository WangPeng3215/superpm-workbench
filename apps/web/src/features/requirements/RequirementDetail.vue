<script setup lang="ts">
import { computed } from "vue";
import { ElButton, ElTag, ElEmpty, ElIcon } from "element-plus";
import { EditPen, Delete, Clock } from "@element-plus/icons-vue";
import {
  stages,
  stageLabels,
  stageDescriptions,
  typeLabels,
  statusLabels,
} from "@superpm/shared";
import type { Requirement, Stage, StageHistory } from "@superpm/shared";
import XlyDrawer from "../../components/ease-ui/xly-drawer/index.vue";
const props = defineProps<{
  selected?: Requirement;
  history: StageHistory[];
  stageSaving: boolean;
}>();
const open = defineModel<boolean>({ required: true });
const viewingStage = defineModel<Stage>("viewingStage", { required: true });
const emit = defineEmits<{
  edit: [requirement: Requirement];
  remove: [requirement: Requirement];
  changeStage: [stage: Stage];
}>();
const currentStage = computed(() => props.selected?.currentStage ?? "analysis");
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
</script>
<template>
  <XlyDrawer
    v-model="open"
    direction="right"
    size="min(680px, 100vw)"
    :title="
      selected ? `${selected.requirementNo} · ${selected.name}` : '需求详情'
    "
    custom-class="requirement-drawer"
  >
    <template v-if="selected"
      ><div class="detail-header">
        <div>
          <div class="detail-meta">
            <el-tag :type="statusType(selected.status)" effect="light">{{
              statusLabels[selected.status]
            }}</el-tag
            ><span>{{ typeLabels[selected.type] }}</span
            ><span>优先级 {{ selected.priority }}</span>
          </div>
          <p class="detail-description">
            {{ selected.description || "还没有填写需求描述。" }}
          </p>
        </div>
        <div class="detail-actions">
          <el-button
            circle
            plain
            :icon="EditPen"
            aria-label="编辑需求"
            @click="emit('edit', selected)"
          /><el-button
            circle
            plain
            type="danger"
            :icon="Delete"
            aria-label="软删除需求"
            @click="emit('remove', selected)"
          />
        </div>
      </div>
      <div class="stage-progress">
        <div
          v-for="(stage, index) in stages"
          :key="stage"
          class="progress-stage"
          :class="{
            active: stage === viewingStage,
            current: stage === currentStage,
          }"
          @click="viewingStage = stage"
        >
          <span class="progress-index">{{ index + 1 }}</span
          ><span>{{ stageLabels[stage] }}</span>
        </div>
      </div>
      <section class="drawer-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">CURRENT WORKSPACE</span>
            <h3>{{ stageLabels[viewingStage] }}</h3>
          </div>
          <el-button
            v-if="viewingStage !== currentStage"
            type="primary"
            plain
            size="small"
            :loading="stageSaving"
            @click="emit('changeStage', viewingStage)"
            >设为当前阶段</el-button
          ><el-tag v-else effect="plain">当前阶段</el-tag>
        </div>
        <p class="workspace-description">
          {{ stageDescriptions[viewingStage] }}
        </p>
        <div class="stage-placeholder">
          <div class="placeholder-icon">
            <ElIcon><Clock /></ElIcon>
          </div>
          <strong>{{ stageLabels[viewingStage] }}工作区骨架已就绪</strong>
          <p>后续将在这里接入记录、问题、决策和产物。</p>
          <div class="placeholder-chips">
            <span
              v-for="chip in viewingStage === 'analysis'
                ? ['分析记录', '待确认项', '方案比较']
                : viewingStage === 'design'
                  ? ['设计稿', '版本历史', '确认记录']
                  : viewingStage === 'development'
                    ? ['进展时间线', '问题与风险', '变更记录']
                    : ['测试用例', '执行历史', '复测闭环']"
              :key="chip"
              >{{ chip }}</span
            >
          </div>
        </div>
      </section>
      <section class="drawer-section facts-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">REQUIREMENT FACTS</span>
            <h3>关键时间</h3>
          </div>
        </div>
        <div class="facts-grid">
          <div>
            <span>提出时间</span><strong>{{ selected.proposedAt }}</strong>
          </div>
          <div>
            <span>预计完成</span
            ><strong>{{ selected.expectedAt || "未设置" }}</strong>
          </div>
          <div>
            <span>创建时间</span
            ><strong>{{
              new Date(selected.createdAt).toLocaleString("zh-CN")
            }}</strong>
          </div>
          <div>
            <span>更新时间</span
            ><strong>{{
              new Date(selected.updatedAt).toLocaleString("zh-CN")
            }}</strong>
          </div>
        </div>
      </section>
      <section class="drawer-section history-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">AUDIT TRAIL</span>
            <h3>阶段历史</h3>
          </div>
        </div>
        <el-empty
          v-if="!history.length"
          description="尚未发生阶段切换"
          :image-size="50"
        />
        <div v-else class="history-list">
          <div v-for="item in history" :key="item.id" class="history-item">
            <i></i>
            <div>
              <strong
                >{{ stageLabels[item.fromStage] }} →
                {{ stageLabels[item.toStage] }}</strong
              >
              <p>{{ item.note || "阶段切换" }} · {{ item.actor }}</p>
            </div>
            <time>{{ new Date(item.createdAt).toLocaleString("zh-CN") }}</time>
          </div>
        </div>
      </section></template
    >
  </XlyDrawer>
</template>
<style scoped src="./requirements.css"></style>
