import os
import threading
import uuid

import cv2
import numpy as np
from fastapi import File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from psycopg2.extras import RealDictCursor
from ultralytics import SAM

try:
    from core.config import OUTLINE_DIR, SEGMENTATION_MODEL_PATH, UPLOAD_DIR
    from db.connection import get_conn
except ModuleNotFoundError:
    from backend.core.config import OUTLINE_DIR, SEGMENTATION_MODEL_PATH, UPLOAD_DIR
    from backend.db.connection import get_conn


_SAM_MODEL = None
_SAM_LOCK = threading.Lock()
_OUTLINE_JOB_LOCK = threading.Lock()
_OUTLINE_JOBS = {}
_ACTIVE_OUTLINE_JOB_ID = None


def get_segmentation_model():
    global _SAM_MODEL
    if _SAM_MODEL is None:
        if not os.path.exists(SEGMENTATION_MODEL_PATH):
            raise RuntimeError(f"Segmentation model is missing: {SEGMENTATION_MODEL_PATH}")
        _SAM_MODEL = SAM(SEGMENTATION_MODEL_PATH)
    return _SAM_MODEL


def expanded_box(box, width: int, height: int, expansion: float):
    x1, y1, x2, y2 = [float(value) for value in box]
    box_width = max(1.0, x2 - x1)
    box_height = max(1.0, y2 - y1)
    return [
        max(0, int(x1 - box_width * expansion)),
        max(0, int(y1 - box_height * expansion)),
        min(width - 1, int(x2 + box_width * expansion)),
        min(height - 1, int(y2 + box_height * expansion)),
    ]


