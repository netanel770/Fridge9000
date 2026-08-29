import os
import re
import uuid
from typing import Any, Dict

import cv2
from fastapi import File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from psycopg2.extras import RealDictCursor

try:
    from core.config import UPLOAD_DIR
    from db.connection import get_conn
    from services.detection import apply_rules, infer
    from services.inventory import estimate_expiry_date, parse_expiry_date, sync_inventory_summary
    from services.media_images import normalize_uploaded_image
except ModuleNotFoundError:
    from backend.core.config import UPLOAD_DIR
    from backend.db.connection import get_conn
    from backend.services.detection import apply_rules, infer
    from backend.services.inventory import estimate_expiry_date, parse_expiry_date, sync_inventory_summary
    from backend.services.media_images import normalize_uploaded_image

_normalize_uploaded_image = normalize_uploaded_image


async def door_closed_upload(file: UploadFile = File(...)):
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded image is empty")
    normalized_contents, extension, image_width, image_height = _normalize_uploaded_image(
        contents, file.content_type or ""
    )

    file_path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4()}.{extension}")
    try:
        with open(file_path, "wb") as f:
            f.write(normalized_contents)

        result = door_closed({"image_ref": file_path, "conf": 0.25})
        if not result.get("ok"):
            raise HTTPException(
                status_code=400,
                detail=result.get("error") or "Image inference failed",
            )
        if result.get("image_width") != image_width or result.get("image_height") != image_height:
            raise HTTPException(
                status_code=500,
                detail="Detector image dimensions do not match the canonical uploaded image",
            )
        return result

    except HTTPException:
        if os.path.exists(file_path):
            os.remove(file_path)
        raise
    except Exception as e:
        if os.path.exists(file_path):
            os.remove(file_path)
        raise HTTPException(status_code=500, detail=str(e))

