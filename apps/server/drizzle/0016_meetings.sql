-- 会议记录：会议正文为 Tiptap 富文本 HTML，独立于需求描述与工作区 Markdown。
CREATE TABLE meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  meeting_type TEXT NOT NULL CHECK (meeting_type IN ('weekly', 'group', 'requirement', 'training')),
  meeting_time TEXT NOT NULL,
  content_html TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 列表默认按会议时间倒序，同一时间用 ID 稳定排序。
CREATE INDEX idx_meetings_time ON meetings(meeting_time DESC, id DESC);
CREATE INDEX idx_meetings_type_time ON meetings(meeting_type, meeting_time DESC);

-- 会议与需求多对多关联；需求为软删除，服务层在删除需求时同步清理关联。
CREATE TABLE meeting_requirements (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (meeting_id, requirement_id)
);
CREATE INDEX idx_meeting_requirements_requirement ON meeting_requirements(requirement_id);
