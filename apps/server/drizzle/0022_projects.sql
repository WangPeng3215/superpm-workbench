-- Project scope is authorized through active membership, not the author's user_id.
CREATE TABLE projects (
 id INTEGER PRIMARY KEY AUTOINCREMENT, project_no TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 goal TEXT NOT NULL DEFAULT '', scope_summary TEXT NOT NULL DEFAULT '',
 customer_name TEXT NOT NULL DEFAULT '', customer_contact TEXT NOT NULL DEFAULT '',
 planned_start_date TEXT, target_delivery_date TEXT,
 owner_user_id INTEGER NOT NULL REFERENCES users(id), product_owner_user_id INTEGER NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','active','awaiting_acceptance','closed','paused','cancelled')),
 previous_status TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), archived_at TEXT,
 created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE project_members (
 project_id INTEGER NOT NULL REFERENCES projects(id), user_id INTEGER NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed')), joined_at TEXT NOT NULL, removed_at TEXT,
 PRIMARY KEY(project_id,user_id)
);
CREATE TABLE project_member_roles (
 project_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('owner','product_owner','contributor','viewer')),
 PRIMARY KEY(project_id,user_id,role),
 FOREIGN KEY(project_id,user_id) REFERENCES project_members(project_id,user_id)
);
CREATE TABLE project_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
 action TEXT NOT NULL, actor_user_id INTEGER REFERENCES users(id), actor_name_snapshot TEXT NOT NULL,
 payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE project_commands (
 id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER REFERENCES projects(id), actor_user_id INTEGER NOT NULL REFERENCES users(id),
 command TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
 UNIQUE(actor_user_id,command,idempotency_key)
);
-- S1 creates the default planning container; delivery workflow is introduced in S3.
CREATE TABLE deliveries (
 id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
 is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)), status TEXT NOT NULL DEFAULT 'planning',
 version INTEGER NOT NULL DEFAULT 1, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX deliveries_default_idx ON deliveries(project_id) WHERE is_default=1;
ALTER TABLE requirements ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE requirements ADD COLUMN assignee_user_id INTEGER REFERENCES users(id);
ALTER TABLE requirements ADD COLUMN developer_user_id INTEGER REFERENCES users(id);
ALTER TABLE requirements ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '';
ALTER TABLE requirements ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE requirement_history ADD COLUMN actor_user_id INTEGER REFERENCES users(id);
ALTER TABLE requirement_audit ADD COLUMN actor_user_id INTEGER REFERENCES users(id);
ALTER TABLE issues ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE artifact_nodes ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE artifact_links ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE requirement_files ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX projects_archive_updated_idx ON projects(archived_at,updated_at,id);
CREATE INDEX project_members_user_status_idx ON project_members(user_id,status,project_id);
CREATE INDEX project_roles_project_role_idx ON project_member_roles(project_id,role,user_id);
CREATE INDEX project_events_cursor_idx ON project_events(project_id,id);
CREATE INDEX requirements_project_deleted_idx ON requirements(project_id,deleted_at,id);
CREATE INDEX requirements_project_parent_idx ON requirements(project_id,parent_id);
