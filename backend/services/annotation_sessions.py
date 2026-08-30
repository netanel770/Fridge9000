"""Pending Teach Fridge correction-session helpers.

A label correction and a bounding-box correction for the same source detection
belong to one moderation submission. The underlying annotation rows remain
separate so the training exporter can continue applying RELABEL and ADJUST_BOX
cumulatively.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from psycopg2.extras import RealDictCursor

try:
    from db.connection import get_conn
    from services import annotations
except ModuleNotFoundError:
    from backend.db.connection import get_conn
    from backend.services import annotations


_COMBINABLE_ACTIONS = {"RELABEL", "ADJUST_BOX"}


def _related_pending_submission_ids(
    cur,
    household_id: int,
    user_id: int | None,
    scan_id: int,
    source_detection_id: int,
) -> list[int]:
    cur.execute(
        """
        SELECT DISTINCT s.id, s.created_at
        FROM annotation_submissions s
        JOIN annotations a ON a.submission_id = s.id
        WHERE s.household_id = %s
          AND s.created_by_user_id IS NOT DISTINCT FROM %s
          AND s.scan_id = %s
          AND s.status = 'pending'
          AND a.source_detection_id = %s
          AND a.action IN ('RELABEL', 'ADJUST_BOX')
          AND NOT EXISTS (
              SELECT 1
              FROM annotations other
              WHERE other.submission_id = s.id
                AND (
                    other.source_detection_id IS DISTINCT FROM %s
                    OR other.action NOT IN ('RELABEL', 'ADJUST_BOX')
                )
          )
        ORDER BY s.created_at, s.id;
        """,
        (
            household_id,
            user_id,
            scan_id,
            source_detection_id,
            source_detection_id,
        ),
    )
    return [int(row["id"]) for row in cur.fetchall()]


def _merge_related_pending_submissions(
    cur,
    household_id: int,
    user_id: int | None,
    scan_id: int,
    source_detection_id: int,
) -> int | None:
    submission_ids = _related_pending_submission_ids(
        cur,
        household_id,
        user_id,
        scan_id,
        source_detection_id,
    )
    if not submission_ids:
        return None

    target_submission_id = submission_ids[0]
    if len(submission_ids) == 1:
        return target_submission_id

    cur.execute(
        """
        SELECT *
        FROM annotations
        WHERE submission_id = ANY(%s)
          AND source_detection_id = %s
          AND action IN ('RELABEL', 'ADJUST_BOX')
        ORDER BY created_at, id;
        """,
        (submission_ids, source_detection_id),
    )
    rows = cur.fetchall()

    # If older test data contains duplicate actions, preserve the newest version
    # of each action before collapsing the submissions.
    keep_by_action: dict[str, dict[str, Any]] = {}
    for row in rows:
        keep_by_action[row["action"]] = row

    keep_ids = {int(row["id"]) for row in keep_by_action.values()}
    stale_ids = [int(row["id"]) for row in rows if int(row["id"]) not in keep_ids]
    if stale_ids:
        cur.execute("DELETE FROM annotations WHERE id = ANY(%s);", (stale_ids,))

    if keep_ids:
        cur.execute(
            "UPDATE annotations SET submission_id = %s WHERE id = ANY(%s);",
            (target_submission_id, list(keep_ids)),
        )

    redundant_submission_ids = submission_ids[1:]
    if redundant_submission_ids:
        cur.execute(
            "DELETE FROM annotation_submissions WHERE id = ANY(%s);",
            (redundant_submission_ids,),
        )

    return target_submission_id


def _reconcile_pending_sessions(
    household_id: int | None = None,
    user_id: int | None = None,
) -> None:
    predicates = ["s.status = 'pending'", "a.action IN ('RELABEL', 'ADJUST_BOX')"]
    params: list[Any] = []
    if household_id is not None:
        predicates.append("s.household_id = %s")
        params.append(household_id)
    if user_id is not None:
        predicates.append("s.created_by_user_id IS NOT DISTINCT FROM %s")
        params.append(user_id)

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"""
                SELECT DISTINCT
                    s.household_id,
                    s.created_by_user_id,
                    s.scan_id,
                    a.source_detection_id
                FROM annotation_submissions s
                JOIN annotations a ON a.submission_id = s.id
                WHERE {' AND '.join(predicates)}
                  AND a.source_detection_id IS NOT NULL;
                """,
                params,
            )
            groups = cur.fetchall()
            for group in groups:
                _merge_related_pending_submissions(
                    cur,
                    int(group["household_id"]),
                    group["created_by_user_id"],
                    int(group["scan_id"]),
                    int(group["source_detection_id"]),
                )
        conn.commit()


def _update_annotation_row(cur, annotation_id: int, prepared: dict[str, Any]):
    cur.execute(
        """
        UPDATE annotations SET
            source_detection_id = %s,
            action = %s,
            original_label = %s,
            final_label = %s,
            original_confidence = %s,
            original_x1 = %s,
            original_y1 = %s,
            original_x2 = %s,
            original_y2 = %s,
            final_x1 = %s,
            final_y1 = %s,
            final_x2 = %s,
            final_y2 = %s
        WHERE id = %s
        RETURNING *;
        """,
        (
            prepared["source_detection_id"],
            prepared["action"],
            prepared["original_label"],
            prepared["final_label"],
            prepared["original_confidence"],
            prepared["original_x1"],
            prepared["original_y1"],
            prepared["original_x2"],
            prepared["original_y2"],
            prepared["final_x1"],
            prepared["final_y1"],
            prepared["final_x2"],
            prepared["final_y2"],
            annotation_id,
        ),
    )
    return cur.fetchone()


def create_annotation_submission(
    scan_id: int,
    payload: dict[str, Any],
    household_id: int = 1,
    user_id: int | None = None,
):
    annotation_payloads = payload.get("annotations", [])
    if (
        not isinstance(annotation_payloads, list)
        or len(annotation_payloads) != 1
        or not isinstance(annotation_payloads[0], dict)
    ):
        return annotations.create_annotation_submission(
            scan_id, payload, household_id, user_id
        )

    raw = annotation_payloads[0]
    action = str(raw.get("action") or "").strip().upper()
    source_detection_id = raw.get("source_detection_id")
    if action not in _COMBINABLE_ACTIONS or source_detection_id is None:
        return annotations.create_annotation_submission(
            scan_id, payload, household_id, user_id
        )

    try:
        source_detection_id = int(source_detection_id)
    except (TypeError, ValueError):
        return annotations.create_annotation_submission(
            scan_id, payload, household_id, user_id
        )

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, image_width, image_height
                FROM scans
                WHERE id = %s
                  AND household_id = %s
                  AND (
                      created_by_user_id = %s
                      OR (household_id = 1 AND created_by_user_id IS NULL)
                  );
                """,
                (scan_id, household_id, user_id),
            )
            scan = cur.fetchone()
            if not scan:
                raise HTTPException(status_code=404, detail="Scan not found")
            if not scan["image_width"] or not scan["image_height"]:
                raise HTTPException(
                    status_code=409,
                    detail="Scan image dimensions are not available",
                )

            prepared = annotations._prepare_annotation(
                cur,
                scan_id,
                int(scan["image_width"]),
                int(scan["image_height"]),
                raw,
            )

            target_submission_id = _merge_related_pending_submissions(
                cur,
                household_id,
                user_id,
                scan_id,
                source_detection_id,
            )

            if target_submission_id is None:
                conn.rollback()
                return annotations.create_annotation_submission(
                    scan_id, payload, household_id, user_id
                )

            # Preserve the original rule that a non-rejected correction elsewhere
            # blocks a conflicting second correction for the same action.
            cur.execute(
                """
                SELECT a.id, s.id AS submission_id
                FROM annotations a
                JOIN annotation_submissions s ON s.id = a.submission_id
                WHERE a.action = %s
                  AND a.source_detection_id = %s
                  AND s.status <> 'rejected'
                  AND s.id <> %s
                LIMIT 1;
                """,
                (action, source_detection_id, target_submission_id),
            )
            if cur.fetchone():
                raise HTTPException(
                    status_code=409,
                    detail=f"A {action} correction already exists for this detection",
                )

            cur.execute(
                """
                SELECT id
                FROM annotations
                WHERE submission_id = %s
                  AND source_detection_id = %s
                  AND action = %s
                LIMIT 1;
                """,
                (target_submission_id, source_detection_id, action),
            )
            existing = cur.fetchone()
            if existing:
                _update_annotation_row(cur, int(existing["id"]), prepared)
            else:
                annotations._insert_annotation(
                    cur, target_submission_id, prepared
                )

            cur.execute(
                "SELECT * FROM annotation_submissions WHERE id = %s;",
                (target_submission_id,),
            )
            submission = cur.fetchone()
            cur.execute(
                "SELECT * FROM annotations WHERE submission_id = %s ORDER BY id;",
                (target_submission_id,),
            )
            merged_annotations = cur.fetchall()
        conn.commit()

    return {
        "ok": True,
        "submission": submission,
        "annotations": merged_annotations,
        "merged_pending_submission": True,
    }