def review_scan(scan_id: int, payload: Dict[str, Any]):
    items = payload.get("items", [])
    mode = payload.get("mode", "Added")
    source = payload.get("source", "scan")

    if mode not in ("Added", "Removed"):
        raise HTTPException(status_code=400, detail="mode must be Added or Removed")

    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="items must be a list")

    if source not in ("scan", "receipt"):
        raise HTTPException(status_code=400, detail="source must be scan or receipt")

    included_items_map = {}

    for it in items:
        if not isinstance(it, dict):
            raise HTTPException(status_code=400, detail="Each review item must be an object")
        included = bool(it.get("included", True))
        if not included:
            continue

        label = it.get("final_label") or it.get("original_label")
        confidence = float(it.get("confidence", 1.0))

        try:
            requested_quantity = int(it.get("quantity", 1)) if source == "receipt" else 1
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Receipt quantity must be a whole number")
        if requested_quantity < 1 or requested_quantity > 999:
            raise HTTPException(status_code=400, detail="Receipt quantity must be between 1 and 999")

        if not label:
            continue

        name = label.strip().capitalize()
        expiry_date = parse_expiry_date(it.get("expiry_date"))
        expiry_estimate_date = parse_expiry_date(it.get("expiry_estimate_date"))
        expiry_source = it.get("expiry_source") or ("manual" if expiry_date else "estimated")

        if mode == "Removed":
            without_expiry = expiry_source == "inventory_unknown"
            selected_expiry_date = expiry_date or expiry_estimate_date
            if not selected_expiry_date and not without_expiry:
                raise HTTPException(
                    status_code=400,
                    detail=f"An inventory batch is required when removing {name}",
                )
            expiry_date = None if without_expiry else selected_expiry_date
            expiry_estimate_date = None
            expiry_source = "inventory_unknown" if without_expiry else "inventory"
        elif not expiry_date and not expiry_estimate_date:
            expiry_estimate_date = estimate_expiry_date(name)
            expiry_source = "estimated"

        key = (
            (name, expiry_date, expiry_source)
            if mode == "Removed"
            else (name, expiry_date, expiry_estimate_date, expiry_source)
        )
        if key not in included_items_map:
            included_items_map[key] = {
                "name": name,
                "confidence": confidence,
                "quantity": requested_quantity,
                "expiry_date": expiry_date,
                "expiry_estimate_date": expiry_estimate_date,
                "expiry_source": expiry_source,
            }
        else:
            included_items_map[key]["quantity"] += requested_quantity
            included_items_map[key]["confidence"] = max(
                included_items_map[key]["confidence"],
                confidence,
            )

    included_items = list(included_items_map.values())

    if not included_items:
        raise HTTPException(status_code=400, detail="No included items selected")

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id FROM scans WHERE id = %s FOR UPDATE;", (scan_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Scan not found")
            cur.execute(
                """
                SELECT 1 FROM events
                WHERE scan_id = %s AND action IN ('Added', 'Removed')
                LIMIT 1;
                """,
                (scan_id,),
            )
            if cur.fetchone():
                raise HTTPException(status_code=409, detail="Scan has already been reviewed")

            for it in items:
                try:
                    detection_id = int(it.get("id"))
                except (TypeError, ValueError):
                    raise HTTPException(
                        status_code=400,
                        detail="Each review item must identify a detection",
                    )
                cur.execute(
                    """
                    SELECT label FROM scan_detections
                    WHERE id = %s AND scan_id = %s;
                    """,
                    (detection_id, scan_id),
                )
                detection = cur.fetchone()
                if not detection:
                    raise HTTPException(
                        status_code=400,
                        detail="Review detection does not belong to this scan",
                    )
                original_label = (it.get("original_label") or "").strip()
                if original_label.casefold() != detection["label"].strip().casefold():
                    raise HTTPException(
                        status_code=400,
                        detail="Review original label does not match the detection",
                    )

            for it in items:
                orig = it.get("original_label")
                final = (it.get("final_label") or orig or "").strip().capitalize()
                included = bool(it.get("included", True))

                if orig and final:
                    cur.execute(
                        """
                        INSERT INTO detection_reviews(scan_id, original_label, final_label, included)
                        VALUES (%s, %s, %s, %s);
                        """,
                        (scan_id, orig, final, included),
                    )

            for item_data in included_items:
                name = item_data["name"]
                confidence = item_data["confidence"]
                quantity_change = item_data["quantity"]
                expiry_date = item_data.get("expiry_date")
                expiry_estimate_date = item_data.get("expiry_estimate_date")
                expiry_source = item_data.get("expiry_source") or "estimated"

                cur.execute(
                    "SELECT id, category FROM items WHERE name = %s;",
                    (name,),
                )
                item = cur.fetchone()

                if not item:
                    if mode == "Removed":
                        raise HTTPException(
                            status_code=400,
                            detail=f"{name} is not in inventory",
                        )

                    cur.execute(
                        """
                        INSERT INTO items(name, category)
                        VALUES (%s, %s)
                        RETURNING id;
                        """,
                        (name, "Unknown"),
                    )
                    item_id = cur.fetchone()["id"]
                else:
                    item_id = item["id"]

                if mode == "Removed":
                    if expiry_source == "inventory_unknown":
                        cur.execute(
                            """
                            SELECT id, quantity FROM inventory_batches
                            WHERE item_id = %s
                              AND quantity > 0
                              AND expiry_date IS NULL
                              AND expiry_estimate_date IS NULL
                            ORDER BY created_at
                            FOR UPDATE
                            """,
                            (item_id,),
                        )
                    else:
                        cur.execute(
                            """
                            SELECT id, quantity FROM inventory_batches
                            WHERE item_id = %s
                              AND quantity > 0
                              AND COALESCE(expiry_date, expiry_estimate_date) = %s
                            ORDER BY created_at
                            FOR UPDATE
                            """,
                            (item_id, expiry_date),
                        )
                    batches = cur.fetchall()

                    remaining = quantity_change
                    for batch in batches:
                        if remaining <= 0:
                            break
                        take = min(batch["quantity"], remaining)
                        remaining -= take
                        new_quantity = batch["quantity"] - take
                        cur.execute(
                            """
                            UPDATE inventory_batches
                            SET quantity = %s,
                                open_unit_remaining_percent = NULL,
                                last_updated = NOW()
                            WHERE id = %s;
                            """,
                            (new_quantity, batch["id"]),
                        )

                    if remaining > 0:
                        available = quantity_change - remaining
                        raise HTTPException(
                            status_code=400,
                            detail=(
                                f"Cannot remove {quantity_change} {name} item(s) from "
                                f"{'the unknown-expiry batch' if expiry_source == 'inventory_unknown' else f'expiry date {expiry_date}'}. "
                                f"Only {available} available."
                            ),
                        )
                else:
                    cur.execute(
                        """
                        SELECT id, quantity FROM inventory_batches
                        WHERE item_id = %s
                          AND COALESCE(expiry_date, expiry_estimate_date)::text = COALESCE(%s, %s)::text
                          AND COALESCE(expiry_source, 'estimated') = %s;
                        """,
                        (
                            item_id,
                            expiry_date,
                            expiry_estimate_date,
                            expiry_source,
                        ),
                    )
                    existing_batch = cur.fetchone()

                    if existing_batch:
                        new_quantity = existing_batch["quantity"] + quantity_change
                        cur.execute(
                            """
                            UPDATE inventory_batches
                            SET quantity = %s, last_updated = NOW()
                            WHERE id = %s;
                            """,
                            (new_quantity, existing_batch["id"]),
                        )
                    else:
                        cur.execute(
                            """
                            INSERT INTO inventory_batches(item_id, quantity, expiry_date, expiry_estimate_date, expiry_source)
                            VALUES (%s, %s, %s, %s, %s);
                            """,
                            (
                                item_id,
                                quantity_change,
                                expiry_date,
                                expiry_estimate_date,
                                expiry_source,
                            ),
                        )

                cur.execute(
                    """
                    INSERT INTO events(scan_id, item_id, action, confidence, quantity_change)
                    VALUES (%s, %s, %s, %s, %s);
                    """,
                    (scan_id, item_id, mode, confidence, quantity_change),
                )

            sync_inventory_summary(conn)
            conn.commit()

    return {
        "ok": True,
        "mode": mode,
        "updated_items": included_items,
    }

