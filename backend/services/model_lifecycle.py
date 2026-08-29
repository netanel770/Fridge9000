import json
import logging
import os
import threading
import uuid
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from psycopg2.extras import RealDictCursor

try:
    from core.config import BACKEND_DIR, DATABASE_URL, MAX_SHARED_MAP50_95_REGRESSION, MIN_ADDED_CLASS_MAP50_95, MIN_ADDED_CLASS_PER_CLASS_MAP50_95
    from db.connection import get_conn
    from db.lifecycle_state import reconcile_annotation_training_states
    from model_promotion_policy import evaluate_promotion
    from services import detection
except ModuleNotFoundError:
    from backend.core.config import BACKEND_DIR, DATABASE_URL, MAX_SHARED_MAP50_95_REGRESSION, MIN_ADDED_CLASS_MAP50_95, MIN_ADDED_CLASS_PER_CLASS_MAP50_95
    from backend.db.connection import get_conn
    from backend.db.lifecycle_state import reconcile_annotation_training_states
    from backend.model_promotion_policy import evaluate_promotion
    from backend.services import detection


LOGGER = logging.getLogger("uvicorn.error")
_MODEL_LOCK = detection._MODEL_LOCK
_load_registered_detector = detection._load_registered_detector
_reconcile_annotation_training_states = reconcile_annotation_training_states
_LIFECYCLE_JOB_LOCK = threading.Lock()
_LIFECYCLE_JOBS = {}
_ACTIVE_LIFECYCLE_JOB_ID = None


def _promotion_decision(comparison, current_active_id, candidate_id):
    return evaluate_promotion(
        comparison,
        current_active_id=current_active_id,
        candidate_id=candidate_id,
        max_shared_map50_95_regression=MAX_SHARED_MAP50_95_REGRESSION,
        min_added_class_map50_95=MIN_ADDED_CLASS_MAP50_95,
        min_added_class_per_class_map50_95=MIN_ADDED_CLASS_PER_CLASS_MAP50_95,
    )


def _activate_model(version: str, action: str, comparison_id: Optional[str] = None):
    required_status = "candidate" if action == "PROMOTE" else "archived"
    with _MODEL_LOCK:
        with get_conn() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                # Serialize registry changes across API workers/processes.
                cur.execute("SELECT pg_advisory_xact_lock(9000, 1);")
                cur.execute("SELECT * FROM model_versions WHERE status = 'active' FOR UPDATE;")
                current = cur.fetchone()
                if not current:
                    raise HTTPException(status_code=409, detail="No current active model is registered")
                cur.execute("SELECT * FROM model_versions WHERE version = %s FOR UPDATE;", (version,))
                target = cur.fetchone()
                if not target:
                    raise HTTPException(status_code=404, detail="Model version not found")
                if target["status"] != required_status:
                    raise HTTPException(
                        status_code=409,
                        detail=f"{action.title()} requires a model with status '{required_status}'",
                    )
                if action == "PROMOTE":
                    if not comparison_id:
                        raise HTTPException(status_code=400, detail="A successful comparison_id is required")
                    cur.execute(
                        """
                        SELECT id, active_model_id, candidate_model_id,
                               active_metrics, candidate_metrics,
                               candidate_outperforms_active, class_comparison,
                               shared_class_comparison, added_class_metrics
                        FROM model_comparisons
                        WHERE id = %s AND candidate_model_id = %s;
                        """,
                        (comparison_id, target["id"]),
                    )
                    comparison = cur.fetchone()
                    if not comparison:
                        raise HTTPException(
                            status_code=409,
                            detail="Candidate was not compared with the current active model",
                        )
                    decision = _promotion_decision(comparison, current["id"], target["id"])
                    if not decision["eligible"]:
                        raise HTTPException(
                            status_code=409,
                            detail=decision["reasons"][0]["message"],
                        )

                # Load and validate before changing registry state.
                try:
                    detector, resolved_path = _load_registered_detector(target)
                except Exception as exc:
                    LOGGER.exception("Target detector could not be loaded")
                    raise HTTPException(status_code=409, detail=str(exc)) from exc

                cur.execute("UPDATE model_versions SET status = 'archived' WHERE id = %s;", (current["id"],))
                cur.execute("UPDATE model_versions SET status = 'active' WHERE id = %s;", (target["id"],))
                _reconcile_annotation_training_states(cur)
                cur.execute(
                    """
                    INSERT INTO model_activation_history(action, from_model_id, to_model_id, comparison_id)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id, created_at;
                    """,
                    (action, current["id"], target["id"], comparison_id if action == "PROMOTE" else None),
                )
                history = cur.fetchone()
            conn.commit()

        detection.MODEL = detector
        detection._MODEL_VERSION = target["version"]
        detection._MODEL_PATH = resolved_path
        LOGGER.info("Detector registry action=%s from=%s to=%s", action, current["version"], target["version"])
        return {
            "ok": True,
            "action": action,
            "previous_active_version": current["version"],
            "active_version": target["version"],
            "active_model_path": target["model_path"],
            "history_id": history["id"],
            "changed_at": history["created_at"],
        }

