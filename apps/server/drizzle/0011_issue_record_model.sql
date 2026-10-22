-- 问题记录模型（V1.0 文档）：阶段覆盖需求分析，类型/状态枚举重定义，解决方案保存 Markdown。
-- 1. phase 语义改为「产生阶段」，四阶段均可用；列名同步为 stage
ALTER TABLE issues RENAME COLUMN phase TO stage;

-- 2. 类型映射：0009 的 defect/change/question 归入新分类体系
UPDATE issues SET issue_type = CASE issue_type
  WHEN 'ui' THEN 'ui'
  WHEN 'development' THEN 'development'
  WHEN 'defect' THEN 'testing'
  WHEN 'change' THEN 'other'
  WHEN 'question' THEN 'other'
  ELSE NULL
END
WHERE issue_type IS NOT NULL;

-- 3. 状态映射：测试中并入处理中；遗留默认值 open 归为待分析
UPDATE issues SET status = 'pending' WHERE status IN ('open', '');
UPDATE issues SET status = 'processing' WHERE status = 'testing';
UPDATE issue_activities SET old_status = 'pending' WHERE old_status = 'open';
UPDATE issue_activities SET new_status = 'pending' WHERE new_status = 'open';
UPDATE issue_activities SET old_status = 'processing' WHERE old_status = 'testing';
UPDATE issue_activities SET new_status = 'processing' WHERE new_status = 'testing';

-- 4. 解决时间只属于已解决状态；暂不处理不是已解决
UPDATE issues SET resolved_at = NULL WHERE status != 'resolved';

-- 5. 列表默认按最近更新时间倒序
CREATE INDEX IF NOT EXISTS issues_requirement_updated_idx
  ON issues(requirement_id, updated_at DESC);
