CREATE TABLE delivery_acceptance_rounds (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
 scope_version_id INTEGER NOT NULL REFERENCES delivery_scope_versions(id),
 round_no INTEGER NOT NULL CHECK(round_no > 0),
 delivery_version INTEGER NOT NULL CHECK(delivery_version > 0),
 status TEXT NOT NULL CHECK(status IN ('pending','passed','failed','superseded')),
 delivery_notes TEXT NOT NULL DEFAULT '',
 submitted_by INTEGER NOT NULL REFERENCES users(id),
 submitted_at TEXT NOT NULL,
 completed_by INTEGER REFERENCES users(id),
 completed_at TEXT,
 UNIQUE(delivery_id, round_no)
);
CREATE INDEX delivery_acceptance_rounds_delivery_idx
 ON delivery_acceptance_rounds(delivery_id, round_no DESC);
CREATE UNIQUE INDEX delivery_acceptance_rounds_pending_idx
 ON delivery_acceptance_rounds(delivery_id) WHERE status='pending';

CREATE TABLE delivery_acceptance_evidence (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 round_id INTEGER NOT NULL REFERENCES delivery_acceptance_rounds(id),
 kind TEXT NOT NULL CHECK(kind IN ('text','url','file')),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('manual','external_url','requirement_file')),
 source_resource_id INTEGER,
 label TEXT NOT NULL,
 content TEXT,
 url TEXT,
 mime_type TEXT,
 snapshot_content BLOB,
 immutable INTEGER NOT NULL DEFAULT 0 CHECK(immutable IN (0,1)),
 content_hash TEXT,
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 CHECK((kind='text' AND source_kind='manual' AND source_resource_id IS NULL AND content IS NOT NULL AND url IS NULL AND immutable=1 AND content_hash IS NOT NULL AND snapshot_content IS NOT NULL) OR (kind='url' AND source_kind='external_url' AND source_resource_id IS NULL AND content IS NULL AND url IS NOT NULL AND immutable=0 AND content_hash IS NULL AND snapshot_content IS NULL) OR (kind='file' AND source_kind='requirement_file' AND source_resource_id IS NOT NULL AND content IS NULL AND url IS NULL AND immutable=1 AND content_hash IS NOT NULL AND snapshot_content IS NOT NULL))
);
CREATE INDEX delivery_acceptance_evidence_round_idx
 ON delivery_acceptance_evidence(round_id, id);
CREATE UNIQUE INDEX delivery_acceptance_evidence_source_idx
 ON delivery_acceptance_evidence(round_id, source_kind, source_resource_id)
 WHERE source_resource_id IS NOT NULL;

CREATE TABLE delivery_acceptance_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 round_id INTEGER NOT NULL REFERENCES delivery_acceptance_rounds(id),
 scope_item_id INTEGER NOT NULL REFERENCES delivery_scope_items(id),
 requirement_id INTEGER NOT NULL REFERENCES requirements(id),
 requirement_no TEXT NOT NULL,
 requirement_name TEXT NOT NULL,
 acceptance_criteria TEXT NOT NULL DEFAULT '',
 result TEXT NOT NULL CHECK(result IN ('passed','failed')),
 reason TEXT NOT NULL DEFAULT '',
 recorded_by INTEGER NOT NULL REFERENCES users(id),
 recorded_at TEXT NOT NULL,
 UNIQUE(round_id, scope_item_id),
 CHECK(result='passed' OR length(trim(reason)) > 0)
);
CREATE INDEX delivery_acceptance_items_round_idx
 ON delivery_acceptance_items(round_id, id);

CREATE TRIGGER delivery_acceptance_evidence_no_update
 BEFORE UPDATE ON delivery_acceptance_evidence
 BEGIN SELECT RAISE(ABORT, 'delivery acceptance evidence is immutable'); END;
CREATE TRIGGER delivery_acceptance_evidence_no_delete
 BEFORE DELETE ON delivery_acceptance_evidence
 BEGIN SELECT RAISE(ABORT, 'delivery acceptance evidence is immutable'); END;