def promote_model(version: str, payload: Dict[str, Any]):
    return _activate_model(version, "PROMOTE", payload.get("comparison_id"))


def reject_model(version: str):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT pg_advisory_xact_lock(9000, 1);")
            cur.execute(
                "SELECT id, status, training_run_id FROM model_versions WHERE version = %s FOR UPDATE;",
                (version,),
            )
            candidate = cur.fetchone()
            if not candidate:
                raise HTTPException(status_code=404, detail="Model version not found")
            if candidate["status"] != "candidate":
                raise HTTPException(status_code=409, detail="Reject requires a model with status 'candidate'")
            cur.execute(
                """
                UPDATE annotation_submissions s
                SET training_state = 'quarantined'
                FROM training_run_submission_usage u
                WHERE u.training_run_id = %s
                  AND u.submission_id = s.id
                  AND u.is_experimental
                  AND s.training_state = 'experimental';
                """,
                (candidate["training_run_id"],),
            )
            quarantined_count = cur.rowcount
            cur.execute("UPDATE model_versions SET status = 'rejected' WHERE id = %s;", (candidate["id"],))
        conn.commit()
    return {
        "ok": True,
        "action": "REJECT",
        "model_version": version,
        "quarantined_submission_count": quarantined_count,
    }


def _finalize_candidate_comparison(version: str, result: Dict[str, Any]):
    """Reject a freshly compared candidate when the promotion policy fails."""
    comparison_id = result.get("comparison_id")
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id FROM model_versions WHERE status = 'active' LIMIT 1;")
            active = cur.fetchone()
            cur.execute(
                "SELECT id FROM model_versions WHERE version = %s AND status = 'candidate';",
                (version,),
            )
            candidate = cur.fetchone()
            cur.execute(
                """
                SELECT id, active_model_id, candidate_model_id, active_metrics,
                       candidate_metrics, candidate_outperforms_active,
                       class_comparison, shared_class_comparison, added_class_metrics
                FROM model_comparisons WHERE id = %s;
                """,
                (comparison_id,),
            )
            comparison = cur.fetchone()
    if not active or not candidate or not comparison:
        return result

    decision = _promotion_decision(comparison, active["id"], candidate["id"])
    finalized = {**result, "promotion_evaluation": decision, "auto_rejected": False}
    quality_failure_codes = {
        "removed_classes",
        "shared_class_regression",
        "added_class_quality",
        "added_class_below_minimum",
    }
    reason_codes = {
        reason.get("code") for reason in decision.get("reasons", [])
        if reason.get("code")
    }
    non_destructive_codes = {
        "comparison_missing", "stale_comparison", "malformed_class_metrics"
    }
    if (
        decision["eligible"]
        or reason_codes & non_destructive_codes
        or not (reason_codes & quality_failure_codes)
    ):
        return finalized

    rejection = reject_model(version)
    return {
        **finalized,
        "auto_rejected": True,
        "quarantined_submission_count": rejection["quarantined_submission_count"],
    }


