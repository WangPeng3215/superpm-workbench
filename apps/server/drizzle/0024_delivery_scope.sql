ALTER TABLE deliveries ADD COLUMN planned_delivery_date TEXT;
ALTER TABLE deliveries ADD COLUMN actual_delivery_date TEXT;
ALTER TABLE deliveries ADD COLUMN acceptance_owner_user_id INTEGER REFERENCES users(id);
ALTER TABLE deliveries ADD COLUMN description TEXT NOT NULL DEFAULT '';

CREATE TABLE delivery_scope_versions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
 scope_version INTEGER NOT NULL CHECK(scope_version > 0),
 confirmed_by INTEGER NOT NULL REFERENCES users(id),
 confirmed_at TEXT NOT NULL,
 change_reason TEXT NOT NULL DEFAULT '',
 UNIQUE(delivery_id, scope_version)
);
CREATE INDEX delivery_scope_versions_delivery_idx
 ON delivery_scope_versions(delivery_id, scope_version DESC);
ALTER TABLE deliveries ADD COLUMN current_scope_version_id INTEGER REFERENCES delivery_scope_versions(id);

CREATE TABLE delivery_scope_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 scope_version_id INTEGER NOT NULL REFERENCES delivery_scope_versions(id),
 requirement_id INTEGER NOT NULL REFERENCES requirements(id),
 requirement_no TEXT NOT NULL,
 requirement_name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 description_html TEXT NOT NULL DEFAULT '',
 acceptance_criteria TEXT NOT NULL DEFAULT '',
 requirement_version INTEGER NOT NULL CHECK(requirement_version > 0),
 UNIQUE(scope_version_id, requirement_id)
);
CREATE INDEX delivery_scope_items_requirement_idx
 ON delivery_scope_items(requirement_id, scope_version_id);

CREATE TABLE delivery_scope_changes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
 scope_version_id INTEGER NOT NULL REFERENCES delivery_scope_versions(id),
 change_type TEXT NOT NULL CHECK(change_type IN ('add','remove','postpone','waive')),
 requirement_id INTEGER NOT NULL REFERENCES requirements(id),
 original_scope_item_id INTEGER REFERENCES delivery_scope_items(id),
 reason TEXT NOT NULL,
 follow_up_delivery_id INTEGER REFERENCES deliveries(id),
 follow_up_owner_user_id INTEGER REFERENCES users(id),
 follow_up_date TEXT,
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL
);
CREATE INDEX delivery_scope_changes_delivery_idx
 ON delivery_scope_changes(delivery_id, scope_version_id, id);

CREATE TABLE delivery_assignments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 project_id INTEGER NOT NULL REFERENCES projects(id),
 delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
 requirement_id INTEGER NOT NULL REFERENCES requirements(id),
 scope_item_id INTEGER NOT NULL REFERENCES delivery_scope_items(id),
 released_at TEXT,
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX delivery_assignments_active_requirement_idx
 ON delivery_assignments(requirement_id)
 WHERE released_at IS NULL;
CREATE INDEX delivery_assignments_delivery_idx
 ON delivery_assignments(delivery_id, released_at, requirement_id);

UPDATE deliveries
 SET acceptance_owner_user_id=(SELECT product_owner_user_id FROM projects WHERE projects.id=deliveries.project_id)
 WHERE acceptance_owner_user_id IS NULL;

CREATE TRIGGER deliveries_default_acceptance_owner
 AFTER INSERT ON deliveries
 WHEN NEW.acceptance_owner_user_id IS NULL
 BEGIN
  UPDATE deliveries
   SET acceptance_owner_user_id=(SELECT product_owner_user_id FROM projects WHERE projects.id=NEW.project_id)
   WHERE id=NEW.id;
 END;

CREATE TRIGGER delivery_scope_versions_no_update
 BEFORE UPDATE ON delivery_scope_versions
 BEGIN SELECT RAISE(ABORT, 'delivery scope versions are immutable'); END;
CREATE TRIGGER delivery_scope_versions_no_delete
 BEFORE DELETE ON delivery_scope_versions
 BEGIN SELECT RAISE(ABORT, 'delivery scope versions are immutable'); END;
CREATE TRIGGER delivery_scope_items_no_update
 BEFORE UPDATE ON delivery_scope_items
 BEGIN SELECT RAISE(ABORT, 'delivery scope items are immutable'); END;
CREATE TRIGGER delivery_scope_items_no_delete
 BEFORE DELETE ON delivery_scope_items
 BEGIN SELECT RAISE(ABORT, 'delivery scope items are immutable'); END;
CREATE TRIGGER delivery_scope_changes_no_update
 BEFORE UPDATE ON delivery_scope_changes
 BEGIN SELECT RAISE(ABORT, 'delivery scope changes are immutable'); END;
CREATE TRIGGER delivery_scope_changes_no_delete
 BEFORE DELETE ON delivery_scope_changes
 BEGIN SELECT RAISE(ABORT, 'delivery scope changes are immutable'); END;
