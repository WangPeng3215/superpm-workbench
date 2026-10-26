-- 便签：独立于每日任务的数据实体；归档与置顶互不影响，转任务只记录目标任务引用。
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'inspiration' CHECK (type IN ('inspiration', 'work_memo')),
  color TEXT NOT NULL DEFAULT 'yellow' CHECK (color IN ('yellow', 'pink', 'blue', 'green', 'purple', 'slate')),
  is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  converted_task_id INTEGER REFERENCES daily_tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
-- 便签页按归档状态取数，置顶优先、新建在前；编辑不改变卡片顺序，避免输入时跳动。
CREATE INDEX idx_notes_archived_pinned_created ON notes(is_archived, is_pinned DESC, created_at DESC);
CREATE INDEX idx_notes_converted_task ON notes(converted_task_id);
