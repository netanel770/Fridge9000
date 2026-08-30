-- Core tables
CREATE EXTENSION IF NOT EXISTS citext;

-- Users prepared for future authentication
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email CITEXT NOT NULL UNIQUE CONSTRAINT users_email_normalized_check CHECK (
    email = BTRIM(email) AND email <> ''
  ),
  display_name TEXT,
  password_hash TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_system_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Revocable refresh sessions; token material is stored only as a hash
CREATE TABLE IF NOT EXISTS refresh_sessions (
  id UUID PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user_id ON refresh_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_expires_at ON refresh_sessions(expires_at);

-- External sign-in identities are keyed by provider subject, never by email alone
CREATE TABLE IF NOT EXISTS auth_identities (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CONSTRAINT auth_identities_provider_normalized_check CHECK (
    provider = UPPER(BTRIM(provider)) AND provider <> ''
  ),
  provider_subject TEXT NOT NULL CONSTRAINT auth_identities_subject_nonempty_check CHECK (
    BTRIM(provider_subject) <> ''
  ),
  verified_email CITEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user_id ON auth_identities(user_id);

-- Fridges and their user memberships. Household 1 owns pre-authentication data.
CREATE TABLE IF NOT EXISTS households (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL CONSTRAINT households_name_nonempty_check CHECK (BTRIM(name) <> ''),
  join_code TEXT NOT NULL UNIQUE,
  creator_user_id INT REFERENCES users(id) ON DELETE RESTRICT,
  is_legacy BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO households(id, name, join_code, creator_user_id, is_legacy)
VALUES (1, 'Legacy Fridge Data', 'LEGACY-DATA', NULL, TRUE)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('households', 'id'), GREATEST(1, (SELECT MAX(id) FROM households)));

CREATE TABLE IF NOT EXISTS household_memberships (
  id SERIAL PRIMARY KEY,
  household_id INT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CONSTRAINT household_memberships_role_check CHECK (
    role IN ('OWNER', 'MANAGER', 'MEMBER')
  ),
  status TEXT NOT NULL CONSTRAINT household_memberships_status_check CHECK (
    status IN ('PENDING', 'ACTIVE', 'REJECTED', 'REMOVED')
  ),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(household_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_household_memberships_user ON household_memberships(user_id, status);
CREATE INDEX IF NOT EXISTS idx_household_memberships_household ON household_memberships(household_id, status);

-- Items
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  name CITEXT NOT NULL UNIQUE,
  category TEXT NOT NULL
);

-- Inventory summary
CREATE TABLE IF NOT EXISTS inventory (
  household_id INT NOT NULL DEFAULT 1 REFERENCES households(id) ON DELETE RESTRICT,
  item_id INT NOT NULL REFERENCES items(id),
  quantity INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OK',
  last_updated TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (household_id, item_id)
);

-- Inventory batches with expiry tracking
CREATE TABLE IF NOT EXISTS inventory_batches (
  id SERIAL PRIMARY KEY,
  household_id INT NOT NULL DEFAULT 1 REFERENCES households(id) ON DELETE RESTRICT,
  item_id INT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity INT NOT NULL DEFAULT 0,
  expiry_date DATE,
  expiry_estimate_date DATE,
  expiry_source TEXT NOT NULL DEFAULT 'estimated',
  open_unit_remaining_percent SMALLINT CONSTRAINT inventory_batches_remaining_percent_check CHECK (
    open_unit_remaining_percent IS NULL
    OR open_unit_remaining_percent BETWEEN 1 AND 99
  ),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_updated TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_batches_item_id ON inventory_batches(item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_household ON inventory_batches(household_id, item_id);

-- Scans
CREATE TABLE IF NOT EXISTS scans (
  id SERIAL PRIMARY KEY,
  household_id INT NOT NULL DEFAULT 1 REFERENCES households(id) ON DELETE RESTRICT,
  created_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  image_ref TEXT,
  image_width INT,
  image_height INT,
  source TEXT NOT NULL DEFAULT 'detector' CONSTRAINT scans_source_check CHECK (
    source IN ('detector', 'manual_annotation', 'receipt')
  )
);

-- Events
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  household_id INT NOT NULL DEFAULT 1 REFERENCES households(id) ON DELETE RESTRICT,
  scan_id INT REFERENCES scans(id),
  item_id INT REFERENCES items(id),
  action TEXT NOT NULL, -- Added | Removed | DoorOpened | DoorClosed
  confidence REAL,
  quantity_change INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Detections per scan
CREATE TABLE IF NOT EXISTS scan_detections (
  id SERIAL PRIMARY KEY,
  scan_id INT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  confidence REAL NOT NULL,
  x1 REAL,
  y1 REAL,
  x2 REAL,
  y2 REAL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);



CREATE INDEX IF NOT EXISTS idx_scan_detections_scan_id ON scan_detections(scan_id);

CREATE TABLE IF NOT EXISTS representative_outlines (
  item_id INT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  quality_score REAL NOT NULL DEFAULT 0,
  source_detection_id INT REFERENCES scan_detections(id) ON DELETE SET NULL,
  style_version INT NOT NULL DEFAULT 2,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Manual review of detections
CREATE TABLE IF NOT EXISTS detection_reviews (
  id SERIAL PRIMARY KEY,
  scan_id INT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  original_label TEXT NOT NULL,
  final_label TEXT NOT NULL,
  included BOOLEAN NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_detection_reviews_scan_id ON detection_reviews(scan_id);

-- Human annotation submissions for future model improvement
CREATE TABLE IF NOT EXISTS annotation_submissions (
  id SERIAL PRIMARY KEY,
  household_id INT NOT NULL DEFAULT 1 REFERENCES households(id) ON DELETE RESTRICT,
  created_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  scan_id INT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT annotation_submissions_status_check CHECK (
    status IN ('pending', 'approved', 'rejected', 'used')
  ),
  image_width INT NOT NULL CONSTRAINT annotation_submissions_image_width_check CHECK (image_width > 0),
  image_height INT NOT NULL CONSTRAINT annotation_submissions_image_height_check CHECK (image_height > 0),
  training_state TEXT NOT NULL DEFAULT 'eligible' CONSTRAINT annotation_submissions_training_state_check CHECK (
    training_state IN ('eligible', 'experimental', 'trusted', 'quarantined')
  ),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMP,
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_annotation_submissions_scan_id ON annotation_submissions(scan_id);
CREATE INDEX IF NOT EXISTS idx_annotation_submissions_status ON annotation_submissions(status);
CREATE INDEX IF NOT EXISTS idx_annotation_submissions_training_state ON annotation_submissions(training_state);

CREATE TABLE IF NOT EXISTS freshness_analyses (
  id TEXT PRIMARY KEY,
  household_id INT NOT NULL DEFAULT 1 REFERENCES households(id) ON DELETE RESTRICT,
  created_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  image_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_freshness_analyses_household_user
  ON freshness_analyses(household_id, created_by_user_id, created_at DESC);

-- Individual human corrections within an annotation submission
CREATE TABLE IF NOT EXISTS annotations (
  id SERIAL PRIMARY KEY,
  submission_id INT NOT NULL REFERENCES annotation_submissions(id) ON DELETE CASCADE,
  source_detection_id INT REFERENCES scan_detections(id) ON DELETE SET NULL,
  action TEXT NOT NULL CONSTRAINT annotations_action_check CHECK (
    action IN ('CONFIRM', 'RELABEL', 'ADJUST_BOX', 'ADD', 'REMOVE')
  ),
  original_label TEXT,
  final_label TEXT,
  original_confidence REAL,
  original_x1 REAL,
  original_y1 REAL,
  original_x2 REAL,
  original_y2 REAL,
  final_x1 REAL,
  final_y1 REAL,
  final_x2 REAL,
  final_y2 REAL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_annotations_submission_id ON annotations(submission_id);
CREATE INDEX IF NOT EXISTS idx_annotations_source_detection_id ON annotations(source_detection_id);

-- Candidate detector training runs and traceable model versions
CREATE TABLE IF NOT EXISTS training_runs (
  id TEXT PRIMARY KEY,
  dataset_version TEXT NOT NULL,
  starting_weights_path TEXT NOT NULL,
  starting_model_version TEXT,
  starting_weights_sha256 TEXT,
  training_parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL CONSTRAINT training_runs_status_check CHECK (
    status IN ('running', 'completed', 'failed', 'interrupted')
  ),
  candidate_model_path TEXT,
  precision DOUBLE PRECISION,
  recall DOUBLE PRECISION,
  map50 DOUBLE PRECISION,
  map50_95 DOUBLE PRECISION,
  error JSONB
);

CREATE INDEX IF NOT EXISTS idx_training_runs_dataset_version ON training_runs(dataset_version);
CREATE INDEX IF NOT EXISTS idx_training_runs_status ON training_runs(status);

CREATE TABLE IF NOT EXISTS model_versions (
  id SERIAL PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  model_path TEXT NOT NULL,
  model_sha256 TEXT,
  status TEXT NOT NULL CONSTRAINT model_versions_status_check CHECK (
    status IN ('candidate', 'active', 'rejected', 'archived')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dataset_version TEXT,
  training_run_id TEXT UNIQUE REFERENCES training_runs(id) ON DELETE RESTRICT,
  precision DOUBLE PRECISION,
  recall DOUBLE PRECISION,
  map50 DOUBLE PRECISION,
  map50_95 DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_model_versions_status ON model_versions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_versions_single_active
  ON model_versions(status) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_versions_single_candidate
  ON model_versions(status) WHERE status = 'candidate';

INSERT INTO model_versions(version, model_path, status)
SELECT 'fridge9000-production-initial', 'best.pt', 'active'
WHERE NOT EXISTS (SELECT 1 FROM model_versions WHERE status = 'active')
ON CONFLICT (version) DO NOTHING;

CREATE TABLE IF NOT EXISTS training_run_submission_usage (
  training_run_id TEXT NOT NULL REFERENCES training_runs(id) ON DELETE RESTRICT,
  submission_id INT NOT NULL REFERENCES annotation_submissions(id) ON DELETE RESTRICT,
  dataset_version TEXT NOT NULL,
  model_version_id INT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_experimental BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (training_run_id, submission_id)
);

CREATE INDEX IF NOT EXISTS idx_training_submission_usage_submission
  ON training_run_submission_usage(submission_id, used_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_submission_usage_model
  ON training_run_submission_usage(model_version_id);

CREATE TABLE IF NOT EXISTS training_run_annotation_usage (
  training_run_id TEXT NOT NULL REFERENCES training_runs(id) ON DELETE RESTRICT,
  annotation_id INT NOT NULL REFERENCES annotations(id) ON DELETE RESTRICT,
  submission_id INT NOT NULL REFERENCES annotation_submissions(id) ON DELETE RESTRICT,
  dataset_version TEXT NOT NULL,
  model_version_id INT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_experimental BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (training_run_id, annotation_id)
);

CREATE INDEX IF NOT EXISTS idx_training_annotation_usage_annotation
  ON training_run_annotation_usage(annotation_id, used_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_annotation_usage_submission
  ON training_run_annotation_usage(submission_id, used_at DESC);

CREATE TABLE IF NOT EXISTS model_comparisons (
  id TEXT PRIMARY KEY,
  dataset_version TEXT NOT NULL,
  dataset_content_sha256 TEXT NOT NULL,
  validation_split_sha256 TEXT NOT NULL,
  active_model_id INT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  candidate_model_id INT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evaluation_parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  active_metrics JSONB NOT NULL,
  candidate_metrics JSONB NOT NULL,
  metric_differences JSONB NOT NULL,
  class_comparison JSONB NOT NULL DEFAULT '{"active_classes":[],"candidate_classes":[],"shared_classes":[],"added_classes":[],"removed_classes":[]}'::jsonb,
  shared_class_comparison JSONB NOT NULL DEFAULT '{"available":false,"classes":[],"unavailable_classes":[]}'::jsonb,
  added_class_metrics JSONB NOT NULL DEFAULT '{"available":false,"classes":[],"unavailable_classes":[],"per_class":{}}'::jsonb,
  comparison_rule TEXT NOT NULL,
  candidate_outperforms_active BOOLEAN NOT NULL,
  summary_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_comparisons_candidate
  ON model_comparisons(candidate_model_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_comparisons_dataset
  ON model_comparisons(dataset_version, created_at DESC);

CREATE TABLE IF NOT EXISTS model_activation_history (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL CONSTRAINT model_activation_history_action_check CHECK (
    action IN ('PROMOTE', 'ROLLBACK')
  ),
  from_model_id INT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  to_model_id INT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  comparison_id TEXT REFERENCES model_comparisons(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_activation_history_created_at
  ON model_activation_history(created_at DESC);




