-- 需求知识库：artifact_nodes 文件/目录索引 + artifact_links 外部链接（开发文档 4.1/4.2）
-- 数据库只存元数据索引，磁盘是文件存在性的依据；旧 requirement_files 体系保留不动

-- 1. 文件/目录索引：parent_id 为空表示需求根目录；relative_path 相对需求根目录、正斜杠分隔
CREATE TABLE artifact_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  parent_id INTEGER REFERENCES artifact_nodes(id),
  node_type TEXT NOT NULL,
  name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  extension TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  modified_at TEXT,
  indexed_at TEXT NOT NULL,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 同一需求内路径唯一，防止重复索引与同名覆盖
CREATE UNIQUE INDEX IF NOT EXISTS artifact_nodes_path_idx ON artifact_nodes(requirement_id, relative_path);
CREATE INDEX IF NOT EXISTS artifact_nodes_parent_idx ON artifact_nodes(requirement_id, parent_id);

-- 2. 外部链接：仅存 SQLite 记录，不在磁盘创建同名文件；folder_node_id 为空表示挂在需求根目录
CREATE TABLE artifact_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  folder_node_id INTEGER REFERENCES artifact_nodes(id),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifact_links_folder_idx ON artifact_links(requirement_id, folder_node_id);
