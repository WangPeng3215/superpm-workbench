# 项目管理 V1：S3/S4 收尾验证

日期：2026-11-21（Asia/Shanghai）。分支：`codex/project-management-v1`。所有测试使用临时账号、SQLite 与工作区；没有修改正式业务数据或个人原型。

## 本轮修复

- 验收历史分别展示客户确认人、身份、时间、确认凭证、系统提交人和轮次处理人。失效轮次显示“范围修订人”，避免误称验收人。账号已不在成员列表时回退到账号 ID。
- 客户确认凭证新增 `GET /api/acceptance-rounds/:id/customer-confirmation/evidence`，读取提交时保存的文本/附件快照；项目读取权限每次重验，返回 `private, no-store`、`nosniff` 和下载响应。外部链接直接打开原地址，不声称具备不可变快照。
- 待验收时允许 owner 修订范围；历史轮次原子失效，迟到结果返回 `ACCEPTANCE_SUPERSEDED`，不能改变新范围。范围提示明确要求延期/豁免与后续去向。
- 范围操作改用 `canConfirmScope`；普通产品成员可准备交付，但没有确认或修订范围入口。服务端权限保持重验。
- 范围选择加载全部分页，展开两级叶子需求，解决子需求消失及超过 100 个根需求时遗漏的问题。新增浏览器用例实际创建 102 个根需求和 1 个子需求。
- 修复“提交验收后标记/解除阻断或接受风险导致永远版本冲突”。轮次提交版本继续作为不可变审计快照，写入使用当前交付版本 CAS；范围版本、失效状态、指定验收人校验保留。三条服务回归均先复现失败后通过，旧版本请求仍返回冲突。

本轮没有新增迁移，沿用 `0022`—`0027`。客户确认下载接口为只读扩展；没有新增 MCP 项目写入口。

## 实际检查

| 命令                                      | 结果                                 |
| ----------------------------------------- | ------------------------------------ |
| `npm run typecheck`                       | server、web、shared 通过             |
| `npm test`                                | 86 个文件，656 项通过                |
| `npm run build`                           | web、server 通过                     |
| S3/S4 定向 Playwright                     | auth 与 11 个业务用例，共 12 项通过  |
| 最终 `npm run test:e2e`                   | 127 项通过，0 失败，0 跳过，6.2 分钟 |
| `git -c core.safecrlf=false diff --check` | 通过                                 |

首轮完整 Playwright 为 123 项通过；之后增加权限、分页、加载状态等用例并修复审查发现的问题，最终结果以上表为准。Node 输出 `NO_COLOR`/`FORCE_COLOR` 环境提示，不是测试失败或跳过。

## AC-01—26 证据索引

“服务/API”表示真实业务服务或 Fastify 接口集成测试，“浏览器”表示真实后端 Playwright。不同条款采用适合其边界的检查层，不把单测描述为浏览器验收。以下服务测试路径均以 `apps/server/tests/` 为根，浏览器路径以 `tests/e2e/` 为根。