def rollback_model(version: str):
    return _activate_model(version, "ROLLBACK")

def _model_supported_classes(cur, model_id: int) -> List[str]:
    """Return persisted detector classes without inferring from inventory data."""
    cur.execute(
        """
        SELECT CASE
            WHEN candidate_model_id = %s THEN class_comparison->'candidate_classes'
            ELSE class_comparison->'active_classes'
        END AS classes
        FROM model_comparisons
        WHERE active_model_id = %s OR candidate_model_id = %s
        ORDER BY created_at DESC LIMIT 1;
        """,
        (model_id, model_id, model_id),
    )
    row = cur.fetchone()
    classes = (row or {}).get("classes") or []
    if not isinstance(classes, list):
        return []
    return [value.strip() for value in classes if isinstance(value, str) and value.strip()]


def _candidate_lifecycle_state(candidate, comparison, promotion_evaluation):
    if candidate is None:
        return "none"
    if comparison is None:
        return "needs_comparison"
    if promotion_evaluation.get("stale"):
        return "comparison_stale"
    reason_codes = {
        reason.get("code")
        for reason in promotion_evaluation.get("reasons", [])
        if isinstance(reason, dict)
    }
    if reason_codes & {
        "comparison_missing",
        "missing_shared_classes",
        "malformed_class_metrics",
    }:
        return "comparison_invalid"
    return "eligible" if promotion_evaluation.get("eligible") else "not_eligible"


def _rollback_targets(cur):
    cur.execute(
        """
        SELECT m.id, m.version, m.status, m.created_at, m.dataset_version,
               m.training_run_id,
               (
                   SELECT MAX(h.created_at)
                   FROM model_activation_history h
                   WHERE h.to_model_id = m.id
               ) AS last_activated_at,
               (
                   SELECT MAX(h.created_at)
                   FROM model_activation_history h
                   WHERE h.from_model_id = m.id
               ) AS archived_at
        FROM model_versions m
        WHERE m.status = 'archived'
          AND EXISTS (
              SELECT 1
              FROM model_activation_history h
              WHERE h.from_model_id = m.id OR h.to_model_id = m.id
          )
        ORDER BY COALESCE((
            SELECT MAX(h.created_at)
            FROM model_activation_history h
            WHERE h.from_model_id = m.id OR h.to_model_id = m.id
        ), m.created_at) DESC, m.id DESC;
        """
    )
    targets = cur.fetchall()
    for target in targets:
        classes = _model_supported_classes(cur, target["id"])
        target["supported_classes"] = classes
        target["supported_product_count"] = len(classes)
        target["classes_available"] = bool(classes)
    return targets


