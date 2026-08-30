_MODEL_COLUMNS = """
    id, version, status, created_at, dataset_version, training_run_id,
    precision, recall, map50, map50_95
"""


def get_active_model(cursor):
    cursor.execute(
        f"SELECT {_MODEL_COLUMNS} FROM model_versions WHERE status = 'active' LIMIT 1;"
    )
    return cursor.fetchone()


def get_previous_activation(cursor, active_model_id: int):
    cursor.execute(
        f"""
        SELECT h.id AS activation_id, h.action, h.comparison_id,
               h.created_at AS activated_at,
               m.id, m.version, m.status, m.created_at, m.dataset_version,
               m.training_run_id, m.precision, m.recall, m.map50, m.map50_95
        FROM model_activation_history h
        JOIN model_versions m ON m.id = h.from_model_id
        WHERE h.to_model_id = %s
        ORDER BY h.created_at DESC, h.id DESC
        LIMIT 1;
        """,
        (active_model_id,),
    )
    return cursor.fetchone()


def get_pair_comparison(
    cursor,
    current_model_id: int,
    previous_model_id: int,
    activation_comparison_id: str | None,
):
    cursor.execute(
        """
        SELECT id, dataset_version, created_at,
               active_model_id, candidate_model_id,
               active_metrics, candidate_metrics, metric_differences,
               class_comparison, shared_class_comparison, added_class_metrics,
               comparison_rule, candidate_outperforms_active
        FROM model_comparisons
        WHERE (active_model_id = %s AND candidate_model_id = %s)
           OR (active_model_id = %s AND candidate_model_id = %s)
        ORDER BY CASE WHEN id = %s THEN 0 ELSE 1 END,
                 created_at DESC, id DESC
        LIMIT 1;
        """,
        (
            previous_model_id,
            current_model_id,
            current_model_id,
            previous_model_id,
            activation_comparison_id,
        ),
    )
    return cursor.fetchone()
