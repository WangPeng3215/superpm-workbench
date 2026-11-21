# 项目管理 S2 验证记录

## 本批交付

完成开发总纲 S2.1–S2.4：

- 计时回归：配额按记录所属账号计算；工时校正检查同账号活动记录的有效时间范围；手动停止在自动边界前记录为 `manual`，到达边界才记录自动结束原因。
- 项目任务：新增版本化任务模型和追加式操作/提交/确认历史；按项目角色、执行人、确认人及项目状态授权创建、编辑、开始、阻塞、提交、退回、通过、取消和重开。
- 个人安排与工时：同一账号的同一项目任务同一业务日复用个人安排；开始工时时将项目和任务来源写入工时记录；项目工时只按明确关联的工时来源聚合，并保留记录账号。
- 交互：项目任务列表支持全部、分配给我和待确认视图；需求负责人可拆分关联任务；执行人和确认人分账号完成跨日安排与确认。

个人日程仍按账号隔离，项目汇总不包含未关联的私人日程。

## 验证

- `npx vitest run apps/server/tests/daily-tasks.test.ts apps/server/tests/project-tasks.test.ts apps/server/tests/project-task-routes.test.ts apps/server/tests/project-worklog.test.ts apps/server/tests/user-isolation.test.ts --reporter=dot`：5 个文件、44 项通过。
- `npx vitest run packages/shared/tests/dates.test.ts packages/shared/tests/projects.test.ts packages/shared/tests/projects-public.test.ts --reporter=dot`：3 个文件、29 项通过。
- `npx vitest run apps/web/tests/project-tasks-api.test.ts apps/web/tests/project-panels.test.ts --reporter=dot`：2 个文件、7 项通过。
- `npm run typecheck --workspaces --if-present`：server、web、shared 类型检查通过。
- `npx playwright test tests/e2e/project-tasks.spec.ts tests/e2e/daily-tasks.spec.ts`：6 项通过。项目任务用例覆盖跨账号退回/重提/确认、跨业务日个人安排、项目工时汇总及私人日程隔离。

## 未完成项与边界

本批 S2.1–S2.4 无未完成项。S3 正式交付/验收/结项和 S4 项目概览/资料聚合/动态不属于本次验收；未提交、推送或发布。