def get_scan_detections(scan_id: int):
    sql = """
    SELECT id, label, confidence, x1, y1, x2, y2, created_at
    FROM scan_detections
    WHERE scan_id = %s
    ORDER BY confidence DESC;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, (scan_id,))
            return cur.fetchall()

def latest_scan():
    sql = """
    SELECT id, created_at, image_ref
    FROM scans
    WHERE source = 'detector'
    ORDER BY created_at DESC
    LIMIT 1;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            row = cur.fetchone()
            return row or {}


def recent_scans(limit: int = 10):
    limit = max(1, min(limit, 50))
    sql = """
    SELECT s.id, s.created_at, s.image_width, s.image_height,
           COUNT(d.id) AS detection_count
    FROM scans s
    LEFT JOIN scan_detections d ON d.scan_id = s.id
    WHERE s.image_width IS NOT NULL
      AND s.image_height IS NOT NULL
      AND s.source = 'detector'
    GROUP BY s.id
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT %s;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, (limit,))
            return cur.fetchall()


def get_scan(scan_id: int):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT s.id, s.created_at, s.image_width, s.image_height,
                       COUNT(d.id) AS detection_count
                FROM scans s
                LEFT JOIN scan_detections d ON d.scan_id = s.id
                WHERE s.id = %s
                  AND s.image_width IS NOT NULL
                  AND s.image_height IS NOT NULL
                GROUP BY s.id;
                """,
                (scan_id,),
            )
            scan = cur.fetchone()
    if not scan:
        raise HTTPException(status_code=404, detail="Scan not found")
    return scan


