ALTER TABLE requirements ADD COLUMN description_html TEXT NOT NULL DEFAULT '';
CREATE TABLE requirement_workspaces (
  requirement_id INTEGER PRIMARY KEY REFERENCES requirements(id),
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
