-- 优化点：主动发现的产品优化机会，独立于正式需求。
-- 先轻量记录、再评估筛选，评估通过后转为正式需求；只维护当前状态，不记录状态变更历史。
CREATE TABLE optimization_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  -- 所属模块为手工填写的自由文本，允许为空，不建立模块字典
  module TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  solution TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'evaluating', 'postponed', 'rejected', 'converted')),
  -- 关联的正式需求：一个优化点最多关联一个需求，但允许多个优化点归并到同一需求，
  -- 因此只建索引、不加唯一约束。需求为软删除，服务层在删除需求时清空该关联。
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 列表默认按更新时间倒序，同一时间用 ID 稳定排序。
CREATE INDEX idx_optimization_points_updated ON optimization_points(updated_at DESC, id DESC);
-- 按状态筛选时仍保持更新时间倒序。
CREATE INDEX idx_optimization_points_status_updated ON optimization_points(status, updated_at DESC);
-- 正式需求详情反查来源优化点。
CREATE INDEX idx_optimization_points_requirement ON optimization_points(requirement_id);
