-- S3.3/S3.4: immutable delivery blocker, risk acceptance, customer confirmation and closure history.
ALTER TABLE delivery_acceptance_items ADD COLUMN issue_id INTEGER REFERENCES issues(id);
ALTER TABLE delivery_acceptance_items ADD COLUMN issue_version INTEGER;
CREATE INDEX delivery_acceptance_items_issue_idx
 ON delivery_acceptance_items(issue_id, issue_version);

CREATE TABLE delivery_acceptance_customer_confirmations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 round_id INTEGER NOT NULL UNIQUE REFERENCES delivery_acceptance_rounds(id),
 confirmed_by_name TEXT NOT NULL,
 confirmed_by_role TEXT NOT NULL,
 confirmed_at TEXT NOT NULL,
 evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('text','url','file')),
 evidence_label TEXT NOT NULL,
 evidence_content TEXT,
 evidence_url TEXT,
 evidence_mime_type TEXT,
 evidence_snapshot_content BLOB,
 evidence_content_hash TEXT,
 recorded_by INTEGER NOT NULL REFERENCES users(id),
 recorded_at TEXT NOT NULL,
 CHECK((evidence_kind='text' AND evidence_content IS NOT NULL AND evidence_url IS NULL AND evidence_snapshot_content IS NOT NULL AND evidence_content_hash IS NOT NULL) OR (evidence_kind='url' AND evidence_content IS NULL AND evidence_url IS NOT NULL AND evidence_snapshot_content IS NULL AND evidence_content_hash IS NULL) OR (evidence_kind='file' AND evidence_content IS NULL AND evidence_url IS NULL AND evidence_snapshot_content IS NOT NULL AND evidence_content_hash IS NOT NULL))
);
CREATE TRIGGER delivery_customer_confirmation_no_update
 BEFORE UPDATE ON delivery_acceptance_customer_confirmations
 BEGIN SELECT RAISE(ABORT, 'customer confirmation is immutable'); END;
CREATE TRIGGER delivery_customer_confirmation_no_delete
 BEFORE DELETE ON delivery_acceptance_customer_confirmations
 BEGIN SELECT RAISE(ABORT, 'customer confirmation is immutable'); END;

CREATE TABLE delivery_blocking_issues (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
 issue_id INTEGER NOT NULL REFERENCES issues(id),
 issue_version INTEGER NOT NULL CHECK(issue_version > 0),
 impact TEXT NOT NULL DEFAULT '',
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 resolved_at TEXT
);
CREATE UNIQUE INDEX delivery_blocking_issue_active_idx
 ON delivery_blocking_issues(delivery_id, issue_id) WHERE resolved_at IS NULL;
CREATE INDEX delivery_blocking_issue_delivery_idx
 ON delivery_blocking_issues(delivery_id, id);

CREATE TABLE delivery_risk_acceptances (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 blocking_issue_id INTEGER NOT NULL UNIQUE REFERENCES delivery_blocking_issues(id),
 issue_version INTEGER NOT NULL CHECK(issue_version > 0),
 reason TEXT NOT NULL,
 evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('text','url','file')),
 evidence_label TEXT NOT NULL,
 evidence_content TEXT,
 evidence_url TEXT,
 evidence_mime_type TEXT,
 evidence_snapshot_content BLOB,
 evidence_content_hash TEXT,
 accepted_by INTEGER NOT NULL REFERENCES users(id),
 accepted_at TEXT NOT NULL,
 CHECK((evidence_kind='text' AND evidence_content IS NOT NULL AND evidence_url IS NULL AND evidence_snapshot_content IS NOT NULL AND evidence_content_hash IS NOT NULL) OR (evidence_kind='url' AND evidence_content IS NULL AND evidence_url IS NOT NULL AND evidence_snapshot_content IS NULL AND evidence_content_hash IS NULL) OR (evidence_kind='file' AND evidence_content IS NULL AND evidence_url IS NULL AND evidence_snapshot_content IS NOT NULL AND evidence_content_hash IS NOT NULL))
);
CREATE INDEX delivery_risk_acceptances_issue_idx
 ON delivery_risk_acceptances(blocking_issue_id, issue_version);
CREATE TRIGGER delivery_risk_acceptance_no_update
 BEFORE UPDATE ON delivery_risk_acceptances
 BEGIN SELECT RAISE(ABORT, 'risk acceptance is immutable'); END;
CREATE TRIGGER delivery_risk_acceptance_no_delete
 BEFORE DELETE ON delivery_risk_acceptances
 BEGIN SELECT RAISE(ABORT, 'risk acceptance is immutable'); END;

CREATE TABLE project_closures (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 project_id INTEGER NOT NULL REFERENCES projects(id),
 action TEXT NOT NULL CHECK(action IN ('close','reopen')),
 from_status TEXT NOT NULL,
 to_status TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '',
 check_summary TEXT NOT NULL DEFAULT '{}',
 actor_user_id INTEGER NOT NULL REFERENCES users(id),
 actor_name_snapshot TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX project_closures_project_idx ON project_closures(project_id, id DESC);
