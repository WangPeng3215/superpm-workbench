# 每日任务与工时

- 版本：V1.0（2026-10-24）
- 对应迁移：`apps/server/drizzle/0014_daily_tasks.sql`（schema 14）
- 入口：`/tasks`

## 1. 目标与边界

每日任务用于把当天要做的事与真实投入时间放在同一处：

- 按计划日期组织任务，支持拖拽排序、状态筛选、关联需求与计划时段。
- 任务可开始/结束计时；每次计时生成一条工时记录。
- 到达业务日 18:00 或当日 8 小时额度时自动结束，重启后补偿关闭。
- 已完成工时可在限制条件下手动校正，所有修改追加审计。
- 提供月度日历分布与可直接复制的每日工作总结。

不在本期范围：跨天计时、请假/审批、多人协作看板、任务提醒推送、与外部日历同步。每日任务暂不暴露给 MCP。

## 2. 架构落点

沿用现有四层结构，不新增独立服务：

| 层 | 文件 | 职责 |
|---|---|---|
| 契约 | `packages/shared/src/daily-tasks.ts` | 枚举、标签、Zod Schema、返回值类型 |
| 数据 | `apps/server/drizzle/0014_daily_tasks.sql`、`apps/server/src/db/schema.ts` | 表、约束、索引、Drizzle 模型 |
| 领域 | `apps/server/src/services/daily-tasks.ts` | 事务、计时状态机、边界计算、汇总 |
| 时间 | `apps/server/src/services/business-time.ts` | 业务时区、业务日、本地时间转 UTC |
| HTTP | `apps/server/src/app.ts` | `/api/daily-tasks*`、`/api/daily-time-entries/:id` |
| 页面 | `apps/web/src/pages/DailyTasksPage.vue` | 主页面与交互编排 |
| 组件 | `apps/web/src/features/daily-tasks/` | 日历、任务表单、工时校正、格式化 |
| 客户端 | `apps/web/src/api/daily-tasks.ts` | 强类型 API 封装 |

所有读写都经过 `DailyTasksService`，路由只做参数解析与鉴权；Web 不直接访问数据库。

## 3. 数据模型

### 3.1 `daily_tasks`

| 列 | 说明 |
|---|---|
| `plan_date` | 计划日期 `YYYY-MM-DD`，任务按此归属到某一天 |
| `requirement_id` | 可选关联需求；需求删除后展示为空 |
| `planned_start_at` / `planned_end_at` | 可选计划时段 `HH:mm`，两者同时存在时结束必须晚于开始 |
| `estimated_minutes` | 预计耗时，30–480 分钟、30 分钟步进 |
| `status` | `pending` / `in_progress` / `completed`；`in_progress` 只能由计时进入 |
| `sort_order` | 同日内顺序，由拖拽排序整体重写 |
| `deleted_at` | 有历史工时的任务删除时软删除，保留在总结中 |

### 3.2 `daily_time_entries`

| 列 | 说明 |
|---|---|
| `started_at` | UTC ISO 时刻 |
| `ended_at` | 结束时刻；活动记录为空 |
| `duration_seconds` | 后端按起止时间计算，不信任前端 |
| `status` | `active` / `completed` |
| `end_reason` | `manual` / `auto_18_00` / `daily_limit` |

关键约束：

- 部分唯一索引 `ON daily_time_entries(status) WHERE status = 'active'` 保证全实例最多一条活动计时，并发开始由数据库兜底。
- 工时按 `started_at` 所在业务日归属，不按任务计划日期归属；跨天记录被禁止。

### 3.3 `daily_time_entry_audits`

只追加，不更新、不删除。每次人工校正记录修改前后的起止时间、原因与操作时间。

## 4. 时区与业务日

- 业务时区优先取 `SUPERPM_BUSINESS_TZ`，否则取服务运行环境的 `Intl` 时区，后端和页面展示保持同一时区（页面展示服务端返回的 `timezone`）。
- 数据库存 UTC ISO 时刻；任务日期、月度日历、每日统计与总结使用业务时区的自然日。
- 前端把墙上时间（`HH:mm`）换算为 UTC 时采用与后端一致的 Intl 偏移迭代算法（`apps/web/src/features/daily-tasks/format.ts`）。
- 业务日结束为当地 18:00；每日额度为 8 小时。

## 5. 业务规则

### 5.1 任务

- 创建必须包含名称、计划日期与预计耗时；描述最多 4000 字。
- 只有通过「开始计时」才能进入 `in_progress`；活动计时期间不能把状态改成其他值。
- 排序接口要求提交当日完整 ID 列表，与库中任务不一致时返回 409，避免多端并发覆盖。
- 删除：无工时记录时物理删除；有工时记录时写 `deleted_at`，任务从当日列表消失，但工时与总结仍保留。活动计时中的任务禁止删除。

