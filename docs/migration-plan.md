# superPM workbench 迁移方案（阶段 1 定稿）

- 版本：V1.0
- 前提：**现库数据均为测试数据，已获授权随意增删改**——迁移不为此设计存量兼容层，但迁移器本身的幂等与事务安全仍然保持。

## 1. 迁移内容：0005_assets_and_issues.sql

### 1.1 requirement_files 扩展（8 列）

```sql
ALTER TABLE requirement_files ADD COLUMN resource_type TEXT NOT NULL DEFAULT 'file';
ALTER TABLE requirement_files ADD COLUMN storage_type  TEXT NOT NULL DEFAULT 'local';
ALTER TABLE requirement_files ADD COLUMN relative_path TEXT;
ALTER TABLE requirement_files ADD COLUMN text_content  TEXT;
ALTER TABLE requirement_files ADD COLUMN mime_type     TEXT;
ALTER TABLE requirement_files ADD COLUMN description   TEXT;
ALTER TABLE requirement_files ADD COLUMN status        TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE requirement_files ADD COLUMN is_deleted    INTEGER NOT NULL DEFAULT 0;
```

### 1.2 测试数据一次性转换（可弃数据，简单 UPDATE 即可）

```sql
UPDATE requirement_files SET resource_type = kind;                       -- file/link 值域一致
UPDATE requirement_files SET storage_type =
  CASE resource_type WHEN 'link' THEN 'external' ELSE 'local' END;
UPDATE requirement_files SET status =
  CASE is_final WHEN 1 THEN 'final' ELSE 'draft' END;
```

（无数据时为空操作，幂等。）

### 1.3 新增索引

```sql
CREATE INDEX IF NOT EXISTS assets_scope_idx ON requirement_files(requirement_id, phase, status);
```

### 1.4 新建三表

```sql
CREATE TABLE issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  phase TEXT NOT NULL,
  issue_key TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  issue_type TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  solution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  closed_at TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS issues_scope_idx ON issues(requirement_id, phase, status);

CREATE TABLE issue_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  activity_type TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  old_status TEXT,
  new_status TEXT,
  actor_type TEXT,
  actor_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_issue_idx ON issue_activities(issue_id, created_at);

CREATE TABLE issue_assets (
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  asset_id INTEGER NOT NULL REFERENCES assets语义的 requirement_files(id),
  relation_type TEXT NOT NULL DEFAULT 'reference',
  created_at TEXT NOT NULL,
  PRIMARY KEY (issue_id, asset_id)
);
CREATE INDEX IF NOT EXISTS issue_assets_asset_idx ON issue_assets(asset_id);
```

（实际 SQL 中外键目标为 `requirement_files(id)`，上表注明语义。CHECK 约束不加在 DDL——值域校验统一放服务层 zod，与现有 requirement_files/requirements 表的做法一致。）

### 1.5 明确不做

- 不 DROP `kind` / `is_final` 列（保留至阶段 9 清理迁移；阶段 2 起服务层新代码不再写入 kind，is_final 由服务层按 status 派生双写以兼容现有面板）
- 不动 `requirement_workspaces`（旧工作台表与接口原样保留，阶段 9 评估）
- 不移动/不删除任何 workspace 磁盘文件
- 不回填 `relative_path`（惰性回填：阶段 3 服务层读取时为 NULL 则按旧规则推导并回写，见 data-model.md 2.5）

## 2. 执行与回滚

| 项 | 策略 |
|---|---|
| 执行方式 | 现有迁移器（migrate.ts）：按序号执行、事务包裹、schema_migrations 记录、幂等跳过 |
| 失败回滚 | 单个迁移整体在一个 `db.transaction()` 中，任一语句失败即全量回滚；SQLite DDL 可事务化，无半成品结构 |
| 数据备份 | 本期依赖「测试数据可弃」授权，不做迁移前快照；**引入真实数据前（阶段 9 或 MCP 上线前）**在 `db:migrate` CLI 中加文件级备份（复制 sqlite + wal/shm），届时单独确认 |
| 失败报告 | migrate() 抛错 → createApp 中止启动并向上抛出，符合"迁移失败时明确报告" |
| SCHEMA_VERSION | 4 → 5（手工常量，纳入阶段 2 检查清单） |

## 3. 迁移后校验（阶段 2 测试计划）

1. **新库初始化**：临时目录建库 → migrate → `schema_migrations` 含 1-5 全部版本；issues/issue_activities/issue_assets 存在；requirement_files 含 8 个新列
2. **已有库升级**：先用 0001-0004 建库并插入样例行 → migrate → 样例行 resource_type/status 正确映射、行数不变
3. **重复执行**：二次 migrate 零变更（迁移器 applied 集合跳过）
4. **约束与索引生效**：sqlite_master 查询 4 个新索引；issue_assets 主键冲突插入被拒（SQLITE_CONSTRAINT）
5. **外键生效**：向 issues 插入不存在 requirement_id → 报外键错误（连接 PRAGMA 已开启）
6. **迁移失败可恢复**：构造非法 SQL 的临时迁移文件 → migrate 抛错 → 库内容与迁移前一致（事务回滚验证）

## 4. 各阶段服务层切换顺序（保证旧功能不中断）

| 阶段 | 动作 | 旧功能状态 |
|---|---|---|
| 2 | 仅加列建表；服务层零改动 | 完全正常（旧列/旧 SQL 不受影响） |
| 3 | Asset 服务改造：新列读写、resource_type 取代 kind、isFinal 只读投影（= status==='final'）、惰性回填 relative_path、软删除、missing 检测 | API 形状兼容现有面板；e2e 11 条断言 isFinal/fileName 不变 |
| 4 | Issue 服务新建（纯新增路由与表） | 无影响 |
| 5 | issue_assets 关联服务（纯新增） | 无影响 |
| 6-8 | UI 接入新服务；进展页重做 | 阶段 6 完成后旧面板退役，isFinal 投影可移除 |
| 9 | 清理迁移 0006：DROP kind/is_final（数据可弃已授权）；旧工作台处置决策；全量回归 | — |

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| ALTER TABLE 后旧服务 INSERT 缺新列默认值 | 新列均带 DEFAULT 或 NULL，旧 INSERT 语句天然兼容 |
| relative_path 惰性回填时文件已被手工移动 | 回填推导失败 → 标记 status='missing' 并报告，不删行 |
| is_final 与 status 双写不一致 | 服务层唯一写入口统一维护（写 status 时同步 is_final 投影），禁止旁路 UPDATE |
| 测试数据授权边界 | 授权仅限本库数据；workspace 磁盘文件仍按"不擅自删除"原则处理，清理仅发生在显式确认的清理迁移 |
