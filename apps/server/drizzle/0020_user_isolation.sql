-- 用户隔离：单库 + user_id 列方案（开发文档 §3）
-- 约定：
-- 1) 所有业务表增加 user_id，行归属不可变；服务层通过作用域代理自动追加隔离条件。
-- 2) 存量数据全部回填给 admin（历史安装只有 admin 一个账号，归属不会产生歧义）。
-- 3) 系统级表（users / app_meta / schema_migrations）不隔离。
-- 4) 外键关系与唯一约束保持原语义，仅把「全局唯一」的两处改为「按用户唯一」。

-- 1. 账号表：新增启用状态与超管标记
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
UPDATE users SET is_admin = 1 WHERE username = 'admin';

-- 2. 业务表增加归属列。DEFAULT 0 让系统路径（MCP / CLI / 定时补偿）的旧语句仍然可写，
--    代价是这些行只对超管可见，属于刻意保留的兼容行为。
ALTER TABLE requirements ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requirement_history ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requirement_audit ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requirement_workspaces ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requirement_files ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requirement_directories ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE issues ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE issue_activities ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE issue_assets ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artifact_nodes ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artifact_links ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE issue_artifact_links ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_tasks ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_time_entries ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_time_entry_audits ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meetings ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meeting_requirements ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE optimization_points ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE online_tools ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mcp_write_confirmations ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;

-- 3. 存量数据回填给 admin；新装环境此处无数据，回填为空操作
UPDATE requirements SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE requirement_history SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE requirement_audit SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE requirement_workspaces SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE requirement_files SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE requirement_directories SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE issues SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE issue_activities SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE issue_assets SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE artifact_nodes SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE artifact_links SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE issue_artifact_links SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE daily_tasks SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE daily_time_entries SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE daily_time_entry_audits SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE meetings SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE meeting_requirements SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE notes SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE optimization_points SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE online_tools SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE mcp_write_confirmations SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;
UPDATE mcp_audit SET user_id = COALESCE((SELECT id FROM users WHERE username = 'admin'), 0) WHERE user_id = 0;

-- 4. 隔离查询索引：统一单列 index，热表再补组合索引
CREATE INDEX IF NOT EXISTS requirements_user_idx ON requirements(user_id);
CREATE INDEX IF NOT EXISTS requirements_user_deleted_idx ON requirements(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS requirement_history_user_idx ON requirement_history(user_id, requirement_id);
CREATE INDEX IF NOT EXISTS requirement_audit_user_idx ON requirement_audit(user_id, requirement_id);
CREATE INDEX IF NOT EXISTS requirement_workspaces_user_idx ON requirement_workspaces(user_id);
CREATE INDEX IF NOT EXISTS requirement_files_user_idx ON requirement_files(user_id, requirement_id);
CREATE INDEX IF NOT EXISTS requirement_directories_user_idx ON requirement_directories(user_id);
CREATE INDEX IF NOT EXISTS issues_user_idx ON issues(user_id, requirement_id);
CREATE INDEX IF NOT EXISTS issue_activities_user_idx ON issue_activities(user_id, issue_id);
CREATE INDEX IF NOT EXISTS issue_assets_user_idx ON issue_assets(user_id);
CREATE INDEX IF NOT EXISTS artifact_nodes_user_idx ON artifact_nodes(user_id, requirement_id);
CREATE INDEX IF NOT EXISTS artifact_links_user_idx ON artifact_links(user_id, requirement_id);
CREATE INDEX IF NOT EXISTS issue_artifact_links_user_idx ON issue_artifact_links(user_id);
CREATE INDEX IF NOT EXISTS daily_tasks_user_idx ON daily_tasks(user_id, plan_date);
CREATE INDEX IF NOT EXISTS daily_time_entries_user_idx ON daily_time_entries(user_id, started_at);
CREATE INDEX IF NOT EXISTS daily_time_entry_audits_user_idx ON daily_time_entry_audits(user_id, entry_id);
CREATE INDEX IF NOT EXISTS meetings_user_idx ON meetings(user_id, meeting_time DESC);
CREATE INDEX IF NOT EXISTS meeting_requirements_user_idx ON meeting_requirements(user_id);
CREATE INDEX IF NOT EXISTS notes_user_idx ON notes(user_id, is_archived, is_pinned DESC);
CREATE INDEX IF NOT EXISTS optimization_points_user_idx ON optimization_points(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS online_tools_user_idx ON online_tools(user_id);
CREATE INDEX IF NOT EXISTS mcp_write_confirmations_user_idx ON mcp_write_confirmations(user_id);
CREATE INDEX IF NOT EXISTS mcp_audit_user_idx ON mcp_audit(user_id);

-- 5. 全局唯一约束改为按用户唯一
--    5.1 计时器：原「全实例只允许一条 active」在多用户下会让第二个用户的计时直接失败
DROP INDEX IF EXISTS idx_daily_time_entries_active;
CREATE UNIQUE INDEX idx_daily_time_entries_active ON daily_time_entries(user_id) WHERE status = 'active';

--    5.2 工具箱：同名工具原本全局唯一，多用户时由先建者独占名称
DROP INDEX IF EXISTS idx_online_tools_name;
CREATE UNIQUE INDEX idx_online_tools_name ON online_tools(user_id, name);