def get_ai_progress():
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, version, status, created_at, dataset_version, training_run_id,
                       precision, recall, map50, map50_95
                FROM model_versions WHERE status = 'active' LIMIT 1;
                """
            )
            active = cur.fetchone()

            active_classes = _model_supported_classes(cur, active["id"]) if active else []

            cur.execute(
                """
                SELECT id, version, status, created_at, dataset_version, training_run_id,
                       precision, recall, map50, map50_95
                FROM model_versions WHERE status = 'candidate'
                ORDER BY created_at DESC, id DESC LIMIT 1;
                """
            )
            candidate = cur.fetchone()

            comparison = None
            if candidate:
                cur.execute(
                    """
                    SELECT id, dataset_version, created_at, active_model_id, candidate_model_id,
                           active_metrics, candidate_metrics,
                           metric_differences, comparison_rule, candidate_outperforms_active,
                           evaluation_parameters, class_comparison,
                           shared_class_comparison, added_class_metrics
                    FROM model_comparisons
                    WHERE candidate_model_id = %s
                    ORDER BY created_at DESC LIMIT 1;
                    """,
                    (candidate["id"],),
                )
                comparison = cur.fetchone()

            cur.execute(
                """
                SELECT id, version, status, created_at, dataset_version, training_run_id
                FROM model_versions WHERE status = 'archived'
                ORDER BY created_at DESC, id DESC;
                """
            )
            archived_models = cur.fetchall()
            rollback_targets = _rollback_targets(cur)

            cur.execute(
                """
                SELECT version
                FROM model_versions
                ORDER BY created_at, id;
                """
            )
            chronological_models = cur.fetchall()
            model_display_names = {}
            next_model_number = 2
            for model in chronological_models:
                version = model["version"]
                if version == "fridge9000-production-initial":
                    model_display_names[version] = "Initial Model"
                else:
                    model_display_names[version] = f"Model {next_model_number}"
                    next_model_number += 1

            cur.execute(
                """
                SELECT
                    COUNT(*) FILTER (
                        WHERE s.status IN ('approved', 'used')
                    ) AS total_approved,

                    COUNT(*) FILTER (
                        WHERE s.status = 'used'
                           OR EXISTS (
                               SELECT 1
                               FROM training_run_submission_usage u
                               WHERE u.submission_id = s.id
                           )
                    ) AS used_in_training,

                    COUNT(*) FILTER (
                        WHERE s.status IN ('approved', 'used')
                          AND s.training_state = 'eligible'
                    ) AS approved_waiting

                FROM annotation_submissions s;
                """
            )
            contributions = cur.fetchone()

            cur.execute(
                """
                SELECT tr.id AS training_run_id,
                       tr.dataset_version,
                       tr.started_at,
                       tr.ended_at,
                       tr.status,
                       tr.training_parameters,
                       mv.id AS model_id,
                       mv.version AS model_version,
                       (SELECT COUNT(*) FROM training_run_submission_usage su
                        WHERE su.training_run_id = tr.id) AS submission_count,
                       (SELECT COUNT(*) FROM training_run_annotation_usage au
                        WHERE au.training_run_id = tr.id) AS annotation_count
                FROM training_runs tr
                LEFT JOIN model_versions mv
                    ON mv.training_run_id = tr.id
                ORDER BY tr.started_at DESC
                LIMIT 8;
                """
            )
            training_history = cur.fetchall()

    promotion_evaluation = _promotion_decision(
        comparison,
        active["id"] if active else None,
        candidate["id"] if candidate else None,
    )

    if comparison:
        comparison["promotion_evaluation"] = promotion_evaluation

    candidate_state = _candidate_lifecycle_state(
        candidate, comparison, promotion_evaluation
    )

    return {
        "active_model": active,
        "active_classes": active_classes,
        "active_model_classes": {
            "available": bool(active_classes),
            "count": len(active_classes),
            "classes": active_classes,
        },
        "candidate": candidate,
        "latest_candidate": candidate,
        "candidate_state": candidate_state,
        "comparison": comparison,
        "promotion_evaluation": promotion_evaluation,
        "archived_models": archived_models,
        "rollback_targets": rollback_targets,
        "model_display_names": model_display_names,
        "contributions": contributions,
        "training_history": training_history,
        "actions": {
            "can_train": (
                contributions["approved_waiting"] > 0
                and candidate is None
            ),
            "can_compare": candidate is not None,
            "can_promote": (
                candidate is not None
                and promotion_evaluation["eligible"]
            ),
            "can_rollback": bool(rollback_targets),
        },
    }

def _set_lifecycle_job(job_id: str, **changes):
    with _LIFECYCLE_JOB_LOCK:
        _LIFECYCLE_JOBS[job_id].update(changes)


def _finish_lifecycle_job(job_id: str, result=None, error=None):
    global _ACTIVE_LIFECYCLE_JOB_ID
    with _LIFECYCLE_JOB_LOCK:
        job = _LIFECYCLE_JOBS[job_id]
        job.update({"status": "failed" if error else "completed", "finished_at": datetime.utcnow().isoformat(), "result": result, "error": error})
        if _ACTIVE_LIFECYCLE_JOB_ID == job_id:
            _ACTIVE_LIFECYCLE_JOB_ID = None


def _run_lifecycle_job(job_id: str, operation):
    _set_lifecycle_job(job_id, status="running", started_at=datetime.utcnow().isoformat())
    try:
        _finish_lifecycle_job(job_id, result=operation())
    except BaseException as exc:
        LOGGER.exception("Model lifecycle job failed: %s", job_id)
        message = " ".join(str(exc).split())
        if len(message) > 500:
            message = f"{message[:497]}..."
        _finish_lifecycle_job(
            job_id,
            error={"type": type(exc).__name__, "message": message or "Model lifecycle operation failed"},
        )


def _start_lifecycle_job(kind: str, operation):
    global _ACTIVE_LIFECYCLE_JOB_ID
    with _LIFECYCLE_JOB_LOCK:
        if _ACTIVE_LIFECYCLE_JOB_ID:
            active_job = _LIFECYCLE_JOBS.get(_ACTIVE_LIFECYCLE_JOB_ID)
            if active_job and active_job["status"] in ("queued", "running"):
                raise HTTPException(status_code=409, detail="Another model lifecycle operation is already running")
        job_id = f"lifecycle-{kind.lower()}-{uuid.uuid4().hex[:12]}"
        _LIFECYCLE_JOBS[job_id] = {"job_id": job_id, "kind": kind, "status": "queued", "created_at": datetime.utcnow().isoformat(), "started_at": None, "finished_at": None, "result": None, "error": None}
        _ACTIVE_LIFECYCLE_JOB_ID = job_id
    threading.Thread(target=_run_lifecycle_job, args=(job_id, operation), daemon=True).start()
    return _LIFECYCLE_JOBS[job_id]


def _dataset_directory(dataset_version: str) -> Path:
    export_root = BACKEND_DIR / "dataset_exports"
    for manifest_path in export_root.glob("*/manifest.json"):
        try:
            if json.loads(manifest_path.read_text(encoding="utf-8")).get("dataset_version") == dataset_version:
                return manifest_path.parent
        except Exception:
            continue
    raise RuntimeError(f"Exported dataset is unavailable for {dataset_version}")


def start_candidate_training(payload: Optional[Dict[str, Any]] = None):
    explicit_selection = payload is not None and "submission_ids" in payload
    selected_submission_ids = None
    if explicit_selection:
        raw_ids = payload.get("submission_ids")
        if not isinstance(raw_ids, list) or not raw_ids:
            raise HTTPException(status_code=400, detail="submission_ids must be a non-empty list")
        if any(not isinstance(value, int) or isinstance(value, bool) or value <= 0 for value in raw_ids):
            raise HTTPException(status_code=400, detail="submission_ids must contain positive integers")
        if len(raw_ids) != len(set(raw_ids)):
            raise HTTPException(status_code=400, detail="submission_ids must not contain duplicates")
        selected_submission_ids = list(raw_ids)

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT pg_advisory_xact_lock(9000, 1);")
            cur.execute("SELECT version FROM model_versions WHERE status = 'candidate' LIMIT 1;")
            unresolved_candidate = cur.fetchone()
            if unresolved_candidate:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Candidate {unresolved_candidate['version']} must be promoted or rejected "
                        "before starting another training run"
                    ),
                )
            if selected_submission_ids is not None:
                cur.execute(
                    """
                    SELECT id, status, training_state
                    FROM annotation_submissions
                    WHERE id = ANY(%s);
                    """,
                    (selected_submission_ids,),
                )
                rows = {row["id"]: row for row in cur.fetchall()}
                unknown = [value for value in selected_submission_ids if value not in rows]
                if unknown:
                    raise HTTPException(
                        status_code=409,
                        detail=f"Unknown annotation submission IDs: {unknown}",
                    )
                ineligible = [
                    {
                        "id": value,
                        "moderation_status": rows[value]["status"],
                        "training_state": rows[value]["training_state"],
                    }
                    for value in selected_submission_ids
                    if rows[value]["status"] not in ("approved", "used")
                    or rows[value]["training_state"] != "eligible"
                ]
                if ineligible:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "message": "Selected annotation submissions are not eligible for training",
                            "submissions": ineligible,
                        },
                    )
            else:
                cur.execute(
                    """
                    SELECT COUNT(*) AS eligible_count FROM annotation_submissions s
                    WHERE s.status IN ('approved', 'used') AND s.training_state = 'eligible';
                    """
                )
                if cur.fetchone()["eligible_count"] == 0:
                    raise HTTPException(status_code=409, detail="No approved contributions are available for training")

    job_id = f"lifecycle-train-{uuid.uuid4().hex[:12]}"

    def operation():
        try:
            from training_providers import training_provider
            from core.config import TRAINING_PROVIDER
        except ModuleNotFoundError:
            from backend.training_providers import training_provider
            from backend.core.config import TRAINING_PROVIDER
        provider = training_provider(TRAINING_PROVIDER)
        _set_lifecycle_job(job_id, provider=TRAINING_PROVIDER, phase="preparing")
        progress = lambda **changes: _set_lifecycle_job(job_id, **changes)
        if selected_submission_ids is None:
            return provider(job_id, progress)
        return provider(
            job_id, progress, selected_submission_ids=selected_submission_ids
        )

    # Reserve the externally visible ID as the dataset directory name.
    def wrapped_start():
        return operation()
    global _ACTIVE_LIFECYCLE_JOB_ID
    with _LIFECYCLE_JOB_LOCK:
        if _ACTIVE_LIFECYCLE_JOB_ID and _LIFECYCLE_JOBS.get(_ACTIVE_LIFECYCLE_JOB_ID, {}).get("status") in ("queued", "running"):
            raise HTTPException(status_code=409, detail="Another model lifecycle operation is already running")
        _LIFECYCLE_JOBS[job_id] = {"job_id": job_id, "kind": "TRAIN", "status": "queued", "created_at": datetime.utcnow().isoformat(), "started_at": None, "finished_at": None, "result": None, "error": None, "selected_submission_ids": selected_submission_ids}
        _ACTIVE_LIFECYCLE_JOB_ID = job_id
    threading.Thread(target=_run_lifecycle_job, args=(job_id, wrapped_start), daemon=True).start()
    return _LIFECYCLE_JOBS[job_id]


def start_candidate_comparison(version: str):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, version, dataset_version FROM model_versions WHERE version = %s AND status = 'candidate';", (version,))
            candidate = cur.fetchone()
    if not candidate:
        raise HTTPException(status_code=409, detail="A valid candidate model is required")

    try:
        from core.config import TRAINING_PROVIDER
    except ModuleNotFoundError:
        from backend.core.config import TRAINING_PROVIDER
    if TRAINING_PROVIDER == "kaggle":
        with get_conn() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("SELECT id FROM model_versions WHERE status='active' LIMIT 1;")
                active = cur.fetchone()
                cur.execute(
                    """SELECT id,candidate_outperforms_active,metric_differences
                       FROM model_comparisons WHERE active_model_id=%s AND candidate_model_id=%s
                       ORDER BY created_at DESC LIMIT 1;""",
                    (active["id"] if active else None, candidate["id"]),
                )
                remote_comparison = cur.fetchone()
        if not remote_comparison:
            raise HTTPException(status_code=409, detail="No verified remote comparison is available for this candidate")
        return _start_lifecycle_job(
            "COMPARE",
            lambda: _finalize_candidate_comparison(version, {
                "comparison_id": remote_comparison["id"],
                "candidate_outperforms_active": remote_comparison["candidate_outperforms_active"],
                "metric_differences": remote_comparison["metric_differences"],
                "provider": "kaggle",
            }),
        )

    def operation():
        from compare_yolo_models import compare
        backend_root = BACKEND_DIR
        args = SimpleNamespace(
            dataset_dir=_dataset_directory(candidate["dataset_version"]), dataset_version=candidate["dataset_version"],
            candidate_version=version, database_url=DATABASE_URL, output_root=backend_root / "model_comparisons",
            imgsz=int(os.getenv("MODEL_COMPARE_IMGSZ", "640")), batch=int(os.getenv("MODEL_COMPARE_BATCH", "8")),
            device=os.getenv("MODEL_COMPARE_DEVICE", "cpu"), workers=int(os.getenv("MODEL_COMPARE_WORKERS", "0")),
            seed=0, verbose=False,
        )
        summary = compare(args)
        return _finalize_candidate_comparison(version, {
            "comparison_id": summary["comparison_id"],
            "candidate_outperforms_active": summary["candidate_outperforms_active"],
            "metric_differences": summary["metric_differences"],
        })

    return _start_lifecycle_job("COMPARE", operation)


def _rollback_comparison_record(comparison_id: str):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT c.id, c.created_at, c.dataset_version,
                       c.dataset_content_sha256, c.validation_split_sha256,
                       c.evaluation_parameters, c.active_metrics,
                       c.candidate_metrics, c.metric_differences,
                       c.class_comparison, c.shared_class_comparison,
                       c.added_class_metrics, c.comparison_rule,
                       c.candidate_outperforms_active, c.summary_path,
                       a.id AS active_model_id, a.version AS active_model_version,
                       t.id AS rollback_target_id,
                       t.version AS rollback_target_version
                FROM model_comparisons c
                JOIN model_versions a ON a.id = c.active_model_id
                JOIN model_versions t ON t.id = c.candidate_model_id
                WHERE c.id = %s;
                """,
                (comparison_id,),
            )
            row = cur.fetchone()
    if not row:
        raise RuntimeError("Persisted rollback comparison is unavailable")
    classes = row["class_comparison"] or {}
    return {
        "comparison_id": row["id"],
        "comparison_type": "rollback_target_vs_active",
        "created_at": row["created_at"],
        "dataset_version": row["dataset_version"],
        "dataset_content_sha256": row["dataset_content_sha256"],
        "validation_split_sha256": row["validation_split_sha256"],
        "evaluation_parameters": row["evaluation_parameters"],
        "active_model": {
            "id": row["active_model_id"],
            "version": row["active_model_version"],
        },
        "rollback_target": {
            "id": row["rollback_target_id"],
            "version": row["rollback_target_version"],
        },
        "active_metrics": row["active_metrics"],
        "rollback_target_metrics": row["candidate_metrics"],
        "metric_differences": row["metric_differences"],
        "class_comparison": {
            "active_classes": classes.get("active_classes", []),
            "rollback_target_classes": classes.get("candidate_classes", []),
            "shared_classes": classes.get("shared_classes", []),
            "only_in_active": classes.get("removed_classes", []),
            "only_in_rollback_target": classes.get("added_classes", []),
        },
        "shared_class_comparison": row["shared_class_comparison"],
        "added_class_metrics": row["added_class_metrics"],
        "comparison_rule": row["comparison_rule"],
        "candidate_outperforms_active": row["candidate_outperforms_active"],
        "summary_path": row["summary_path"],
    }


