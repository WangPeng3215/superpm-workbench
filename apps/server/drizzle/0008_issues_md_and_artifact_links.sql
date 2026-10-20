-- 问题正文富文本化 + 问题关联切换到 artifacts 体系
-- 1. issues 增加 description_html 列：富文本正文（html），与既有 description 纯文本双写同步
ALTER TABLE issues ADD COLUMN description_html TEXT NOT NULL DEFAULT '';

-- 2. 存量枚举映射（测试库允许近似映射；空表时为空操作，可重复执行）
--    状态：closed 已退役 → resolved（解决时间缺失时以更新时间兜底）
UPDATE issues SET status = 'resolved', resolved_at = COALESCE(resolved_at, updated_at) WHERE status = 'closed';
--    分类：design→ui、bug→defect（development/change/question 取值不变）
UPDATE issues SET issue_type = 'ui' WHERE issue_type = 'design';
UPDATE issues SET issue_type = 'defect' WHERE issue_type = 'bug';

-- 3. 问题-产出物关联（artifacts 体系）：文件夹与文件均可关联；
--    artifact_nodes 为硬删除，节点移除时关联行级联清理（外键级联，运行时 foreign_keys=ON）
CREATE TABLE issue_artifact_links (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  artifact_id INTEGER NOT NULL REFERENCES artifact_nodes(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'reference',
  created_at TEXT NOT NULL,
  PRIMARY KEY (issue_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS issue_artifact_links_artifact_idx ON issue_artifact_links(artifact_id);

-- 旧 issue_assets 表保留不删（遗留清理批次统一处理），业务读写已全部切换到 issue_artifact_links
