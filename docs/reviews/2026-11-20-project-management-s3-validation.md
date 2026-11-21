# 项目管理 S3 验证记录

2026-11-21 收尾更新：下文“未完成项”保留为早期验证历史；新增边界证据、修复及最终检查见 [S3/S4 收尾验证](2026-11-21-project-management-s4-validation.md)。

## 本批交付

完成开发总纲 S3.2–S3.4 的服务端规则、交付验收面板和项目结项入口：

- 默认交付批次、不可变范围快照、证据快照和逐项验收轮次。
- 失败验收可关联同项目问题并再次提交；范围移出支持延期/豁免及后续责任去向。
- 交付阻断、解除阻断、风险接受和客户确认记录。
- 结项前检查、结项/重开审计与幂等命令。

## 验证

- `npm run typecheck --workspaces --if-present`：server、web、shared 类型检查通过。
- `npm exec vitest run apps/server/tests/deliveries.test.ts apps/server/tests/delivery-acceptance-migration.test.ts apps/server/tests/delivery-closure-s3.test.ts apps/server/tests/delivery-routes.test.ts apps/web/tests/deliveries-api.test.ts apps/web/tests/project-delivery-acceptance.test.ts apps/web/tests/project-panels.test.ts --config vitest.config.ts --reporter=dot`：7 个文件、27 项通过。
- `npx playwright test tests/e2e/projects.spec.ts --grep "项目详情可打开交付验收面板"`：auth setup 与交付面板 smoke 共 2 项通过。
- `npx playwright test tests/e2e/projects.spec.ts --grep "交付面板可新增批次并显示服务端结果"`：auth setup 与新增批次闭环共 2 项通过；真实后端列表确认新增批次已持久化。
- 2026-11-21 复核：`npm run typecheck` 通过；S3 定向 Vitest（交付服务/闭环/路由与前端验收逻辑）共 11 个文件、42 项通过；`npm run test:e2e -- --project=e2e --grep "默认交付验收通过后可结项并重开|验收不通过关联问题后可重新提交并通过|交付面板可新增批次|项目详情可打开交付验收面板"`：auth setup 与 4 个 S3 浏览器用例共 5 项通过。
- 修正了失败重提 E2E 对验收轮次顺序的错误假设：接口按轮次升序返回，实际历史为 `failed`、`passed`，通过结论属于第二轮。

## 未完成项与边界

当前浏览器验证覆盖默认交付范围确认、不可变文本证据提交、逐项验收通过、验收失败关联问题后重提通过、默认交付结项/重开审计，以及新增批次持久化。结项按钮已在真实后端 E2E 场景验证，不再保留“未渲染”缺陷描述。

仍需补足浏览器证据：多批次排他承诺；范围 v1→v2 后旧待验收轮次失效；延期/豁免与后续责任去向；阻断处理和 owner 风险接受；客户确认字段与系统录入人区分；非验收负责人只读及角色权限边界。相关业务约束已有服务/API/组件测试，但不能据此将 S3.2–S3.4 或 AC-17–26 全部标记通过。

本批未提交、推送或发布。
