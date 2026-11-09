-- 优化点正文合并：把「问题描述」与「优化思路」合成一份正文（纯文本投影 + 富文本 HTML），
-- 转换正式需求时直接作为需求详情使用。
-- 独立成 0019 而不是改写 0018：0018 已在本地库应用过，改写会让这些库缺列。
-- 采用重建表的方式，既完成「并入正文 + 去掉思路列」，也保持列顺序整洁。
CREATE TABLE optimization_points_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  module TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  description_html TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'evaluating', 'postponed', 'rejected', 'converted')),
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 存量数据：把优化思路并入正文末尾（正文为空时只保留思路），HTML 留空由编辑器按文本渲染
INSERT INTO optimization_points_new
  (id, name, module, description, description_html, remark, status, requirement_id, created_at, updated_at)
SELECT
  id,
  name,
  module,
  CASE
    WHEN solution = '' THEN description
    WHEN trim(description) = '' THEN solution
    ELSE description || char(10) || char(10) || '## 优化思路' || char(10) || char(10) || solution
  END,
  '',
  remark,
  status,
  requirement_id,
  created_at,
  updated_at
FROM optimization_points;

DROP TABLE optimization_points;
ALTER TABLE optimization_points_new RENAME TO optimization_points;

-- 索引随旧表一起删除，重建同样三条
CREATE INDEX idx_optimization_points_updated ON optimization_points(updated_at DESC, id DESC);
CREATE INDEX idx_optimization_points_status_updated ON optimization_points(status, updated_at DESC);
CREATE INDEX idx_optimization_points_requirement ON optimization_points(requirement_id);
