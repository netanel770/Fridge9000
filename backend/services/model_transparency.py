from psycopg2.extras import RealDictCursor

try:
    from db import model_transparency as transparency_db
    from db.connection import get_conn
except ModuleNotFoundError:
    from backend.db import model_transparency as transparency_db
    from backend.db.connection import get_conn


def _model(row):
    if row is None:
        return None
    return {
        key: row[key]
        for key in (
            "id",
            "version",
            "status",
            "created_at",
            "dataset_version",
            "training_run_id",
            "precision",
            "recall",
            "map50",
            "map50_95",
        )
    }


def get_user_model_overview() -> dict:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            active = transparency_db.get_active_model(cursor)
            previous = (
                transparency_db.get_previous_activation(cursor, active["id"])
                if active
                else None
            )
            comparison = (
                transparency_db.get_pair_comparison(
                    cursor,
                    active["id"],
                    previous["id"],
                    previous["comparison_id"],
                )
                if active and previous
                else None
            )

    normalized_comparison = None
    if comparison is not None:
        current_is_candidate = comparison["candidate_model_id"] == active["id"]
        classes = comparison["class_comparison"] or {}
        normalized_comparison = {
            "id": comparison["id"],
            "dataset_version": comparison["dataset_version"],
            "created_at": comparison["created_at"],
            "current_model_id": active["id"],
            "previous_model_id": previous["id"],
            "stored_active_model_id": comparison["active_model_id"],
            "stored_candidate_model_id": comparison["candidate_model_id"],
            "current_metrics": (
                comparison["candidate_metrics"]
                if current_is_candidate
                else comparison["active_metrics"]
            ),
            "previous_metrics": (
                comparison["active_metrics"]
                if current_is_candidate
                else comparison["candidate_metrics"]
            ),
            "metric_differences": comparison["metric_differences"],
            "metric_difference_direction": (
                "current_minus_previous"
                if current_is_candidate
                else "previous_minus_current"
            ),
            "class_comparison": {
                "current_classes": classes.get(
                    "candidate_classes" if current_is_candidate else "active_classes",
                    [],
                ),
                "previous_classes": classes.get(
                    "active_classes" if current_is_candidate else "candidate_classes",
                    [],
                ),
                "shared_classes": classes.get("shared_classes", []),
                "only_in_current": classes.get(
                    "added_classes" if current_is_candidate else "removed_classes",
                    [],
                ),
                "only_in_previous": classes.get(
                    "removed_classes" if current_is_candidate else "added_classes",
                    [],
                ),
            },
            "shared_class_comparison": comparison["shared_class_comparison"],
            "added_class_metrics": comparison["added_class_metrics"],
            "comparison_rule": comparison["comparison_rule"],
            "candidate_outperforms_active": comparison[
                "candidate_outperforms_active"
            ],
        }

    return {
        "active_model": _model(active),
        "previous_model": _model(previous),
        "comparison": normalized_comparison,
    }