def get_scan_image(scan_id: int):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT image_ref
                FROM scans
                WHERE id = %s
                  AND image_width IS NOT NULL
                  AND image_height IS NOT NULL;
                """,
                (scan_id,),
            )
            scan = cur.fetchone()
    if not scan:
        raise HTTPException(status_code=404, detail="Scan image not found")
    image_path = os.path.abspath(scan["image_ref"] or "")
    upload_root = os.path.abspath(UPLOAD_DIR)
    if os.path.commonpath([upload_root, image_path]) != upload_root or not os.path.isfile(image_path):
        raise HTTPException(status_code=404, detail="Scan image file not found")
    extension = os.path.splitext(image_path)[1].lower()
    media_types = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
    media_type = media_types.get(extension)
    if not media_type:
        raise HTTPException(status_code=415, detail="Stored scan is not a supported image")
    return FileResponse(image_path, media_type=media_type)

def create_scan(payload: Dict[str, Any]):

    image_ref = payload.get("image_ref")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO scans(image_ref) VALUES (%s) RETURNING id, created_at;",
                (image_ref,),
            )
            scan_id, created_at = cur.fetchone()
            conn.commit()

    return {"ok": True, "scan_id": scan_id, "created_at": created_at}

def door_closed(payload: Dict[str, Any]):
    image_ref = payload.get("image_ref")
    conf = float(payload.get("conf", 0.25))

    if not image_ref:
        return {"ok": False, "error": "image_ref required"}

    infer_res = infer({"image_ref": image_ref, "conf": conf})

    if not infer_res.get("ok"):
        return {"ok": False, "error": infer_res.get("error")}

    raw_dets = infer_res["detections"]
    filtered_dets = apply_rules(raw_dets)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO scans(image_ref, image_width, image_height, source)
                VALUES (%s, %s, %s, 'detector')
                RETURNING id;
                """,
                (image_ref, infer_res["image_width"], infer_res["image_height"]),
            )
            scan_id = cur.fetchone()[0]

            for d in filtered_dets:
                cur.execute(
                    """
                    INSERT INTO scan_detections(scan_id, label, confidence, x1, y1, x2, y2)
                    VALUES (%s, %s, %s, %s, %s, %s, %s);
                    """,
                    (
                        scan_id,
                        d["item_name"],
                        d["confidence"],
                        d.get("x1"),
                        d.get("y1"),
                        d.get("x2"),
                        d.get("y2"),
                    ),
                                    )

            conn.commit()

    return {
        "ok": True,
        "scan_id": scan_id,
        "detections_count": len(filtered_dets),
        "detections": filtered_dets,
        "image_width": infer_res["image_width"],
        "image_height": infer_res["image_height"],
    }

def get_detection_boxed_image(scan_id: int, detection_id: int):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT s.image_ref, d.x1, d.y1, d.x2, d.y2
                FROM scan_detections d
                JOIN scans s ON s.id = d.scan_id
                WHERE d.scan_id = %s AND d.id = %s;
                """,
                (scan_id, detection_id),
            )
            row = cur.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Detection not found")

    img = cv2.imread(row["image_ref"])

    if img is None:
        raise HTTPException(status_code=404, detail="Image not found")

    h, w = img.shape[:2]

    x1 = max(0, int(row["x1"]))
    y1 = max(0, int(row["y1"]))
    x2 = min(w, int(row["x2"]))
    y2 = min(h, int(row["y2"]))

    cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 255), 8)

    source_token = re.sub(r"[^A-Za-z0-9_-]", "_", os.path.splitext(os.path.basename(row["image_ref"]))[0])[:80]
    boxed_filename = f"boxed_{source_token}_{scan_id}_{detection_id}.jpg"
    boxed_path = os.path.join(UPLOAD_DIR, boxed_filename)
    if not cv2.imwrite(boxed_path, img):
        raise HTTPException(status_code=500, detail="Could not create boxed detection image")

    return FileResponse(boxed_path, media_type="image/jpeg")
