import math
import os
import uuid
from typing import Any, Dict, List, Optional

from fastapi import File, HTTPException, UploadFile
from psycopg2.extras import RealDictCursor

try:
    from core.config import UPLOAD_DIR
    from db.connection import get_conn
    from services.media_images import normalize_uploaded_image
except ModuleNotFoundError:
    from backend.core.config import UPLOAD_DIR
    from backend.db.connection import get_conn
    from backend.services.media_images import normalize_uploaded_image


_normalize_uploaded_image = normalize_uploaded_image


ANNOTATION_ACTIONS = {"CONFIRM", "RELABEL", "ADJUST_BOX", "ADD", "REMOVE"}
ANNOTATION_STATUSES = {"pending", "approved", "rejected", "used"}


async def upload_annotation_image(file: UploadFile = File(...)):
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded image is empty")
    normalized_contents, extension, image_width, image_height = _normalize_uploaded_image(
        contents, file.content_type or ""
    )
    file_path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4()}.{extension}")
    try:
        with open(file_path, "wb") as destination:
            destination.write(normalized_contents)
        with get_conn() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    INSERT INTO scans(image_ref, image_width, image_height, source)
                    VALUES (%s, %s, %s, 'manual_annotation')
                    RETURNING id, image_width, image_height, source, created_at;
                    """,
                    (file_path, image_width, image_height),
                )
                scan = cur.fetchone()
                conn.commit()
    except Exception as exc:
        if os.path.exists(file_path):
            os.remove(file_path)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "ok": True,
        "scan_id": scan["id"],
        "image_width": scan["image_width"],
        "image_height": scan["image_height"],
        "source": scan["source"],
        "image_url": f"/scans/{scan['id']}/image",
        "created_at": scan["created_at"],
    }


def _parse_annotation_box(payload: Dict[str, Any], prefix: str) -> Optional[Dict[str, float]]:
    keys = [f"{prefix}_x1", f"{prefix}_y1", f"{prefix}_x2", f"{prefix}_y2"]
    values = [payload.get(key) for key in keys]
    if all(value is None for value in values):
        return None
    if any(value is None for value in values):
        raise HTTPException(status_code=400, detail=f"All {prefix} bounding-box coordinates are required")
    try:
        x1, y1, x2, y2 = [float(value) for value in values]
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{prefix} bounding-box coordinates must be numbers")
    if not all(math.isfinite(value) for value in (x1, y1, x2, y2)):
        raise HTTPException(status_code=400, detail=f"{prefix} bounding-box coordinates must be finite")
    if x2 <= x1 or y2 <= y1:
        raise HTTPException(status_code=400, detail=f"{prefix} bounding box must have positive width and height")
    return {"x1": x1, "y1": y1, "x2": x2, "y2": y2}


def _validate_final_annotation_box(box, image_width: int, image_height: int):
    if box is None:
        return
    if box["x1"] < 0 or box["y1"] < 0 or box["x2"] > image_width or box["y2"] > image_height:
        raise HTTPException(status_code=400, detail="Final bounding box must stay inside the scan image")


def _prepare_annotation(cur, scan_id: int, image_width: int, image_height: int, payload: Dict[str, Any]):
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Each annotation must be an object")
    action = str(payload.get("action") or "").strip().upper()
    if action not in ANNOTATION_ACTIONS:
        raise HTTPException(status_code=400, detail="Unsupported annotation action")

    source_detection_id = payload.get("source_detection_id")
    source = None
    if source_detection_id is not None:
        try:
            source_detection_id = int(source_detection_id)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="source_detection_id must be an integer")
        cur.execute(
            """
            SELECT id, scan_id, label, confidence, x1, y1, x2, y2
            FROM scan_detections
            WHERE id = %s;
            """,
            (source_detection_id,),
        )
        source = cur.fetchone()
        if not source or source["scan_id"] != scan_id:
            raise HTTPException(status_code=400, detail="Source detection must belong to the submission scan")

    if action == "ADD" and source_detection_id is not None:
        raise HTTPException(status_code=400, detail="ADD annotations must not reference a source detection")
    if action != "ADD" and source is None:
        raise HTTPException(status_code=400, detail=f"{action} requires a source detection")

    final_label = str(payload.get("final_label") or "").strip() or None
    if action in ("RELABEL", "ADD") and not final_label:
        raise HTTPException(status_code=400, detail=f"{action} requires a non-empty final label")
    if final_label is None and source is not None and action != "REMOVE":
        final_label = source["label"]

    final_box = _parse_annotation_box(payload, "final")
    if final_box is None and source is not None and action not in ("ADJUST_BOX", "REMOVE"):
        source_values = (source["x1"], source["y1"], source["x2"], source["y2"])
        if all(value is not None for value in source_values):
            final_box = dict(zip(("x1", "y1", "x2", "y2"), map(float, source_values)))
    if action in ("ADD", "ADJUST_BOX") and final_box is None:
        raise HTTPException(status_code=400, detail=f"{action} requires a final bounding box")
    _validate_final_annotation_box(final_box, image_width, image_height)
    if action == "ADD" and final_box is not None:
        minimum_size = max(8.0, min(image_width, image_height) * 0.02)
        if final_box["x2"] - final_box["x1"] < minimum_size or final_box["y2"] - final_box["y1"] < minimum_size:
            raise HTTPException(status_code=400, detail="ADD bounding box is too small")

    return {
        "source_detection_id": source_detection_id,
        "action": action,
        "original_label": source["label"] if source else None,
        "final_label": final_label,
        "original_confidence": float(source["confidence"]) if source else None,
        "original_x1": float(source["x1"]) if source and source["x1"] is not None else None,
        "original_y1": float(source["y1"]) if source and source["y1"] is not None else None,
        "original_x2": float(source["x2"]) if source and source["x2"] is not None else None,
        "original_y2": float(source["y2"]) if source and source["y2"] is not None else None,
        "final_x1": final_box["x1"] if final_box else None,
        "final_y1": final_box["y1"] if final_box else None,
        "final_x2": final_box["x2"] if final_box else None,
        "final_y2": final_box["y2"] if final_box else None,
    }


def _insert_annotation(cur, submission_id: int, annotation: Dict[str, Any]):
    cur.execute(
        """
        INSERT INTO annotations(
            submission_id, source_detection_id, action,
            original_label, final_label, original_confidence,
            original_x1, original_y1, original_x2, original_y2,
            final_x1, final_y1, final_x2, final_y2
        ) VALUES (
            %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
        ) RETURNING *;
        """,
        (
            submission_id, annotation["source_detection_id"], annotation["action"],
            annotation["original_label"], annotation["final_label"], annotation["original_confidence"],
            annotation["original_x1"], annotation["original_y1"],
            annotation["original_x2"], annotation["original_y2"],
            annotation["final_x1"], annotation["final_y1"],
            annotation["final_x2"], annotation["final_y2"],
        ),
    )
    return cur.fetchone()


def create_annotation_submission(scan_id: int, payload: Dict[str, Any]):
    annotation_payloads = payload.get("annotations", [])
    if not isinstance(annotation_payloads, list) or not annotation_payloads:
        raise HTTPException(status_code=400, detail="At least one annotation is required")

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, image_width, image_height FROM scans WHERE id = %s;", (scan_id,))
            scan = cur.fetchone()
            if not scan:
                raise HTTPException(status_code=404, detail="Scan not found")
            if not scan["image_width"] or not scan["image_height"]:
                raise HTTPException(status_code=409, detail="Scan image dimensions are not available")

            prepared = [
                _prepare_annotation(cur, scan_id, scan["image_width"], scan["image_height"], item)
                for item in annotation_payloads
            ]
            source_actions = [
                (item["action"], item["source_detection_id"])
                for item in prepared if item["source_detection_id"] is not None
            ]
            if len(source_actions) != len(set(source_actions)):
                raise HTTPException(status_code=409, detail="Duplicate correction for the same detection")
            for action, detection_id in source_actions:
                cur.execute(
                    """
                    SELECT a.id
                    FROM annotations a
                    JOIN annotation_submissions s ON s.id = a.submission_id
                    WHERE a.action = %s AND a.source_detection_id = %s
                      AND s.status <> 'rejected'
                    LIMIT 1;
                    """,
                    (action, detection_id),
                )
                if cur.fetchone():
                    raise HTTPException(status_code=409, detail=f"A {action} correction already exists for this detection")
            cur.execute(
                """
                INSERT INTO annotation_submissions(scan_id, image_width, image_height)
                VALUES (%s, %s, %s)
                RETURNING *;
                """,
                (scan_id, scan["image_width"], scan["image_height"]),
            )
            submission = cur.fetchone()
            annotations = [_insert_annotation(cur, submission["id"], item) for item in prepared]
            conn.commit()
            return {"ok": True, "submission": submission, "annotations": annotations}


def list_annotation_submissions(status: Optional[str] = None, include_archived: bool = False):
    if status is not None and status not in ANNOTATION_STATUSES:
        raise HTTPException(status_code=400, detail="Unsupported submission status")
    sql = """
        SELECT s.*,
               (SELECT COUNT(*) FROM annotations a WHERE a.submission_id = s.id) AS annotation_count,
               s.training_state AS training_lifecycle_state,
               CASE WHEN s.status = 'used' OR EXISTS (
                   SELECT 1 FROM training_run_submission_usage u WHERE u.submission_id = s.id
               ) THEN 'used' ELSE 'not_used' END AS training_status,
               COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                       'dataset_version', u.dataset_version,
                       'training_run_id', u.training_run_id,
                       'model_version', m.version,
                       'model_status', m.status,
                       'used_at', u.used_at
                   ) ORDER BY u.used_at DESC)
                   FROM training_run_submission_usage u
                   JOIN model_versions m ON m.id = u.model_version_id
                   WHERE u.submission_id = s.id
               ), '[]'::jsonb) AS training_usages
        FROM annotation_submissions s
    """
    params = []
    predicates = []
    if not include_archived:
        predicates.append("s.archived_at IS NULL")
    if status == "used":
        predicates.append("(s.status = 'used' OR EXISTS (SELECT 1 FROM training_run_submission_usage u WHERE u.submission_id = s.id))")
    elif status == "approved":
        predicates.append("s.status = 'approved' AND NOT EXISTS (SELECT 1 FROM training_run_submission_usage u WHERE u.submission_id = s.id)")
    elif status is not None:
        predicates.append("s.status = %s")
        params.append(status)
    if predicates:
        sql += " WHERE " + " AND ".join(f"({predicate})" for predicate in predicates)
    sql += " ORDER BY s.created_at DESC, s.id DESC;"
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, params)
            return cur.fetchall()


def get_annotation_submission_stats():
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                    COUNT(*) FILTER (WHERE status = 'approved' AND NOT EXISTS (
                        SELECT 1 FROM training_run_submission_usage u WHERE u.submission_id = annotation_submissions.id
                    )) AS approved,
                    COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
                    COUNT(*) FILTER (WHERE status = 'used' OR EXISTS (
                        SELECT 1 FROM training_run_submission_usage u WHERE u.submission_id = annotation_submissions.id
                    )) AS used
                FROM annotation_submissions;
                """
            )
            submissions = cur.fetchone()
            cur.execute(
                """
                SELECT action, COUNT(*) AS count
                FROM annotations
                GROUP BY action;
                """
            )
            action_rows = cur.fetchall()
            actions = {action: 0 for action in ("CONFIRM", "RELABEL", "ADJUST_BOX", "ADD", "REMOVE")}
            for row in action_rows:
                actions[row["action"]] = row["count"]
            return {"submissions": submissions, "annotations_by_action": actions}