| 条款                           | 服务/API 或迁移证据                                                                                         | 浏览器及界面证据                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| AC-01 建项、编号、幂等         | `projects.test.ts`、`deliveries.test.ts`                                                                    | `projects.spec.ts`：名称建项、响应丢失重试                                                                         |
| AC-02 同项目协作、外人隔离     | `projects.test.ts`、`requirement-resource-api.test.ts`、`user-isolation.test.ts`                            | `project-collaboration.spec.ts`：三个普通账号                                                                      |
| AC-03 旧需求私有与整树共享     | `projects.test.ts`：预览过期、跨项目及作者校验                                                              | `projects.spec.ts`：先预览再确认共享                                                                               |
| AC-04 父子/资源 ID 边界        | `requirement-resource-access.test.ts`、`requirement-resource-api.test.ts`                                   | `projects.spec.ts`：固定项目作用域                                                                                 |
| AC-05 退出后的访问撤销         | `requirement-resource-api.test.ts`、`projects.test.ts`                                                      | `project-collaboration.spec.ts`：移除后清理详情                                                                    |
| AC-06 viewer 写入拒绝          | `requirement-resource-api.test.ts`、`requirement-resource-access.test.ts`                                   | `project-s4-states.spec.ts`：各页签只读                                                                            |
| AC-07 旧 MCP 拒绝项目域        | `projects-mcp.test.ts`：查询、prepare、execute 与公开 executor                                              | 无浏览器入口，使用 MCP/服务集成                                                                                    |
| AC-08 最后负责人并发移除       | `projects.test.ts`：并发与事务约束                                                                          | 使用服务并发测试                                                                                                   |
| AC-09 同版本冲突与保稿         | `projects.test.ts`、前端 `content-version`/`requirement-draft` 测试                                         | `projects.spec.ts`：409 与刷新恢复草稿                                                                             |
| AC-10 延迟 PATCH 后继续输入    | 前端 `versioned-autosave.test.ts`                                                                           | `projects.spec.ts`、`workbench.spec.ts`                                                                            |
| AC-11 引用解析、失败、重新鉴权 | 前端 `content-revision`/`resource-access` 测试                                                              | `project-collaboration.spec.ts`、`resource-drafts.spec.ts`                                                         |
| AC-12 后台/批量关签及退出      | 前端 `close-editing-sessions`/`editing-sessions` 测试                                                       | `workbench.spec.ts`、`auth-flow.spec.ts`                                                                           |
| AC-13 跨日个人安排             | `project-worklog.test.ts`：同日幂等与跨日                                                                   | `project-tasks.spec.ts`：固定业务时钟跨两天                                                                        |
| AC-14 任务退回重提与确认       | `project-tasks.test.ts`、`project-task-routes.test.ts`                                                      | `project-tasks.spec.ts`：执行人/确认人独立账号                                                                     |
| AC-15 计时配额与去重           | `daily-tasks.test.ts`、`user-isolation.test.ts`、`project-worklog.test.ts`                                  | `daily-tasks.spec.ts`、`project-tasks.spec.ts`                                                                     |
| AC-16 空范围与叶子统计         | `project-overview-service.test.ts`、`project-overview.test.ts`                                              | `project-overview.spec.ts`、`project-delivery-boundaries.spec.ts`                                                  |
| AC-17 默认交付、多批次排他     | `deliveries.test.ts`                                                                                        | `projects.spec.ts`、`project-delivery-boundaries.spec.ts`                                                          |
| AC-18 失败后新增验收轮次       | `deliveries.test.ts`、`delivery-closure-s3.test.ts`                                                         | `projects.spec.ts`：失败关联问题、重提通过                                                                         |
| AC-19 延期、豁免与责任去向     | `deliveries.test.ts`、前端 `project-delivery-acceptance.test.ts`                                            | `project-delivery-s3.spec.ts`：延期；`project-delivery-boundaries.spec.ts`：豁免及负责人/日期                      |
| AC-20 结项、重开与归档         | `delivery-closure-s3.test.ts`、`delivery-routes.test.ts`、`projects.test.ts`                                | `projects.spec.ts`：默认交付结项重开、取消归档                                                                     |
| AC-21 旧库/中间库升级          | `project-migrations-chain.test.ts`：从 0021—0026 逐级升级到 0027，重复执行与 FK 检查；各阶段 migration 测试 | 无真实安装库迁移；发布升级器另有阻断项                                                                             |
| AC-22 私人关联与项目资料       | `projects.test.ts`、`project-documents.test.ts`                                                             | `project-documents-s4.spec.ts`：明确确认会议复制、独立项目纪要                                                     |
| AC-23 viewer 降级与责任交接    | `projects.test.ts`：未完成责任、原子移交、过期回滚及审计失败回滚                                            | `project-collaboration.spec.ts`、`project-s4-states.spec.ts`                                                       |
| AC-24 待验收修订范围           | `deliveries.test.ts`：轮次失效及不可变快照                                                                  | `project-delivery-s3.spec.ts`：v2、v1 历史与迟到结果拒绝                                                           |
| AC-25 阻断与 owner 风险接受    | `delivery-closure-s3.test.ts`                                                                               | `project-delivery-s3.spec.ts`：owner 接受；`project-delivery-boundaries.spec.ts`：普通产品成员拒绝、阻断后合法验收 |
| AC-26 外部确认与真实操作者     | `delivery-closure-s3.test.ts`、`delivery-routes.test.ts`                                                    | `project-delivery-boundaries.spec.ts`：独立提交人/验收人、伪造 `submittedBy` 被拒、客户凭证读取                    |

## 界面与演示记录

概览加载、空态、长名称、1440×1000/800×1000/390×1000、请求失败重试及 viewer 页签均有浏览器检查。已实际查看手机概览及桌面验收审计截图，返回入口、文字和表格可用；没有整页横向溢出。

本地证据：

- [1440 概览](../../outputs/reviews/2026-11-21-project-management/overview-1440.png)
- [800 概览](../../outputs/reviews/2026-11-21-project-management/overview-800.png)
- [390 概览](../../outputs/reviews/2026-11-21-project-management/overview-390.png)
- [加载状态](../../outputs/reviews/2026-11-21-project-management/overview-loading.png)
- [普通账号交付审计](../../outputs/reviews/2026-11-21-project-management/delivery-audit.png)

可重复演示入口：先运行 `project-tasks.spec.ts` 观察独立账号的任务分配、退回重提、确认及跨日工时；再运行 `projects.spec.ts` 的失败重提和默认交付结项重开；最后运行 `project-delivery-boundaries.spec.ts` 观察普通产品成员提交、指定验收人完成、客户确认凭证与不同系统身份。全程使用临时数据。

## 发布边界

项目管理收尾审查未再发现本轮修复范围内的实质问题。随后已修复 BUG-001/002/005/006/007/011，最新证据与限制见[六项缺陷修复验证](2026-11-21-bug-backlog-validation.md)。更新器已通过进程身份、实际数据路径和回滚的隔离回归，尚未进行正式安装自动重启与健康检查演练。

以上为 S3/S4 开发收尾阶段记录。随后已取得提交推送新版本的授权，1.3.0 发布准备同步更新器 1.1.3 修复分发与最低版本门槛，完成正式包冒烟及八场景升级/回滚，见 [发布前验证](2026-11-21-release-1.3.0-validation.md)。没有运行部署或更新用户真实安装。原审查表的 12 项代码修复状态见[更新后的审查表](2026-11-19-bug-audit.md)。
