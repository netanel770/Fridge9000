-- Core tables
CREATE EXTENSION IF NOT EXISTS citext;

-- Items
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  name CITEXT NOT NULL UNIQUE,
  category TEXT NOT NULL
);

-- Inventory summary
CREATE TABLE IF NOT EXISTS inventory (
  item_id INT PRIMARY KEY REFERENCES items(id),
  quantity INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OK',
  last_updated TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Inventory batches with expiry tracking
CREATE TABLE IF NOT EXISTS inventory_batches (
  id SERIAL PRIMARY KEY,
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

-- Scans
CREATE TABLE IF NOT EXISTS scans (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  image_ref TEXT,
  image_width INT,
  image_height INT
);

-- Events
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
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
  scan_id INT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT annotation_submissions_status_check CHECK (
    status IN ('pending', 'approved', 'rejected', 'used')
  ),
  image_width INT NOT NULL CONSTRAINT annotation_submissions_image_width_check CHECK (image_width > 0),
  image_height INT NOT NULL CONSTRAINT annotation_submissions_image_height_check CHECK (image_height > 0),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_annotation_submissions_scan_id ON annotation_submissions(scan_id);
CREATE INDEX IF NOT EXISTS idx_annotation_submissions_status ON annotation_submissions(status);

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