def get_annotation_submission(submission_id: int):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT s.*,
                       s.training_state AS training_lifecycle_state,
                       CASE WHEN s.status = 'used' OR EXISTS (
                           SELECT 1 FROM training_run_submission_usage u WHERE u.submission_id = s.id
                       ) THEN 'used' ELSE 'not_used' END AS training_status,
                       COALESCE((
                           SELECT jsonb_agg(jsonb_build_object(
                               'dataset_version', u.dataset_version,
                               'training_run_id', u.training_run_id,
                               'model_version', m.version,
                               'model_status', m.status,
                               'used_at', u.used_at
                           ) ORDER BY u.used_at DESC)
                           FROM training_run_submission_usage u
                           JOIN model_versions m ON m.id = u.model_version_id
                           WHERE u.submission_id = s.id
                       ), '[]'::jsonb) AS training_usages
                FROM annotation_submissions s WHERE s.id = %s;
                """,
                (submission_id,),
            )
            submission = cur.fetchone()
            if not submission:
                raise HTTPException(status_code=404, detail="Annotation submission not found")
            cur.execute(
                """
                SELECT a.*, COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'dataset_version', u.dataset_version,
                        'training_run_id', u.training_run_id,
                        'model_version', m.version,
                        'model_status', m.status,
                        'used_at', u.used_at
                    ) ORDER BY u.used_at DESC)
                    FROM training_run_annotation_usage u
                    JOIN model_versions m ON m.id = u.model_version_id
                    WHERE u.annotation_id = a.id
                ), '[]'::jsonb) AS training_usages
                FROM annotations a WHERE a.submission_id = %s ORDER BY a.id;
                """,
                (submission_id,),
            )
            return {"submission": submission, "annotations": cur.fetchall()}


def update_annotation_submission(submission_id: int, payload: Dict[str, Any]):
    status = str(payload.get("status") or "").strip().lower()
    if status not in {"approved", "rejected"}:
        raise HTTPException(status_code=400, detail="Status must be approved or rejected")
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM annotation_submissions WHERE id = %s FOR UPDATE;", (submission_id,))
            submission = cur.fetchone()
            if not submission:
                raise HTTPException(status_code=404, detail="Annotation submission not found")
            if submission["status"] != "pending":
                raise HTTPException(status_code=409, detail="Only pending submissions can be updated")
            reviewed_at_sql = "NULL" if status == "pending" else "NOW()"
            cur.execute(
                f"UPDATE annotation_submissions SET status = %s, reviewed_at = {reviewed_at_sql} WHERE id = %s RETURNING *;",
                (status, submission_id),
            )
            updated = cur.fetchone()
            conn.commit()
            return {"ok": True, "submission": updated}


def update_quarantined_submission(submission_id: int, payload: Dict[str, Any]):
    action = str(payload.get("action") or "").strip().lower()
    if action not in {"quarantine", "restore", "archive", "unarchive"}:
        raise HTTPException(status_code=400, detail="Action must be quarantine, restore, archive, or unarchive")
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM annotation_submissions WHERE id = %s FOR UPDATE;",
                (submission_id,),
            )
            submission = cur.fetchone()
            if not submission:
                raise HTTPException(status_code=404, detail="Annotation submission not found")
            if action == "quarantine":
                if submission["training_state"] != "eligible":
                    raise HTTPException(status_code=409, detail="Only eligible submissions can be quarantined")
                if submission["status"] not in {"approved", "used"}:
                    raise HTTPException(status_code=409, detail="Only approved eligible submissions can be quarantined")
                cur.execute(
                    "UPDATE annotation_submissions SET training_state = 'quarantined', archived_at = NULL WHERE id = %s RETURNING *;",
                    (submission_id,),
                )
            elif submission["training_state"] != "quarantined":
                raise HTTPException(status_code=409, detail="Only quarantined submissions can be managed")
            elif action == "restore":
                if submission["status"] not in {"approved", "used"}:
                    raise HTTPException(status_code=409, detail="Only approved quarantined submissions can be restored")
                cur.execute(
                    "UPDATE annotation_submissions SET training_state = 'eligible', archived_at = NULL WHERE id = %s RETURNING *;",
                    (submission_id,),
                )
            elif action == "archive":
                if submission["archived_at"] is not None:
                    raise HTTPException(status_code=409, detail="Submission is already archived")
                cur.execute(
                    """
                    UPDATE annotation_submissions
                    SET archived_at = NOW()
                    WHERE id = %s RETURNING *;
                    """,
                    (submission_id,),
                )
            else:
                if submission["archived_at"] is None:
                    raise HTTPException(status_code=409, detail="Submission is not archived")
                cur.execute(
                    """
                    UPDATE annotation_submissions
                    SET archived_at = NULL
                    WHERE id = %s RETURNING *;
                    """,
                    (submission_id,),
                )
            updated = cur.fetchone()
        conn.commit()
    return {"ok": True, "action": action.upper(), "submission": updated}


def update_annotation(annotation_id: int, payload: Dict[str, Any]):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT a.*, s.scan_id, s.status, s.image_width, s.image_height
                FROM annotations a
                JOIN annotation_submissions s ON s.id = a.submission_id
                WHERE a.id = %s
                FOR UPDATE OF a, s;
                """,
                (annotation_id,),
            )
            current = cur.fetchone()
            if not current:
                raise HTTPException(status_code=404, detail="Annotation not found")
            if current["status"] != "pending":
                raise HTTPException(status_code=409, detail="Annotations can only be edited while their submission is pending")

            merged = {
                "action": payload.get("action", current["action"]),
                "source_detection_id": payload.get("source_detection_id", current["source_detection_id"]),
                "final_label": payload.get("final_label", current["final_label"]),
                "final_x1": payload.get("final_x1", current["final_x1"]),
                "final_y1": payload.get("final_y1", current["final_y1"]),
                "final_x2": payload.get("final_x2", current["final_x2"]),
                "final_y2": payload.get("final_y2", current["final_y2"]),
            }
            prepared = _prepare_annotation(
                cur, current["scan_id"], current["image_width"], current["image_height"], merged
            )
            if prepared["source_detection_id"] is not None:
                cur.execute(
                    """
                    SELECT a.id
                    FROM annotations a
                    JOIN annotation_submissions s ON s.id = a.submission_id
                    WHERE a.id <> %s
                      AND a.action = %s
                      AND a.source_detection_id = %s
                      AND s.status <> 'rejected'
                    LIMIT 1;
                    """,
                    (
                        annotation_id,
                        prepared["action"],
                        prepared["source_detection_id"],
                    ),
                )
                if cur.fetchone():
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"A {prepared['action']} correction already exists "
                            "for this detection"
                        ),
                    )
            cur.execute(
                """
                UPDATE annotations SET
                    source_detection_id = %s, action = %s,
                    original_label = %s, final_label = %s, original_confidence = %s,
                    original_x1 = %s, original_y1 = %s, original_x2 = %s, original_y2 = %s,
                    final_x1 = %s, final_y1 = %s, final_x2 = %s, final_y2 = %s
                WHERE id = %s
                RETURNING *;
                """,
                (
                    prepared["source_detection_id"], prepared["action"],
                    prepared["original_label"], prepared["final_label"], prepared["original_confidence"],
                    prepared["original_x1"], prepared["original_y1"],
                    prepared["original_x2"], prepared["original_y2"],
                    prepared["final_x1"], prepared["final_y1"],
                    prepared["final_x2"], prepared["final_y2"], annotation_id,
                ),
            )
            updated = cur.fetchone()
            conn.commit()
            return {"ok": True, "annotation": updated}
