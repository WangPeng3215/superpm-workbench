CREATE TABLE project_tasks (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 project_id INTEGER NOT NULL REFERENCES projects(id),
 requirement_id INTEGER REFERENCES requirements(id),
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
 description TEXT NOT NULL DEFAULT '',
 type TEXT NOT NULL CHECK(type IN ('design','development','testing','deployment','other')),
 assignee_user_id INTEGER NOT NULL REFERENCES users(id),
 confirmer_user_id INTEGER NOT NULL REFERENCES users(id),
 due_date TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','pending_confirmation','completed','blocked','cancelled')),
 previous_status TEXT CHECK(previous_status IN ('pending','in_progress')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX project_tasks_project_status_idx ON project_tasks(project_id,status,id);
CREATE INDEX project_tasks_assignee_idx ON project_tasks(project_id,assignee_user_id,status,id);
CREATE INDEX project_tasks_confirmer_idx ON project_tasks(project_id,confirmer_user_id,status,id);
CREATE INDEX project_tasks_requirement_idx ON project_tasks(project_id,requirement_id,status,id);

CREATE TABLE project_task_submissions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id INTEGER NOT NULL REFERENCES project_tasks(id),
 submitted_by INTEGER NOT NULL REFERENCES users(id),
 summary TEXT NOT NULL DEFAULT '',
 evidence_json TEXT NOT NULL DEFAULT '[]',
 created_at TEXT NOT NULL
);
CREATE INDEX project_task_submissions_task_idx ON project_task_submissions(task_id,id);
CREATE TABLE project_task_reviews (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 submission_id INTEGER NOT NULL UNIQUE REFERENCES project_task_submissions(id),
 reviewer_user_id INTEGER NOT NULL REFERENCES users(id),
 result TEXT NOT NULL CHECK(result IN ('approved','returned')),
 reason TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);
CREATE TABLE project_task_actions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id INTEGER NOT NULL REFERENCES project_tasks(id),
 action TEXT NOT NULL CHECK(action IN ('created','edit','start','block','resume','submit','approve','return','cancel','reopen')),
 actor_user_id INTEGER NOT NULL REFERENCES users(id),
 actor_name_snapshot TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '',
 payload_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL
);
CREATE INDEX project_task_actions_task_idx ON project_task_actions(task_id,id);

CREATE TRIGGER project_task_submissions_no_update BEFORE UPDATE ON project_task_submissions BEGIN SELECT RAISE(ABORT,'project task submissions are immutable'); END;
CREATE TRIGGER project_task_submissions_no_delete BEFORE DELETE ON project_task_submissions BEGIN SELECT RAISE(ABORT,'project task submissions are immutable'); END;
CREATE TRIGGER project_task_reviews_no_update BEFORE UPDATE ON project_task_reviews BEGIN SELECT RAISE(ABORT,'project task reviews are immutable'); END;
CREATE TRIGGER project_task_reviews_no_delete BEFORE DELETE ON project_task_reviews BEGIN SELECT RAISE(ABORT,'project task reviews are immutable'); END;
CREATE TRIGGER project_task_actions_no_update BEFORE UPDATE ON project_task_actions BEGIN SELECT RAISE(ABORT,'project task actions are immutable'); END;
CREATE TRIGGER project_task_actions_no_delete BEFORE DELETE ON project_task_actions BEGIN SELECT RAISE(ABORT,'project task actions are immutable'); END;

ALTER TABLE daily_tasks ADD COLUMN project_task_id INTEGER REFERENCES project_tasks(id);
ALTER TABLE daily_time_entries ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE daily_time_entries ADD COLUMN project_task_id INTEGER REFERENCES project_tasks(id);
CREATE UNIQUE INDEX daily_tasks_project_task_plan_idx ON daily_tasks(user_id,project_task_id,plan_date) WHERE project_task_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX daily_time_entries_project_idx ON daily_time_entries(project_id,project_task_id,started_at,id);