### 5.2 计时

开始计时前依次校验：

1. 当前没有其他活动计时；
2. 当前时刻早于业务日 18:00；
3. 当日已完成工时未达到 8 小时。

结束后任务状态置为 `completed`。若停止请求发生在边界之后，结束时刻截断到边界，而不是当前时间。

### 5.3 自动结束与补偿

- 活动计时的边界取「业务日 18:00」与「当日剩余额度用完的时刻」中较早者，原因分别为 `auto_18_00` 与 `daily_limit`。
- 服务启动时与每 15 秒执行一次 `reconcile()`，关闭已越过边界的活动计时。
- 页面展示的计时时钟以服务端 `activeTimer` 为准，在前端每秒推进并封顶到 `autoEndAt`；每 30 秒轮询、回到前台和到达边界时刷新。
- 计时过程中修改任务信息不会改变进行中的记录；需要调整时间必须等结束后做工时校正。

### 5.4 工时校正

仅允许修正 `completed` 记录，并满足：

- 结束晚于开始，且不能跨业务日；
- 仍是原业务日的记录；
- 结束不晚于当天 18:00，开始不早于当天 00:00；
- 与同日其他工时记录不重叠；
- 修正后当日总工时不超过 8 小时。

成功后重新计算 `duration_seconds`，追加审计并返回更新后的当日数据。

### 5.5 总结

总结按业务日聚合：任务标题、完成状态与当日工时。软删除任务仍以归档标题计入已完成部分，避免删除任务后历史总结失真。文本由后端生成，页面只负责预览与复制。

## 6. API

| 方法与路径 | 用途 |
|---|---|
| `GET /api/daily-tasks?date=YYYY-MM-DD` | 某业务日的任务、统计、活动计时与总结 |
| `GET /api/daily-tasks/calendar?month=YYYY-MM` | 月度每日任务数、完成数、工时与活动标记 |
| `GET /api/daily-tasks/active` | 全局活动计时 |
| `GET /api/daily-tasks/summary-text?date=YYYY-MM-DD` | 仅返回总结文本 |
| `POST /api/daily-tasks` | 创建任务 |
| `PATCH /api/daily-tasks/:id` | 部分更新任务 |
| `PATCH /api/daily-tasks/order` | 重写某日任务顺序 |
| `DELETE /api/daily-tasks/:id` | 删除或归档任务 |
| `GET /api/daily-tasks/:id/time-entries` | 任务的历史工时 |
| `POST /api/daily-tasks/:id/start` | 开始计时 |
| `POST /api/daily-tasks/:id/stop` | 结束计时 |
| `PATCH /api/daily-time-entries/:id` | 校正已完成工时并写审计 |

错误沿用 `{ error: { code, message, details? } }`；状态冲突返回 409，参数校验返回 400。

## 7. 前端设计

- 视觉参考了用户提供的日历工作台图片，但只借鉴信息层级；仍使用 Element Plus 与项目语义化 CSS 变量，未引入 Fancy UI（其依赖 Tailwind CSS 4，会与现有设计系统割裂）。
- 页面结构：渐变主视觉与进度环、活动计时条、任务列表、月度日历、工作总结。深浅色均使用同一套 token，动画在 `prefers-reduced-motion` 下关闭。
- 状态筛选使用紧凑下拉，符合项目「优先信息密度」的界面偏好。
- 表单与校正对话框复用 Element Plus；时间输入支持直接键入回车提交。
- 页面在服务端数据变化后统一刷新当日数据与日历；活动计时不依赖前端本地持久化，刷新或重开页面可恢复。

## 8. 验证

- 服务端：`apps/server/tests/daily-tasks.test.ts`（领域规则）、`daily-tasks-api.test.ts`（路由与鉴权）、迁移测试。
- 浏览器：`tests/e2e/daily-tasks.spec.ts` 覆盖创建/筛选/完成/编辑/删除、总结复制（真实剪贴板）、计时与校正、归档删除、深色模式与 420px 窄屏无横向滚动。
- 常规流水线：`npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e`。

## 9. 风险与后续

- 业务时区在服务运行中变更不会重算历史记录；如需支持，应作为显式迁移处理。
- 依赖系统时钟；大幅回拨可能导致计时偏短，补偿逻辑只处理越过边界的情况。
- 前端轮询间隔为 30 秒，页面在后台时可能延迟刷新，但服务端 15 秒补偿保证记录正确。
- 后续可扩展：任务模板、周/月统计、提醒、与需求进展联动；开放给 MCP 前需单独定义同意的读写边界与审计策略。
