# 多用户注册与个人数据隔离

V1.0 的范围是「一个人在自己电脑上用」，账号体系只是入口，数据没有归属。
本次改造补上两件事：**注册 / 登录 / 退出 / 身份识别**，以及**个人数据隔离**——
换一个账号登录，看到的就是一套空工作台；拿别人的 ID 直接打接口，后端一律拒绝。

本文记录设计取舍、迁移内容、隔离规则与越权测试清单。相关代码：

| 位置                                           | 作用                                          |
| ---------------------------------------------- | --------------------------------------------- |
| `apps/server/drizzle/0020_user_isolation.sql`  | 归属列、索引、唯一约束调整、存量回填          |
| `apps/server/src/db/scope.ts`                  | 用户作用域（AsyncLocalStorage）与隔离语句改写 |
| `apps/server/src/services/auth.ts`             | 注册、登录、账号状态、超管标记                |
| `apps/server/src/app.ts`                       | 请求入口建立作用域；`/api/auth/*` 路由        |
| `apps/server/src/repositories/requirements.ts` | drizzle 仓储的显式归属条件                    |
| `apps/web/src/pages/LoginPage.vue`             | 登录 / 注册同屏切换                           |

---

## 1. 范围

**本期实现**

- 注册（自助）、登录、退出、`/api/auth/me` 身份识别。
- 每个账号的数据互不可见、互不可改、互不可下载。
- `admin` / `admin123` 保留为超管账号，可查看全部用户数据。
- 账号启用 / 停用（`users.status`），停用后无法登录，已签发的会话立即失效。

**本期不做**

- 组织、项目、成员邀请、角色管理与细粒度 RBAC（留待后续版本）。
- 账号自助注销、找回密码（当前由超管在数据库层处理）。

---

## 2. 数据模型

### 2.1 账号表

```sql
ALTER TABLE users ADD COLUMN status   TEXT    NOT NULL DEFAULT 'active';  -- active | disabled
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;         -- 1 = 超管
UPDATE users SET is_admin = 1 WHERE username = 'admin';
```

### 2.2 业务表

22 张业务表统一增加 `user_id INTEGER NOT NULL DEFAULT 0`：

`requirements`、`requirement_history`、`requirement_audit`、`requirement_workspaces`、
`requirement_files`、`requirement_directories`、`issues`、`issue_activities`、`issue_assets`、
`artifact_nodes`、`artifact_links`、`issue_artifact_links`、`daily_tasks`、`daily_time_entries`、
`daily_time_entry_audits`、`meetings`、`meeting_requirements`、`notes`、`optimization_points`、
`online_tools`、`mcp_write_confirmations`、`mcp_audit`。

`users`、`app_meta`、`schema_migrations` 是系统表，不隔离。

存量数据全部回填给 `admin`（历史安装只有这一个账号，归属没有歧义）：

```sql
UPDATE requirements SET user_id = COALESCE((SELECT id FROM users WHERE username='admin'), 0) WHERE user_id = 0;
-- 其余业务表同构
```

### 2.3 两处「全局唯一」必须改成「按用户唯一」

| 约束                          | 改造前                  | 改造后              | 原因                                           |
| ----------------------------- | ----------------------- | ------------------- | ---------------------------------------------- |
| `daily_time_entries` 活动计时 | 全实例只允许一条 active | 每个用户一条 active | 否则第二个用户点「开始计时」直接被唯一索引拦住 |
| `online_tools.name`           | 全局同名唯一            | 同用户内同名唯一    | 否则先建者独占名称，别人无法建同名工具         |

`requirement_no`（`REQ-0001`）保持全局唯一：编号即目录名，全局唯一让物理目录天然不冲突，
代价是**编号序列在不同账号之间共享**（B 的第一个需求可能叫 `REQ-0003`）。这不算数据泄露，
换来的是不需要给存量数据重排编号、也不需要搬迁磁盘目录。

---

## 3. 隔离怎么落地

### 3.1 请求作用域

`POST /api/auth/login` 之外的所有 `/api/*` 请求，都会在 `onRequest` 钩子里完成三件事：

1. 解析 Cookie 中的会话 Token（HMAC 校验 + 有效期）。
2. 按 Token 里的用户 ID 重新读库，确认账号存在且 `status='active'`（停用立即生效）。
3. 在 `runAsUser({ userId, isAdmin })` 里调用 `done()`，把作用域挂在整条请求链上。

```ts
runAsUser({ userId: user.id, isAdmin: user.isAdmin }, () => done());
```

`done()` 在作用域内触发，后续所有处理函数都在同一个异步上下文里，
于是业务 SQL 无论写在哪个 Service、哪一层，都能读到「当前是谁」。

### 3.2 数据库代理：默认加隔离，改不了就报错

`createScopedDatabase(db)` 包住 better-sqlite3 连接，`prepare()` 出来的语句在**执行时**按当前作用域改写：

