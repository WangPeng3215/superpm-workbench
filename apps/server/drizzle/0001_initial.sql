CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requirements (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 requirement_no TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 type TEXT NOT NULL,
 priority TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL,
 current_stage TEXT NOT NULL,
 parent_id INTEGER REFERENCES requirements(id),
 proposed_at TEXT NOT NULL,
 expected_at TEXT,
 started_at TEXT,
 completed_at TEXT,
 planned_release_at TEXT,
 released_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS requirements_parent_idx ON requirements(parent_id);
CREATE TABLE IF NOT EXISTS requirement_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 requirement_id INTEGER NOT NULL REFERENCES requirements(id),
 from_stage TEXT NOT NULL,
 to_stage TEXT NOT NULL,
 actor TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requirement_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 requirement_id INTEGER NOT NULL REFERENCES requirements(id),
 action TEXT NOT NULL,
 payload TEXT NOT NULL,
 created_at TEXT NOT NULL
);
