from .connection import get_conn
from .lifecycle_state import reconcile_annotation_training_states


def ensure_schema():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                ALTER TABLE scans
                ADD COLUMN IF NOT EXISTS image_width INT,
                ADD COLUMN IF NOT EXISTS image_height INT,
                ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'detector';
                """
            )
            cur.execute(
                """
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'scans_source_check'
                          AND conrelid = 'scans'::regclass
                    ) THEN
                        ALTER TABLE scans
                        ADD CONSTRAINT scans_source_check
                        CHECK (source IN ('detector', 'manual_annotation', 'receipt'));
                    END IF;
                END $$;
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS annotation_submissions (
                    id SERIAL PRIMARY KEY,
                    scan_id INT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
                    status TEXT NOT NULL DEFAULT 'pending'
                        CONSTRAINT annotation_submissions_status_check CHECK (
                            status IN ('pending', 'approved', 'rejected', 'used')
                        ),
                    image_width INT NOT NULL
                        CONSTRAINT annotation_submissions_image_width_check CHECK (image_width > 0),
                    image_height INT NOT NULL
                        CONSTRAINT annotation_submissions_image_height_check CHECK (image_height > 0),
                    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    reviewed_at TIMESTAMP,
                    archived_at TIMESTAMPTZ
                );

                ALTER TABLE annotation_submissions
                    ADD COLUMN IF NOT EXISTS training_state TEXT NOT NULL DEFAULT 'eligible',
                    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'annotation_submissions_training_state_check'
                          AND conrelid = 'annotation_submissions'::regclass
                    ) THEN
                        ALTER TABLE annotation_submissions
                        ADD CONSTRAINT annotation_submissions_training_state_check
                        CHECK (training_state IN ('eligible', 'experimental', 'trusted', 'quarantined'));
                    END IF;
                END $$;

                CREATE INDEX IF NOT EXISTS idx_annotation_submissions_scan_id
                    ON annotation_submissions(scan_id);
                CREATE INDEX IF NOT EXISTS idx_annotation_submissions_status
                    ON annotation_submissions(status);
                CREATE INDEX IF NOT EXISTS idx_annotation_submissions_training_state
                    ON annotation_submissions(training_state);

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

                CREATE INDEX IF NOT EXISTS idx_annotations_submission_id
                    ON annotations(submission_id);
                CREATE INDEX IF NOT EXISTS idx_annotations_source_detection_id
                    ON annotations(source_detection_id);
                """
            )
            cur.execute(
                """
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

                CREATE INDEX IF NOT EXISTS idx_training_runs_dataset_version
                    ON training_runs(dataset_version);
                CREATE INDEX IF NOT EXISTS idx_training_runs_status
                    ON training_runs(status);

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

                CREATE INDEX IF NOT EXISTS idx_model_versions_status
                    ON model_versions(status);
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

                ALTER TABLE training_run_submission_usage
                    ADD COLUMN IF NOT EXISTS is_experimental BOOLEAN NOT NULL DEFAULT FALSE;

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

                ALTER TABLE training_run_annotation_usage
                    ADD COLUMN IF NOT EXISTS is_experimental BOOLEAN NOT NULL DEFAULT FALSE;

                CREATE INDEX IF NOT EXISTS idx_training_annotation_usage_annotation
                    ON training_run_annotation_usage(annotation_id, used_at DESC);
                CREATE INDEX IF NOT EXISTS idx_training_annotation_usage_submission
                    ON training_run_annotation_usage(submission_id, used_at DESC);

                UPDATE training_run_submission_usage u
                SET is_experimental = TRUE
                FROM annotation_submissions s, model_versions m
                WHERE u.submission_id = s.id
                  AND u.model_version_id = m.id
                  AND s.training_state IN ('experimental', 'quarantined')
                  AND m.status IN ('candidate', 'rejected');

                UPDATE training_run_annotation_usage u
                SET is_experimental = TRUE
                FROM annotation_submissions s, model_versions m
                WHERE u.submission_id = s.id
                  AND u.model_version_id = m.id
                  AND s.training_state IN ('experimental', 'quarantined')
                  AND m.status IN ('candidate', 'rejected');

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

                ALTER TABLE model_comparisons
                    ADD COLUMN IF NOT EXISTS validation_split_sha256 TEXT,
                    ADD COLUMN IF NOT EXISTS class_comparison JSONB NOT NULL DEFAULT '{"active_classes":[],"candidate_classes":[],"shared_classes":[],"added_classes":[],"removed_classes":[]}'::jsonb,
                    ADD COLUMN IF NOT EXISTS shared_class_comparison JSONB NOT NULL DEFAULT '{"available":false,"classes":[],"unavailable_classes":[]}'::jsonb,
                    ADD COLUMN IF NOT EXISTS added_class_metrics JSONB NOT NULL DEFAULT '{"available":false,"classes":[],"unavailable_classes":[],"per_class":{}}'::jsonb;

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
                """
            )
            reconcile_annotation_training_states(cur)
            cur.execute(
                """
                UPDATE model_comparisons
                SET validation_split_sha256 = dataset_content_sha256
                WHERE validation_split_sha256 IS NULL;
                ALTER TABLE model_comparisons
                    ALTER COLUMN validation_split_sha256 SET NOT NULL;
                """
            )
            cur.execute(
                """
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
                """
            )
            cur.execute(
                """
                ALTER TABLE inventory_batches
                ADD COLUMN IF NOT EXISTS open_unit_remaining_percent SMALLINT;
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS representative_outlines (
                    item_id INT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
                    image_path TEXT NOT NULL,
                    quality_score REAL NOT NULL DEFAULT 0,
                    source_detection_id INT REFERENCES scan_detections(id) ON DELETE SET NULL,
                    style_version INT NOT NULL DEFAULT 2,
                    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                );
                """
            )
            cur.execute(
                """
                ALTER TABLE representative_outlines
                ADD COLUMN IF NOT EXISTS style_version INT NOT NULL DEFAULT 1;
                """
            )
            cur.execute(
                """
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'inventory_batches_remaining_percent_check'
                          AND conrelid = 'inventory_batches'::regclass
                    ) THEN
                        ALTER TABLE inventory_batches
                        ADD CONSTRAINT inventory_batches_remaining_percent_check
                        CHECK (
                            open_unit_remaining_percent IS NULL
                            OR open_unit_remaining_percent BETWEEN 1 AND 99
                        );
                    END IF;
                END $$;
                """
            )
            cur.execute(
                """
                SELECT id, item_id, quantity, expiry_date, expiry_estimate_date,
                       expiry_source, open_unit_remaining_percent, created_at, last_updated
                FROM inventory_batches
                WHERE quantity > 1 AND open_unit_remaining_percent IS NOT NULL;
                """
            )
            legacy_open_batches = cur.fetchall()
            for batch in legacy_open_batches:
                cur.execute(
                    """
                    UPDATE inventory_batches
                    SET quantity = %s, open_unit_remaining_percent = NULL
                    WHERE id = %s;
                    """,
                    (batch[2] - 1, batch[0]),
                )
                cur.execute(
                    """
                    INSERT INTO inventory_batches(
                        item_id, quantity, expiry_date, expiry_estimate_date, expiry_source,
                        open_unit_remaining_percent, created_at, last_updated
                    ) VALUES (%s, 1, %s, %s, %s, %s, %s, %s);
                    """,
                    (batch[1], batch[3], batch[4], batch[5], batch[6], batch[7], batch[8]),
                )
            cur.execute(
                """
                INSERT INTO inventory_batches(item_id, quantity, expiry_date, expiry_estimate_date, expiry_source, created_at, last_updated)
                SELECT inv.item_id, inv.quantity, NULL, NULL, 'manual', inv.last_updated, inv.last_updated
                FROM inventory inv
                WHERE inv.quantity > 0
                  AND NOT EXISTS (
                      SELECT 1 FROM inventory_batches b
                      WHERE b.item_id = inv.item_id
                  );
                """
            )
            cur.execute("SELECT id FROM items;")
            items = cur.fetchall()
            for item in items:
                cur.execute(
                    "SELECT COALESCE(SUM(quantity), 0) AS quantity FROM inventory_batches WHERE item_id = %s;",
                    (item[0],),
                )
                quantity = cur.fetchone()[0]
                status = "MISSING" if quantity == 0 else "LOW" if quantity == 1 else "OK"
                cur.execute(
                    """
                    INSERT INTO inventory(item_id, quantity, status, last_updated)
                    VALUES (%s, %s, %s, NOW())
                    ON CONFLICT (item_id)
                    DO UPDATE SET quantity = EXCLUDED.quantity, status = EXCLUDED.status, last_updated = NOW();
                    """,
                    (item[0], quantity, status),
                )
            conn.commit()