| 语句                                            | 改写                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `SELECT … FROM t [WHERE …] [GROUP/ORDER/LIMIT]` | 在子句前插入 `AND user_id = ?`（无 WHERE 则 `WHERE user_id = ?`） |
| `UPDATE t SET … WHERE …`                        | 末尾追加 `AND user_id = ?`                                        |
| `DELETE FROM t WHERE …`                         | 末尾追加 `AND user_id = ?`                                        |
| `INSERT INTO t(cols) VALUES (…)`                | 列里补 `user_id`，值里补 `?`                                      |

关键点是**参数位置而不是简单追加**：改写器会数出注入点之前有多少个 `?`，
把归属值插进参数数组的同一位置，因此 `WHERE a=? ORDER BY x LIMIT ?` 这类语句不会错位。

无法安全改写的语句直接抛 `ScopeError`，而不是放过：

- 一条语句涉及两张以上业务表（JOIN / 关联子查询）；
- `FROM (子查询)`、`INSERT … SELECT`；
- `INSERT` 没有显式列名；
- 使用命名参数（`:name` / `@name`）。

这样「漏改某个接口」不会变成越权，而是立刻 500，测试与联调期间必然暴露。

### 3.3 例外：手写归属的多表语句

全仓只有 8 条 JOIN 语句（每日任务关联需求、便签关联目标任务、会议关联需求、
优化点关联需求、问题关联产出物、活动计时关联任务）。它们无法自动改写，
因此**显式书写**归属条件，并把作用域取值收敛到 `ownerFilterSql(alias)`：

```ts
const owner = ownerFilterSql("t");
this.db
  .prepare(
    `
  SELECT t.*, r.requirement_no, r.name AS requirement_name
  FROM daily_tasks t
  LEFT JOIN requirements r ON r.id = t.requirement_id AND r.user_id = t.user_id
  WHERE t.plan_date = ? AND t.deleted_at IS NULL${owner.sql}
`,
  )
  .all(date, ...owner.params);
```

两个细节：

- 联表条件带 `r.user_id = t.user_id`，即使脏数据把外键指向别人的行，也关联不出内容。
- 驱动表的过滤条件仍然走 `ownerFilterSql`，因此普通账号只看得到自己的行。

### 3.4 例外：drizzle 仓储

`RequirementsRepository` 由 drizzle 生成 SQL 并自带参数绑定（匿名参数以对象形式传入），
无法被代理安全改写，因此在仓储内部**显式**带条件（`ownerFilter()` / `ownerValue()`）。
超管与系统身份返回 `undefined`，等价于不加过滤。

### 3.5 三类身份

| 身份                 | 触发场景                                    | 读           | 写                             |
| -------------------- | ------------------------------------------- | ------------ | ------------------------------ |
| 普通账号             | HTTP 请求                                   | 只有自己的行 | 只能改自己的行；新行归属本人   |
| 超管（`is_admin=1`） | HTTP 请求                                   | 全部用户的行 | 可改任意行；新行归属超管自己   |
| 系统身份             | 迁移、种子、定时补偿、MCP、命令行、单元测试 | 全库         | 新行 `user_id=0`（仅超管可见） |

系统身份刻意不做隔离：MCP 是 stdio 本机通道，命令行工具是运维入口，
它们等价于「能直接打开数据库文件的人」。**HTTP 入口永远不会落在系统身份上**：
所有 `/api/*` 要么带作用域，要么在钩子里被 401 拦掉。

---

## 4. 接口

