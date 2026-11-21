-- S4.2: 项目级笔记、决策、会议快照与外部链接。
CREATE TABLE project_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK(kind IN ('note','decision','meeting','link')),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  content TEXT NOT NULL DEFAULT '',
  url TEXT,
  meeting_time TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(kind <> 'link' OR (url IS NOT NULL AND length(trim(url)) > 0)),
  CHECK(kind = 'link' OR url IS NULL),
  CHECK(kind = 'meeting' OR meeting_time IS NULL)
);
CREATE INDEX project_documents_project_idx
  ON project_documents(project_id, updated_at DESC, id DESC);
CREATE INDEX project_documents_kind_idx
  ON project_documents(project_id, kind, id DESC);