def clean_and_score_mask(raw_mask: np.ndarray, prompt_box, detection_confidence: float):
    mask = (raw_mask > 0.5).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return None, 0.0, True

    component_index = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    largest_area = int(stats[component_index, cv2.CC_STAT_AREA])
    total_area = int(mask.sum())
    if largest_area < 400 or total_area <= 0:
        return None, 0.0, True

    cleaned = (labels == component_index).astype(np.uint8)
    x = int(stats[component_index, cv2.CC_STAT_LEFT])
    y = int(stats[component_index, cv2.CC_STAT_TOP])
    width = int(stats[component_index, cv2.CC_STAT_WIDTH])
    height = int(stats[component_index, cv2.CC_STAT_HEIGHT])
    x2 = x + width
    y2 = y + height
    px1, py1, px2, py2 = prompt_box
    tolerance = max(3, int(min(width, height) * 0.025))
    touches_prompt = (
        abs(x - px1) <= tolerance
        or abs(y - py1) <= tolerance
        or abs(x2 - px2) <= tolerance
        or abs(y2 - py2) <= tolerance
    )
    component_purity = largest_area / total_area
    prompt_area = max(1, (px2 - px1) * (py2 - py1))
    coverage = min(1.0, largest_area / prompt_area)
    solidity_contours, _ = cv2.findContours(cleaned, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    solidity = 0.0
    if solidity_contours:
        contour = max(solidity_contours, key=cv2.contourArea)
        hull = cv2.convexHull(contour)
        hull_area = cv2.contourArea(hull)
        if hull_area > 0:
            solidity = min(1.0, cv2.contourArea(contour) / hull_area)
    quality = (
        0.4 * max(0.0, min(1.0, detection_confidence))
        + 0.25 * component_purity
        + 0.2 * coverage
        + 0.15 * solidity
        - (0.12 if touches_prompt else 0.0)
    )
    return cleaned, quality, touches_prompt


def segment_product_outline(image_path: str, initial_box, detection_confidence: float = 1.0):
    image = cv2.imread(image_path)
    if image is None:
        raise RuntimeError("Source image could not be read")
    image_height, image_width = image.shape[:2]
    best_mask = None
    best_quality = 0.0

    for expansion in (0.15, 0.3, 0.5, 0.75):
        prompt_box = expanded_box(initial_box, image_width, image_height, expansion)
        with _SAM_LOCK:
            results = get_segmentation_model()(
                image_path,
                bboxes=prompt_box,
                verbose=False,
            )
        if not results or results[0].masks is None:
            continue
        masks = results[0].masks.data.cpu().numpy()
        for raw_mask in masks:
            if raw_mask.shape != (image_height, image_width):
                raw_mask = cv2.resize(raw_mask, (image_width, image_height), interpolation=cv2.INTER_NEAREST)
            cleaned, quality, touches_prompt = clean_and_score_mask(
                raw_mask,
                prompt_box,
                detection_confidence,
            )
            if cleaned is not None and quality > best_quality:
                best_mask = cleaned
                best_quality = quality
            if cleaned is not None and not touches_prompt and quality >= 0.58:
                return image, cleaned, quality

    if best_mask is None or best_quality < 0.35:
        raise RuntimeError("No reliable product mask was produced")
    return image, best_mask, best_quality


def save_stylized_outline(item_id: int, mask: np.ndarray):
    points = cv2.findNonZero(mask)
    if points is None:
        raise RuntimeError("Product mask is empty")
    x, y, width, height = cv2.boundingRect(points)
    padding = max(8, int(max(width, height) * 0.06))
    x1 = max(0, x - padding)
    y1 = max(0, y - padding)
    x2 = min(mask.shape[1], x + width + padding)
    y2 = min(mask.shape[0], y + height + padding)
    cropped_mask = (mask[y1:y2, x1:x2] * 255).astype(np.uint8)

    outline = np.zeros((cropped_mask.shape[0], cropped_mask.shape[1], 4), dtype=np.uint8)
    outline[cropped_mask > 0] = (133, 89, 7, 235)
    stripe_mask = np.zeros_like(cropped_mask)
    for start_x in range(-cropped_mask.shape[0], cropped_mask.shape[1], 28):
        cv2.line(
            stripe_mask,
            (start_x, cropped_mask.shape[0]),
            (start_x + cropped_mask.shape[0], 0),
            255,
            4,
        )
    stripe_pixels = (stripe_mask > 0) & (cropped_mask > 0)
    outline[stripe_pixels] = (255, 255, 255, 225)
    contours, _ = cv2.findContours(cropped_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(outline, contours, -1, (39, 31, 17, 255), max(3, int(max(width, height) * 0.014)))
    output_path = os.path.join(OUTLINE_DIR, f"item_{item_id}.png")
    if not cv2.imwrite(output_path, outline):
        raise RuntimeError("Could not save product outline")
    return output_path


def store_outline_record(item_id: int, path: str, quality: float, source_detection_id=None):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO representative_outlines(
                    item_id, image_path, quality_score, source_detection_id, style_version, updated_at
                )
                VALUES (%s, %s, %s, %s, 2, NOW())
                ON CONFLICT (item_id) DO UPDATE
                SET image_path = EXCLUDED.image_path,
                    quality_score = EXCLUDED.quality_score,
                    source_detection_id = EXCLUDED.source_detection_id,
                    style_version = 2,
                    updated_at = NOW();
                """,
                (item_id, path, quality, source_detection_id),
            )
            conn.commit()


def ensure_item_outline(item_id: int):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT image_path, style_version FROM representative_outlines WHERE item_id = %s;",
                (item_id,),
            )
            stored = cur.fetchone()
            if stored and stored["style_version"] >= 2 and os.path.exists(stored["image_path"]):
                return stored["image_path"]
            cur.execute(
                """
                SELECT d.id, d.confidence, d.x1, d.y1, d.x2, d.y2, s.image_ref
                FROM items i
                JOIN scan_detections d ON LOWER(d.label) = LOWER(i.name)
                JOIN scans s ON s.id = d.scan_id
                WHERE i.id = %s
                  AND d.x1 IS NOT NULL AND d.y1 IS NOT NULL
                  AND d.x2 IS NOT NULL AND d.y2 IS NOT NULL
                ORDER BY d.confidence DESC, d.created_at DESC
                LIMIT 5;
                """,
                (item_id,),
            )
            candidates = cur.fetchall()

    best = None
    for candidate in candidates:
        try:
            _, mask, quality = segment_product_outline(
                candidate["image_ref"],
                [candidate["x1"], candidate["y1"], candidate["x2"], candidate["y2"]],
                float(candidate["confidence"]),
            )
            if best is None or quality > best[0]:
                best = (quality, mask, candidate["id"])
            if best[0] >= 0.78:
                break
        except Exception:
            continue
    if best is None:
        raise RuntimeError("No suitable scan was available for a product outline")
    output_path = save_stylized_outline(item_id, best[1])
    store_outline_record(item_id, output_path, best[0], best[2])
    return output_path


def outline_job_snapshot(job_id: str):
    with _OUTLINE_JOB_LOCK:
        job = _OUTLINE_JOBS.get(job_id)
        return dict(job) if job else None


def run_outline_preparation_job(job_id: str):
    global _ACTIVE_OUTLINE_JOB_ID
    try:
        with get_conn() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT i.id, i.name,
                           EXISTS (
                               SELECT 1 FROM scan_detections d
                               WHERE LOWER(d.label) = LOWER(i.name)
                                 AND d.x1 IS NOT NULL AND d.y1 IS NOT NULL
                                 AND d.x2 IS NOT NULL AND d.y2 IS NOT NULL
                           ) AS has_scan
                    FROM items i
                    JOIN inventory_batches b ON b.item_id = i.id
                    WHERE b.quantity > 0
                    GROUP BY i.id, i.name
                    ORDER BY i.name;
                    """
                )
                products = cur.fetchall()

        with _OUTLINE_JOB_LOCK:
            job = _OUTLINE_JOBS[job_id]
            job.update({
                "status": "running",
                "phase": "checking",
                "message": "Checking saved outlines and available scans.",
                "total": len(products),
            })

        for index, product in enumerate(products, start=1):
            with _OUTLINE_JOB_LOCK:
                job = _OUTLINE_JOBS[job_id]
                job.update({
                    "phase": "segmenting",
                    "current_product": product["name"],
                    "message": f"Creating and validating the outline for {product['name']}.",
                })

            with get_conn() as conn:
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute(
                        "SELECT image_path, style_version FROM representative_outlines WHERE item_id = %s;",
                        (product["id"],),
                    )
                    stored = cur.fetchone()

            if stored and stored["style_version"] >= 2 and os.path.exists(stored["image_path"]):
                result = "cached"
            elif not product["has_scan"]:
                result = "skipped"
            else:
                try:
                    ensure_item_outline(product["id"])
                    result = "generated"
                except Exception as exc:
                    result = "failed"
                    with _OUTLINE_JOB_LOCK:
                        _OUTLINE_JOBS[job_id]["failures"].append({
                            "item_id": product["id"],
                            "name": product["name"],
                            "reason": str(exc),
                        })

            with _OUTLINE_JOB_LOCK:
                job = _OUTLINE_JOBS[job_id]
                job["processed"] = index
                if result in ("cached", "generated"):
                    job["ready"] += 1
                elif result == "skipped":
                    job["skipped"] += 1
                else:
                    job["failed"] += 1
                job["progress"] = round((index / max(1, len(products))) * 100)

        with _OUTLINE_JOB_LOCK:
            _OUTLINE_JOBS[job_id].update({
                "status": "complete",
                "phase": "complete",
                "current_product": None,
                "progress": 100,
                "message": "Outline preparation is complete.",
            })
    except Exception as exc:
        with _OUTLINE_JOB_LOCK:
            _OUTLINE_JOBS[job_id].update({
                "status": "error",
                "phase": "error",
                "message": str(exc),
            })
    finally:
        with _OUTLINE_JOB_LOCK:
            if _ACTIVE_OUTLINE_JOB_ID == job_id:
                _ACTIVE_OUTLINE_JOB_ID = None

def get_item_representative_image(item_id: int, generate: bool = True):
    if not generate:
        with get_conn() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    "SELECT image_path, style_version FROM representative_outlines WHERE item_id = %s;",
                    (item_id,),
                )
                stored = cur.fetchone()
        if not stored or stored["style_version"] < 2 or not os.path.exists(stored["image_path"]):
            raise HTTPException(status_code=404, detail="No stored product outline")
        return FileResponse(stored["image_path"], media_type="image/png")
    try:
        outline_path = ensure_item_outline(item_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return FileResponse(outline_path, media_type="image/png")


def start_outline_preparation():
    global _ACTIVE_OUTLINE_JOB_ID
    with _OUTLINE_JOB_LOCK:
        if _ACTIVE_OUTLINE_JOB_ID:
            active = _OUTLINE_JOBS.get(_ACTIVE_OUTLINE_JOB_ID)
            if active and active["status"] in ("queued", "running"):
                return dict(active)

        job_id = uuid.uuid4().hex
        job = {
            "job_id": job_id,
            "status": "queued",
            "phase": "starting",
            "message": "Starting product-outline preparation.",
            "current_product": None,
            "total": 0,
            "processed": 0,
            "ready": 0,
            "skipped": 0,
            "failed": 0,
            "progress": 0,
            "failures": [],
        }
        _OUTLINE_JOBS[job_id] = job
        _ACTIVE_OUTLINE_JOB_ID = job_id

    worker = threading.Thread(
        target=run_outline_preparation_job,
        args=(job_id,),
        daemon=True,
    )
    worker.start()
    return dict(job)


def get_outline_preparation_job(job_id: str):
    job = outline_job_snapshot(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Outline preparation job not found")
    return job


async def upload_item_representative_image(item_id: int, file: UploadFile = File(...)):
    if file.content_type not in ("image/jpeg", "image/png", "image/webp"):
        raise HTTPException(status_code=400, detail="A JPEG, PNG, or WebP image is required")
    contents = await file.read()
    if not contents or len(contents) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image must be between 1 byte and 10 MB")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM items WHERE id = %s;", (item_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Product not found")

    source_dir = os.path.join(UPLOAD_DIR, "product_sources")
    os.makedirs(source_dir, exist_ok=True)
    extension = os.path.splitext(file.filename or "product.jpg")[1].lower()
    if extension not in (".jpg", ".jpeg", ".png", ".webp"):
        extension = ".jpg"
    source_path = os.path.join(source_dir, f"item_{item_id}_{uuid.uuid4().hex}{extension}")
    with open(source_path, "wb") as output:
        output.write(contents)

    image = cv2.imread(source_path)
    if image is None:
        raise HTTPException(status_code=400, detail="The uploaded image could not be read")
    height, width = image.shape[:2]
    prompt_box = [
        int(width * 0.03),
        int(height * 0.03),
        int(width * 0.97),
        int(height * 0.97),
    ]
    try:
        _, mask, quality = segment_product_outline(source_path, prompt_box, 1.0)
        outline_path = save_stylized_outline(item_id, mask)
        store_outline_record(item_id, outline_path, quality, None)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not isolate the product: {exc}")
    return {"ok": True, "quality_score": quality}
