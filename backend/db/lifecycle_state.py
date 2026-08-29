def reconcile_annotation_training_states(cur):
    """Align submission state with the current model registry without rewriting provenance."""
    cur.execute(
        """
        UPDATE annotation_submissions s
        SET training_state = CASE
            WHEN EXISTS (
                SELECT 1
                FROM training_run_submission_usage u
                JOIN model_versions m ON m.id = u.model_version_id
                WHERE u.submission_id = s.id AND m.status = 'active'
            ) THEN 'trusted'
            WHEN EXISTS (
                SELECT 1
                FROM training_run_submission_usage u
                JOIN model_versions m ON m.id = u.model_version_id
                WHERE u.submission_id = s.id
                  AND m.status = 'candidate'
                  AND u.is_experimental
            ) THEN 'experimental'
            WHEN s.training_state = 'quarantined' THEN 'quarantined'
            WHEN s.training_state = 'experimental' AND EXISTS (
                SELECT 1
                FROM training_run_submission_usage u
                JOIN model_versions m ON m.id = u.model_version_id
                WHERE u.submission_id = s.id
                  AND m.status = 'rejected'
                  AND u.is_experimental
            ) THEN 'quarantined'
            ELSE 'eligible'
        END
        WHERE s.status IN ('approved', 'used');
        """
    )
