-- 需求物理目录映射与初始化状态（V1.1 开发文档 §12.2 / §12.5）
-- 物理根目录名采用「需求编号 + 空格 + 需求名称」，但数据库始终以需求 ID 关联，
-- 目录名变更不会造成关联丢失；初始化失败时记录阶段与原因，允许重试。

CREATE TABLE requirement_directories (
  requirement_id INTEGER PRIMARY KEY REFERENCES requirements(id),
  -- 物理根目录名（可读形式，如 "REQ-0001 superPM项目启动"）
  directory_name TEXT NOT NULL,
  -- 相对工作区根目录的路径，正斜杠分隔，如 "requirements/REQ-0001 superPM项目启动"
  relative_path TEXT NOT NULL,
  -- pending 待初始化 / completed 已初始化 / failed 初始化失败
  status TEXT NOT NULL DEFAULT 'pending',
  -- 失败阶段：resolve / create-directory / memory / folders / index
  failure_stage TEXT,
  failure_reason TEXT,
  initialized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS requirement_directories_path_idx
  ON requirement_directories(relative_path);
