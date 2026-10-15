-- 阶段 2 迁移：requirement_files 扩展为 Asset 语义 + 问题管理三表
-- 详见 docs/data-model.md 与 docs/migration-plan.md

-- 1. requirement_files 新增 Asset 字段（全部带默认值或可空，旧 INSERT 语句天然兼容）
ALTER TABLE requirement_files ADD COLUMN resource_type TEXT NOT NULL DEFAULT 'file';
ALTER TABLE requirement_files ADD COLUMN storage_type TEXT NOT NULL DEFAULT 'local';
ALTER TABLE requirement_files ADD COLUMN relative_path TEXT;
ALTER TABLE requirement_files ADD COLUMN text_content TEXT;
ALTER TABLE requirement_files ADD COLUMN mime_type TEXT;
ALTER TABLE requirement_files ADD COLUMN description TEXT;
ALTER TABLE requirement_files ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE requirement_files ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;

-- 2. 存量测试数据一次性映射（空表时为空操作，幂等）
UPDATE requirement_files SET resource_type = kind;
UPDATE requirement_files SET storage_type = CASE resource_type WHEN 'link' THEN 'external' ELSE 'local' END;
UPDATE requirement_files SET status = CASE WHEN is_final = 1 THEN 'final' ELSE 'draft' END;

-- 3. Asset 查询索引
CREATE INDEX IF NOT EXISTS assets_scope_idx ON requirement_files(requirement_id, phase, status);

-- 4. 问题表
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

-- 5. 问题处理记录（追加式历史）
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

-- 6. 问题与产出物关联（同问题同产出物唯一；不级联删除物理文件）
CREATE TABLE issue_assets (
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  asset_id INTEGER NOT NULL REFERENCES requirement_files(id),
  relation_type TEXT NOT NULL DEFAULT 'reference',
  created_at TEXT NOT NULL,
  PRIMARY KEY (issue_id, asset_id)
);
CREATE INDEX IF NOT EXISTS issue_assets_asset_idx ON issue_assets(asset_id);