| 接口                             | 说明                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/config`           | 公开。`{ registrationEnabled }`，登录页据此决定是否显示注册入口                                                  |
| `POST /api/auth/register`        | 公开。`{ username, password, displayName? }` → 201 并直接写入会话 Cookie；关闭注册时 403 `REGISTRATION_DISABLED` |
| `POST /api/auth/login`           | 公开。账号或密码错误 401；账号停用 403 `ACCOUNT_DISABLED`                                                        |
| `GET /api/auth/me`               | 需登录。`{ id, username, displayName, isAdmin }`                                                                 |
| `POST /api/auth/change-password` | 需登录。只能改自己的密码                                                                                         |
| `POST /api/auth/logout`          | 清除会话 Cookie                                                                                                  |

注册校验：账号 3-32 位 `[A-Za-z0-9_-]`、密码至少 6 位、账号不可重复、`admin` 为保留名。

环境变量：

| 变量                         | 默认       | 说明                                             |
| ---------------------------- | ---------- | ------------------------------------------------ |
| `SUPERPM_ADMIN_PASSWORD`     | `admin123` | 首启创建 `admin` 时使用的口令；少于 6 位拒绝启动 |
| `SUPERPM_ALLOW_REGISTRATION` | `on`       | `off` / `false` / `0` / `no` 时关闭自助注册      |

---

## 5. 升级与迁移

- 迁移文件：`apps/server/drizzle/0020_user_isolation.sql`，`SCHEMA_VERSION` 由 19 升到 20。
- 服务启动时自动应用，无需手工执行；升级前后数据结构差异见上表。
- 存量数据在迁移里一次性回填给 `admin`，**升级后旧数据仍由 `admin` 登录可见**。
- 回滚：迁移只做「加列 + 加索引 + 换两个唯一索引 + 回填」，不删表不删列；
  如需回退到旧版本，旧的 `idx_daily_time_entries_active`（全实例唯一）需要手工重建：

  ```sql
  DROP INDEX IF EXISTS idx_daily_time_entries_active;
  CREATE UNIQUE INDEX idx_daily_time_entries_active ON daily_time_entries(status) WHERE status = 'active';
  ```

  旧版本不读 `user_id`，会看到所有用户的行——这正是回退的风险，回退后请只保留一个账号使用。

验证迁移：

```bash
# schema 版本应为 20
curl -s http://127.0.0.1:3001/api/health
# 归属列与索引
sqlite3 /var/lib/superpm/data/superpm.db ".schema requirements" | grep user_id
```

---

## 6. 安全边界与已知取舍

1. **物理文件没有按用户分目录**。工作区仍是一份 `requirements/REQ-xxxx 名称/`。
   理由是文件访问全部经数据库行（产物、文档、图片都先按 ID 查归属，再落盘读），
   而 `requirement_no` 全局唯一，目录名跨账号不冲突；按用户拆目录需要搬迁存量文件，
   收益不抵风险。**注意**：直接看磁盘文件的人能看到所有账号的文件，这与「能打开数据库文件」同级。
2. **图片不再匿名可读**。编辑器里 `<img src="/api/requirements/:id/images/...">` 以前是公开路径，
   现在必须带会话 Cookie 且需求归属本人（浏览器同源请求会自动带 Cookie）。
3. **超管可见全部数据**，包括将来新增的账号。若只想要「彼此隔离、无人可跨」，把 `users.is_admin` 全部置 0 即可。
4. **注册默认开放**。公网部署请评估是否需要 `SUPERPM_ALLOW_REGISTRATION=off`。
5. **删除需求不级联删除别人的关联**：跨用户的外键关系在建表时就不允许产生，
   隔离条件保证删除、清理都只影响自己的行。

---

## 7. 越权测试清单与结果

自动化用例：`apps/server/tests/user-isolation.test.ts`（10 例）、
`apps/server/tests/auth-registration.test.ts`（3 例）、`apps/server/tests/scope.test.ts`（15 例），
以及 `apps/server/tests/migrations.test.ts` 中「从 1.0.1 的库升级到 0020」的回归用例，
外加浏览器端 `tests/e2e/auth-flow.spec.ts` 的注册两例。

测试方式统一是「**拿 A 的真实 ID，用 B 的会话打接口**」，不看前端列表是否显示。

| 场景                                                                               | 断言                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------------- |
| B 列需求                                                                           | `items` 为空                              |
| B 读 A 需求 / 历史 / 关联 / 文件 / 问题 / 文档 / 工作区 / 记忆 / 目录 / 反查优化点 | 全部 404                                  |
| B 改 A 需求、存工作区、建问题、建目录、删需求                                      | 全部 404，且 A 的数据名称、问题数保持不变 |
| B 列/改/计时 A 的每日任务                                                          | 列表为空；PATCH 与 start 均 404           |
| B 列/改/删 A 的便签、会议、优化点、工具                                            | 列表为空；单条读写删均 404                |
| B 建与 A 同名工具                                                                  | 201（名称冲突不再跨用户）                 |
| A、B 同时开始计时                                                                  | 各自 200，互不打断                        |
| 未登录读图片                                                                       | 401                                       |
| B 读 A 的图片                                                                      | 404                                       |
| 超管读需求列表                                                                     | 看到全部用户的行                          |
| 注册重复账号 / 保留名 / 短密码                                                     | 409 / 409 / 400                           |
| 关闭注册后注册                                                                     | 403 `REGISTRATION_DISABLED`               |
| 停用账号登录 + 旧 Cookie                                                           | 403 `ACCOUNT_DISABLED` + 401              |

结果（本机 Windows，Node 22）：

- `npm run typecheck`：通过。
- `npx vitest run`：**39 个文件 / 416 例全部通过**（含上述 28 例新增隔离与认证用例、1 例升级回归）。
- `npm run test:e2e`：**72 例全部通过**（新增「注册新账号后进入独立工作台」「注册时两次密码不一致会本地拦截」）。

---

## 8. 新增业务表时要做的事

1. 建表 SQL 加 `user_id INTEGER NOT NULL DEFAULT 0` 与索引。
2. 把表名加入 `apps/server/src/db/scope.ts` 的 `SCOPED_TABLES`。
3. 若使用 JOIN / 子查询，按 §3.3 显式写 `ownerFilterSql`；否则代理会自动处理。
4. 在 `apps/server/tests/user-isolation.test.ts` 补一条「拿别人的 ID 打接口」的用例。