def _enrich_submissions(rows):
    enriched = [dict(row) for row in rows]
    user_ids = sorted(
        {
            int(row["created_by_user_id"])
            for row in enriched
            if row.get("created_by_user_id") is not None
        }
    )
    users: dict[int, dict[str, Any]] = {}
    if user_ids:
        with get_conn() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT id, display_name, email
                    FROM users
                    WHERE id = ANY(%s);
                    """,
                    (user_ids,),
                )
                users = {int(row["id"]): dict(row) for row in cur.fetchall()}

    for row in enriched:
        user = users.get(int(row["created_by_user_id"])) if row.get("created_by_user_id") is not None else None
        row["submitter_display_name"] = user.get("display_name") if user else None
        row["submitter_email"] = user.get("email") if user else None
    return enriched


def list_annotation_submissions(
    status: str | None = None,
    include_archived: bool = False,
):
    _reconcile_pending_sessions()
    return _enrich_submissions(
        annotations.list_annotation_submissions(status, include_archived)
    )


def list_my_annotation_submissions(
    household_id: int,
    user_id: int,
    status: str | None = None,
):
    _reconcile_pending_sessions(household_id, user_id)
    return _enrich_submissions(
        annotations.list_my_annotation_submissions(household_id, user_id, status)
    )


def _enrich_detail(detail):
    detail = dict(detail)
    submission = _enrich_submissions([detail["submission"]])[0]
    return {
        "submission": submission,
        "annotations": detail["annotations"],
    }


def get_annotation_submission(submission_id: int):
    return _enrich_detail(annotations.get_annotation_submission(submission_id))


def get_my_annotation_submission(
    submission_id: int,
    household_id: int,
    user_id: int,
):
    return _enrich_detail(
        annotations.get_my_annotation_submission(
            submission_id, household_id, user_id
        )
    )
