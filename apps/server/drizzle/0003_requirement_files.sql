CREATE TABLE IF NOT EXISTS requirement_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  phase TEXT NOT NULL,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  is_final INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requirement_files_scope_idx ON requirement_files(requirement_id, phase, category);
