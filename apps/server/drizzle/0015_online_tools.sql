-- 在线工具箱：工具主数据与快捷入口配置；启停与收藏相互独立，排序仅用于快捷弹窗。
CREATE TABLE online_tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  icon TEXT,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 唯一索引兜底名称去重（服务层先校验并返回可读错误）。
CREATE UNIQUE INDEX idx_online_tools_name ON online_tools(name);
CREATE INDEX idx_online_tools_favorite ON online_tools(is_favorite, sort_order);