def get_rollback_target_comparison(version: str):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, version, dataset_version
                FROM model_versions
                WHERE status = 'active' LIMIT 1;
                """
            )
            active = cur.fetchone()
            cur.execute(
                """
                SELECT m.id, m.version, m.dataset_version
                FROM model_versions m
                WHERE m.version = %s
                  AND m.status = 'archived'
                  AND EXISTS (
                      SELECT 1 FROM model_activation_history h
                      WHERE h.from_model_id = m.id OR h.to_model_id = m.id
                  );
                """,
                (version,),
            )
            target = cur.fetchone()
    if not active:
        raise HTTPException(status_code=409, detail="No current active model is registered")
    if not target:
        raise HTTPException(status_code=409, detail="A valid previous production model is required")

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id
                FROM model_comparisons
                WHERE active_model_id = %s
                  AND candidate_model_id = %s
                ORDER BY created_at DESC, id DESC
                LIMIT 1;
                """,
                (active["id"], target["id"]),
            )
            cached = cur.fetchone()
    if not cached:
        return {"available": False, "comparison": None}
    return {
        "available": True,
        "comparison": _rollback_comparison_record(cached["id"]),
    }


def get_lifecycle_job(job_id: str):
    with _LIFECYCLE_JOB_LOCK:
        job = _LIFECYCLE_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Lifecycle job not found")
        return dict(job)