CREATE TRIGGER delivery_acceptance_evidence_pending_only
 BEFORE INSERT ON delivery_acceptance_evidence
 WHEN (SELECT status FROM delivery_acceptance_rounds WHERE id=NEW.round_id) <> 'pending'
 BEGIN SELECT RAISE(ABORT, 'acceptance evidence must be submitted with a pending round'); END;
CREATE TRIGGER delivery_acceptance_items_no_update
 BEFORE UPDATE ON delivery_acceptance_items
 BEGIN SELECT RAISE(ABORT, 'delivery acceptance items are immutable'); END;
CREATE TRIGGER delivery_acceptance_items_no_delete
 BEFORE DELETE ON delivery_acceptance_items
 BEGIN SELECT RAISE(ABORT, 'delivery acceptance items are immutable'); END;
CREATE TRIGGER delivery_acceptance_items_pending_scope_only
 BEFORE INSERT ON delivery_acceptance_items
 WHEN (SELECT status FROM delivery_acceptance_rounds WHERE id=NEW.round_id) <> 'pending'
   OR (SELECT scope_version_id FROM delivery_acceptance_rounds WHERE id=NEW.round_id) <>
      (SELECT scope_version_id FROM delivery_scope_items WHERE id=NEW.scope_item_id)
   OR (SELECT requirement_id FROM delivery_scope_items WHERE id=NEW.scope_item_id) <> NEW.requirement_id
 BEGIN SELECT RAISE(ABORT, 'acceptance item must match the pending round scope'); END;
CREATE TRIGGER delivery_acceptance_rounds_scope_matches_delivery
 BEFORE INSERT ON delivery_acceptance_rounds
 WHEN (SELECT delivery_id FROM delivery_scope_versions WHERE id=NEW.scope_version_id) <> NEW.delivery_id
   OR NEW.status <> 'pending'
 BEGIN SELECT RAISE(ABORT, 'acceptance round must start pending for its delivery scope'); END;
CREATE TRIGGER delivery_acceptance_rounds_valid_transition
 BEFORE UPDATE ON delivery_acceptance_rounds
 WHEN OLD.status <> 'pending'
   OR NEW.status = 'pending'
   OR NEW.delivery_id <> OLD.delivery_id
   OR NEW.scope_version_id <> OLD.scope_version_id
   OR NEW.round_no <> OLD.round_no
   OR NEW.delivery_version <> OLD.delivery_version
   OR NEW.delivery_notes <> OLD.delivery_notes
   OR NEW.submitted_by <> OLD.submitted_by
   OR NEW.submitted_at <> OLD.submitted_at
   OR NEW.completed_by IS NULL
   OR NEW.completed_at IS NULL
   OR (NEW.status = 'superseded' AND EXISTS(SELECT 1 FROM delivery_acceptance_items WHERE round_id=OLD.id))
   OR (NEW.status = 'passed' AND (
     (SELECT count(*) FROM delivery_acceptance_items WHERE round_id=OLD.id) <>
     (SELECT count(*) FROM delivery_scope_items WHERE scope_version_id=OLD.scope_version_id)
     OR EXISTS(SELECT 1 FROM delivery_acceptance_items WHERE round_id=OLD.id AND result<>'passed')
   ))
   OR (NEW.status = 'failed' AND (
     (SELECT count(*) FROM delivery_acceptance_items WHERE round_id=OLD.id) <>
     (SELECT count(*) FROM delivery_scope_items WHERE scope_version_id=OLD.scope_version_id)
     OR NOT EXISTS(SELECT 1 FROM delivery_acceptance_items WHERE round_id=OLD.id AND result='failed')
   ))
 BEGIN SELECT RAISE(ABORT, 'invalid acceptance round transition'); END;
CREATE TRIGGER delivery_acceptance_rounds_no_delete
 BEFORE DELETE ON delivery_acceptance_rounds
 BEGIN SELECT RAISE(ABORT, 'delivery acceptance rounds are immutable'); END;
