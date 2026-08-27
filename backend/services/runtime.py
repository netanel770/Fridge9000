import os
import math
import threading
from datetime import datetime, date, timedelta
from typing import List, Optional, Dict, Any
from psycopg2.extras import RealDictCursor
from ultralytics import YOLO, SAM
import cv2
import numpy as np
from fastapi import UploadFile, File
import uuid
import json
from fastapi import HTTPException
from fastapi.responses import FileResponse, Response
import pytesseract
from pdf2image import convert_from_path
import re
import logging
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from PIL import Image, ImageOps, UnidentifiedImageError
try:
    from core.config import BACKEND_DIR, DATABASE_URL, FRESHNESS_MAX_UPLOAD_BYTES, FRESHNESS_MODEL_PATH, FRESHNESS_UPLOAD_DIR, MAX_SHARED_MAP50_95_REGRESSION, MIN_ADDED_CLASS_MAP50_95, MIN_ADDED_CLASS_PER_CLASS_MAP50_95, OUTLINE_DIR, RULES_PATH, SEGMENTATION_MODEL_PATH, UPLOAD_DIR
    from db.connection import get_conn
    from freshness import classification_probabilities, parse_freshness_class
    from model_promotion_policy import evaluate_promotion
except ModuleNotFoundError:
    from backend.core.config import BACKEND_DIR, DATABASE_URL, FRESHNESS_MAX_UPLOAD_BYTES, FRESHNESS_MODEL_PATH, FRESHNESS_UPLOAD_DIR, MAX_SHARED_MAP50_95_REGRESSION, MIN_ADDED_CLASS_MAP50_95, MIN_ADDED_CLASS_PER_CLASS_MAP50_95, OUTLINE_DIR, RULES_PATH, SEGMENTATION_MODEL_PATH, UPLOAD_DIR
    from backend.db.connection import get_conn
    from backend.freshness import classification_probabilities, parse_freshness_class
    from backend.model_promotion_policy import evaluate_promotion



MODEL = None
_MODEL_VERSION = None
_MODEL_PATH = None
_MODEL_LOCK = threading.RLock()
LOGGER = logging.getLogger("uvicorn.error")
_FRESHNESS_MODEL = None
_FRESHNESS_MODEL_LOCK = threading.Lock()
_RULES_CACHE = None
_SAM_MODEL = None
_SAM_LOCK = threading.Lock()
_OUTLINE_JOB_LOCK = threading.Lock()
_OUTLINE_JOBS = {}
_ACTIVE_OUTLINE_JOB_ID = None
_LIFECYCLE_JOB_LOCK = threading.Lock()
_LIFECYCLE_JOBS = {}
_ACTIVE_LIFECYCLE_JOB_ID = None


def _normalize_uploaded_image(contents: bytes, content_type: str):
    formats = {
        "image/jpeg": ("JPEG", "jpg"),
        "image/png": ("PNG", "png"),
        "image/webp": ("WEBP", "webp"),
    }
    image_format = formats.get(content_type)
    if not image_format:
        raise HTTPException(status_code=415, detail="Upload a JPEG, PNG, or WebP image")
    try:
        with Image.open(BytesIO(contents)) as source:
            normalized = ImageOps.exif_transpose(source)
            normalized.load()
            if image_format[0] == "JPEG":
                normalized = normalized.convert("RGB")
            elif normalized.mode not in ("RGB", "RGBA"):
                normalized = normalized.convert("RGBA" if "transparency" in source.info else "RGB")
            output = BytesIO()
            save_options = {"quality": 95} if image_format[0] in ("JPEG", "WEBP") else {}
            normalized.save(output, format=image_format[0], **save_options)
            width, height = normalized.size
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Uploaded image could not be decoded") from exc
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="Uploaded image has invalid dimensions")
    return output.getvalue(), image_format[1], width, height


def load_rules():
    global _RULES_CACHE
    if _RULES_CACHE is None:
        with open(RULES_PATH, "r", encoding="utf-8") as f:
            _RULES_CACHE = json.load(f)
    return _RULES_CACHE


def _reconcile_annotation_training_states(cur):
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


def get_freshness_model():
    global _FRESHNESS_MODEL
    if _FRESHNESS_MODEL is not None:
        return _FRESHNESS_MODEL
    with _FRESHNESS_MODEL_LOCK:
        if _FRESHNESS_MODEL is None:
            if not os.path.isfile(FRESHNESS_MODEL_PATH):
                LOGGER.error("Freshness classifier model is missing: %s", FRESHNESS_MODEL_PATH)
                raise RuntimeError("Freshness classifier model is not available.")
            try:
                _FRESHNESS_MODEL = YOLO(FRESHNESS_MODEL_PATH)
            except Exception as exc:
                LOGGER.exception("Freshness classifier model could not be loaded")
                raise RuntimeError("Freshness classifier model could not be loaded.") from exc
            if getattr(_FRESHNESS_MODEL, "task", None) != "classify":
                LOGGER.error("Freshness model has unexpected task: %s", _FRESHNESS_MODEL.task)
                _FRESHNESS_MODEL = None
                raise RuntimeError("Freshness model is not a classification model.")
            LOGGER.info(
                "Freshness classifier loaded from %s with classes: %s",
                FRESHNESS_MODEL_PATH,
                _FRESHNESS_MODEL.names,
            )
    return _FRESHNESS_MODEL


def parse_expiry_date(value: Optional[Any]) -> Optional[date]:
    if not value:
        return None
    if isinstance(value, date):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        text = value.strip()
        for fmt in ("%Y-%m-%d", "%d/%m/%Y"):
            try:
                return datetime.strptime(text, fmt).date()
            except ValueError:
                continue
    return None


def estimate_expiry_date(item_name: str) -> Optional[date]:
    name = (item_name or "").lower()
    if any(token in name for token in ["milk", "yogurt", "cream", "cheese", "butter"]):
        return datetime.utcnow().date() + timedelta(days=7)
    if any(token in name for token in ["meat", "chicken", "fish", "salami", "ham"]):
        return datetime.utcnow().date() + timedelta(days=3)
    if any(token in name for token in ["tomato", "cucumber", "lettuce", "avocado", "apple", "banana", "orange", "carrot", "eggplant"]):
        return datetime.utcnow().date() + timedelta(days=5)
    if any(token in name for token in ["bread", "pita", "bun", "bagel"]):
        return datetime.utcnow().date() + timedelta(days=3)
    return datetime.utcnow().date() + timedelta(days=14)


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
                    reviewed_at TIMESTAMP
                );

                ALTER TABLE annotation_submissions
                    ADD COLUMN IF NOT EXISTS training_state TEXT NOT NULL DEFAULT 'eligible';

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
            _reconcile_annotation_training_states(cur)
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


def sync_inventory_summary(conn):
    with conn.cursor() as cur:
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


def change_inventory_batches(cur, item_id: int, action: str, quantity: int) -> int:
    """Apply a legacy inventory change to the authoritative batch state."""
    cur.execute(
        "SELECT COALESCE(SUM(quantity), 0) AS quantity FROM inventory_batches WHERE item_id = %s;",
        (item_id,),
    )
    current_quantity = cur.fetchone()["quantity"]

    if action == "Added":
        cur.execute(
            """
            SELECT id
            FROM inventory_batches
            WHERE item_id = %s
              AND expiry_date IS NULL
              AND expiry_estimate_date IS NULL
            ORDER BY created_at, id
            LIMIT 1
            FOR UPDATE;
            """,
            (item_id,),
        )
        batch = cur.fetchone()
        if batch:
            cur.execute(
                """
                UPDATE inventory_batches
                SET quantity = quantity + %s, last_updated = NOW()
                WHERE id = %s;
                """,
                (quantity, batch["id"]),
            )
        else:
            cur.execute(
                """
                INSERT INTO inventory_batches(item_id, quantity, expiry_source)
                VALUES (%s, %s, 'manual');
                """,
                (item_id, quantity),
            )
        return current_quantity + quantity

    if action != "Removed":
        return current_quantity
    if current_quantity < quantity:
        raise HTTPException(status_code=409, detail="Not enough inventory available")

    cur.execute(
        """
        SELECT id, quantity
        FROM inventory_batches
        WHERE item_id = %s AND quantity > 0
        ORDER BY COALESCE(expiry_date, expiry_estimate_date) NULLS LAST,
                 created_at, id
        FOR UPDATE;
        """,
        (item_id,),
    )
    remaining = quantity
    for batch in cur.fetchall():
        if remaining == 0:
            break
        removed = min(batch["quantity"], remaining)
        remaining -= removed
        cur.execute(
            """
            UPDATE inventory_batches
            SET quantity = quantity - %s,
                open_unit_remaining_percent = NULL,
                last_updated = NOW()
            WHERE id = %s;
            """,
            (removed, batch["id"]),
        )
    return current_quantity - quantity


def apply_rules(raw_detections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rules = load_rules()
    deny = set([x.lower() for x in rules.get("deny_labels", [])])
    label_to_item = rules.get("label_to_item", {})
    item_to_category = rules.get("item_to_category", {})
    min_conf_default = float(rules.get("min_conf_default", 0.25))
    min_conf_by_item = rules.get("min_conf_by_item", {})

    normalized = []
    for det in raw_detections:
        label = str(det.get("label", "")).strip().lower()
        conf = float(det.get("confidence", 0))
        if not label:
            continue
        # 1) blacklist
        if label in deny:
            continue
        # 2) mapping label->item
        item_name = label_to_item.get(label, label).strip()
        item_name = item_name[:1].upper() + item_name[1:]  # capitalize בלי להרוס מילים
        # 3) threshold
        min_conf = float(min_conf_by_item.get(item_name, min_conf_default))
        if conf < min_conf:
            continue
        # 4) category
        category = item_to_category.get(item_name, "General")
        normalized.append({
            "item_name": item_name,
            "category": category,
            "confidence": conf,
            "x1": det.get("x1"),
            "y1": det.get("y1"),
            "x2": det.get("x2"),
            "y2": det.get("y2"),
        })
    return normalized


def _resolve_registered_model_path(model_path: str) -> str:
    if os.path.isabs(model_path):
        return os.path.abspath(model_path)
    return os.path.abspath(os.path.join(BACKEND_DIR, model_path))


def _active_model_record():
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, version, model_path, model_sha256, status
                FROM model_versions
                WHERE status = 'active'
                LIMIT 1;
                """
            )
            return cur.fetchone()


def _load_registered_detector(record):
    path = _resolve_registered_model_path(record["model_path"])
    if not os.path.isfile(path):
        raise RuntimeError(f"Registered detector file is missing: {path}")
    expected_hash = record.get("model_sha256")
    if expected_hash:
        import hashlib
        digest = hashlib.sha256()
        with open(path, "rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected_hash:
            raise RuntimeError("Registered detector checksum does not match its model record")
    detector = YOLO(path)
    if getattr(detector, "task", None) != "detect":
        raise RuntimeError("Registered active model is not an object detector")
    return detector, path


def get_detection_model():
    """Return the database-selected detector, refreshing stale worker state safely."""
    global MODEL, _MODEL_VERSION, _MODEL_PATH
    record = _active_model_record()
    if not record:
        raise RuntimeError("No active detector is registered")
    with _MODEL_LOCK:
        if MODEL is None or _MODEL_VERSION != record["version"]:
            detector, path = _load_registered_detector(record)
            MODEL = detector
            _MODEL_VERSION = record["version"]
            _MODEL_PATH = path
            LOGGER.info("Active detector loaded: version=%s path=%s", _MODEL_VERSION, path)
        return MODEL


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
    global MODEL, _MODEL_VERSION, _MODEL_PATH
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

        MODEL = detector
        _MODEL_VERSION = target["version"]
        _MODEL_PATH = resolved_path
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



def health():
    return {
        "status": "ok",
        "time": datetime.utcnow().isoformat(),
        "active_model_version": _MODEL_VERSION,
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


async def analyze_freshness(file: UploadFile = File(...)):
    allowed_types = {"image/jpeg", "image/png", "image/webp"}
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=415, detail="Upload a JPEG, PNG, or WebP image.")

    contents = await file.read(FRESHNESS_MAX_UPLOAD_BYTES + 1)
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded image is empty.")
    if len(contents) > FRESHNESS_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image is too large (maximum 12 MB).")

    image = cv2.imdecode(np.frombuffer(contents, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Uploaded image could not be decoded.")

    analysis_id = uuid.uuid4().hex
    input_filename = f"{analysis_id}_input.jpg"
    input_path = os.path.join(FRESHNESS_UPLOAD_DIR, input_filename)
    if not cv2.imwrite(input_path, image):
        raise HTTPException(status_code=500, detail="Could not save the uploaded image.")

    try:
        freshness_model = get_freshness_model()
        with _FRESHNESS_MODEL_LOCK:
            results = freshness_model.predict(
                image,
                verbose=False,
            )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        LOGGER.exception("Freshness inference failed")
        raise HTTPException(status_code=500, detail="Freshness analysis failed.") from exc

    if not results or results[0].probs is None:
        LOGGER.error("Freshness classifier returned no probabilities")
        raise HTTPException(status_code=500, detail="Freshness classifier returned no result.")

    result = results[0]
    class_id = int(result.probs.top1)
    confidence = float(result.probs.top1conf.item())
    label = str(freshness_model.names.get(class_id, class_id))
    classification = parse_freshness_class(label)
    if classification is None:
        LOGGER.error("Freshness classifier returned an unexpected class: %s", label)
        raise HTTPException(status_code=422, detail="The model returned an unsupported freshness class.")
    classification.update({"class_id": class_id, "confidence": confidence})

    return {
        "ok": True,
        "classification": classification,
        "candidates": classification_probabilities(
            freshness_model.names, result.probs.data, limit=3
        ),
        "image_url": f"/uploads/freshness/{input_filename}",
        "message": (
            f"The image was classified as {classification['condition'].lower()} "
            f"{classification['item'].lower()}."
        ),
    }

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



def inventory() -> List[Dict[str, Any]]:
    sql = """
    SELECT i.id, i.name, i.category,
           SUM(b.quantity) AS quantity,
           SUM(
               b.quantity - CASE
                   WHEN b.open_unit_remaining_percent IS NOT NULL
                   THEN 1 - (b.open_unit_remaining_percent / 100.0)
                   ELSE 0
               END
           ) AS estimated_quantity,
           CASE
               WHEN SUM(
                   b.quantity - CASE
                       WHEN b.open_unit_remaining_percent IS NOT NULL
                       THEN 1 - (b.open_unit_remaining_percent / 100.0)
                       ELSE 0
                   END
               ) = 0 THEN 'MISSING'
               WHEN SUM(
                   b.quantity - CASE
                       WHEN b.open_unit_remaining_percent IS NOT NULL
                       THEN 1 - (b.open_unit_remaining_percent / 100.0)
                       ELSE 0
                   END
               ) <= 1 THEN 'LOW'
               ELSE 'OK'
           END AS status,
           MAX(b.last_updated) AS last_updated,
           MIN(COALESCE(b.expiry_date, b.expiry_estimate_date)) AS expiry_date,
           MIN(COALESCE(b.expiry_estimate_date, b.expiry_date)) AS expiry_estimate_date
    FROM items i
    LEFT JOIN inventory_batches b ON b.item_id = i.id
    GROUP BY i.id, i.name, i.category
    HAVING SUM(b.quantity) > 0
    ORDER BY i.category, i.name;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            return cur.fetchall()


def inventory_batches() -> List[Dict[str, Any]]:
    sql = """
    SELECT b.id, b.item_id, i.name, i.category,
           b.quantity, b.expiry_date, b.expiry_estimate_date, b.expiry_source,
           b.open_unit_remaining_percent,
           b.created_at, b.last_updated
    FROM inventory_batches b
    JOIN items i ON i.id = b.item_id
    WHERE b.quantity > 0
    ORDER BY i.category, i.name, b.expiry_date, b.created_at, b.id;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            return cur.fetchall()


def update_inventory_batch_remaining(batch_id: int, payload: Dict[str, Any]):
    try:
        remaining_percent = int(payload.get("remaining_percent"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="remaining_percent must be between 0 and 100")

    if remaining_percent < 0 or remaining_percent > 100:
        raise HTTPException(status_code=400, detail="remaining_percent must be between 0 and 100")

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, item_id, quantity, expiry_date, expiry_estimate_date,
                       expiry_source, open_unit_remaining_percent, created_at
                FROM inventory_batches
                WHERE id = %s AND quantity > 0
                FOR UPDATE;
                """,
                (batch_id,),
            )
            batch = cur.fetchone()
            if not batch:
                raise HTTPException(status_code=404, detail="Inventory batch not found")

            if remaining_percent == 0:
                cur.execute(
                    """
                    UPDATE inventory_batches
                    SET quantity = quantity - 1,
                        open_unit_remaining_percent = NULL,
                        last_updated = NOW()
                    WHERE id = %s;
                    """,
                    (batch_id,),
                )
                cur.execute(
                    """
                    INSERT INTO events(scan_id, item_id, action, confidence, quantity_change)
                    VALUES (NULL, %s, 'Removed', 1.0, 1);
                    """,
                    (batch["item_id"],),
                )
            else:
                stored_percent = None if remaining_percent == 100 else remaining_percent
                if batch["quantity"] > 1 and stored_percent is not None:
                    cur.execute(
                        """
                        UPDATE inventory_batches
                        SET quantity = quantity - 1,
                            open_unit_remaining_percent = NULL,
                            last_updated = NOW()
                        WHERE id = %s;
                        """,
                        (batch_id,),
                    )
                    cur.execute(
                        """
                        INSERT INTO inventory_batches(
                            item_id, quantity, expiry_date, expiry_estimate_date,
                            expiry_source, open_unit_remaining_percent, created_at, last_updated
                        ) VALUES (%s, 1, %s, %s, %s, %s, %s, NOW())
                        RETURNING id;
                        """,
                        (
                            batch["item_id"],
                            batch["expiry_date"],
                            batch["expiry_estimate_date"],
                            batch["expiry_source"],
                            stored_percent,
                            batch["created_at"],
                        ),
                    )
                    updated_batch_id = cur.fetchone()["id"]
                else:
                    cur.execute(
                        """
                        UPDATE inventory_batches
                        SET open_unit_remaining_percent = %s, last_updated = NOW()
                        WHERE id = %s;
                        """,
                        (stored_percent, batch_id),
                    )
                    updated_batch_id = batch_id

            if remaining_percent == 0:
                updated_batch_id = batch_id

            sync_inventory_summary(conn)
            cur.execute(
                """
                SELECT id, item_id, quantity, open_unit_remaining_percent, last_updated
                FROM inventory_batches WHERE id = %s;
                """,
                (updated_batch_id,),
            )
            updated_batch = cur.fetchone()
            conn.commit()
            return {"ok": True, "batch": updated_batch}


def update_inventory_batch_expiry(batch_id: int, payload: Dict[str, Any]):
    raw_expiry_date = payload.get("expiry_date")
    expiry_date = parse_expiry_date(raw_expiry_date)
    if not expiry_date:
        raise HTTPException(status_code=400, detail="A valid expiry date is required (YYYY-MM-DD)")
    if expiry_date <= date.today():
        raise HTTPException(status_code=400, detail="The new expiry date must be in the future")

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                UPDATE inventory_batches
                SET expiry_date = %s,
                    expiry_estimate_date = NULL,
                    expiry_source = 'manual',
                    last_updated = NOW()
                WHERE id = %s AND quantity > 0
                RETURNING id, item_id, quantity, expiry_date;
                """,
                (expiry_date, batch_id),
            )
            updated_batch = cur.fetchone()
            if not updated_batch:
                raise HTTPException(status_code=404, detail="Inventory batch not found")
            conn.commit()
            return {"ok": True, "batch": updated_batch}


def remove_inventory_batch(batch_id: int):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, item_id, quantity
                FROM inventory_batches
                WHERE id = %s AND quantity > 0
                FOR UPDATE;
                """,
                (batch_id,),
            )
            batch = cur.fetchone()
            if not batch:
                raise HTTPException(status_code=404, detail="Inventory batch not found")

            cur.execute(
                """
                UPDATE inventory_batches
                SET quantity = 0,
                    open_unit_remaining_percent = NULL,
                    last_updated = NOW()
                WHERE id = %s;
                """,
                (batch_id,),
            )
            cur.execute(
                """
                INSERT INTO events(scan_id, item_id, action, confidence, quantity_change)
                VALUES (NULL, %s, 'Removed', 1.0, %s);
                """,
                (batch["item_id"], batch["quantity"]),
            )
            sync_inventory_summary(conn)
            conn.commit()
            return {"ok": True, "removed_quantity": batch["quantity"]}


def remove_inventory_batch_quantity(batch_id: int, payload: Dict[str, Any]):
    try:
        quantity = int(payload.get("quantity"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="quantity must be a positive integer")
    if quantity < 1:
        raise HTTPException(status_code=400, detail="quantity must be a positive integer")

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, item_id, quantity
                FROM inventory_batches
                WHERE id = %s AND quantity > 0
                FOR UPDATE;
                """,
                (batch_id,),
            )
            batch = cur.fetchone()
            if not batch:
                raise HTTPException(status_code=404, detail="Inventory batch not found")
            if quantity > batch["quantity"]:
                raise HTTPException(
                    status_code=409,
                    detail=f"Only {batch['quantity']} item(s) remain in this batch",
                )

            cur.execute(
                """
                UPDATE inventory_batches
                SET quantity = quantity - %s,
                    open_unit_remaining_percent = NULL,
                    last_updated = NOW()
                WHERE id = %s;
                """,
                (quantity, batch_id),
            )
            cur.execute(
                """
                INSERT INTO events(scan_id, item_id, action, confidence, quantity_change)
                VALUES (NULL, %s, 'Removed', 1.0, %s);
                """,
                (batch["item_id"], quantity),
            )
            sync_inventory_summary(conn)
            conn.commit()
            return {
                "ok": True,
                "removed_quantity": quantity,
                "remaining_quantity": batch["quantity"] - quantity,
            }


def inventory_all() -> List[Dict[str, Any]]:
    sql = """
    SELECT i.id, i.name, i.category,
           COALESCE(SUM(b.quantity), 0) AS quantity,
           CASE
               WHEN COALESCE(SUM(b.quantity), 0) = 0 THEN 'MISSING'
               WHEN COALESCE(SUM(b.quantity), 0) <= 1 THEN 'LOW'
               ELSE 'OK'
           END AS status,
           MAX(b.last_updated) AS last_updated,
           MIN(COALESCE(b.expiry_date, b.expiry_estimate_date)) AS expiry_date,
           MIN(COALESCE(b.expiry_estimate_date, b.expiry_date)) AS expiry_estimate_date
    FROM items i
    LEFT JOIN inventory_batches b ON b.item_id = i.id
    GROUP BY i.id, i.name, i.category
    ORDER BY i.category, i.name;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            return cur.fetchall()


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


def list_annotation_submissions(status: Optional[str] = None):
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
    if status == "used":
        sql += " WHERE s.status = 'used' OR EXISTS (SELECT 1 FROM training_run_submission_usage u WHERE u.submission_id = s.id)"
    elif status == "approved":
        sql += " WHERE s.status = 'approved' AND NOT EXISTS (SELECT 1 FROM training_run_submission_usage u WHERE u.submission_id = s.id)"
    elif status is not None:
        sql += " WHERE s.status = %s"
        params.append(status)
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

            active_classes = []
            if active:
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
                    (active["id"], active["id"], active["id"]),
                )
                class_row = cur.fetchone()
                active_classes = (class_row or {}).get("classes") or []

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
                       mv.version AS model_version
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

    return {
        "active_model": active,
        "active_classes": active_classes,
        "latest_candidate": candidate,
        "comparison": comparison,
        "promotion_evaluation": promotion_evaluation,
        "archived_models": archived_models,
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
            "can_rollback": bool(archived_models),
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


def get_lifecycle_job(job_id: str):
    with _LIFECYCLE_JOB_LOCK:
        job = _LIFECYCLE_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Lifecycle job not found")
        return dict(job)


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
    if action not in {"restore", "reject"}:
        raise HTTPException(status_code=400, detail="Action must be restore or reject")
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM annotation_submissions WHERE id = %s FOR UPDATE;",
                (submission_id,),
            )
            submission = cur.fetchone()
            if not submission:
                raise HTTPException(status_code=404, detail="Annotation submission not found")
            if submission["training_state"] != "quarantined":
                raise HTTPException(status_code=409, detail="Only quarantined submissions can be managed")
            if action == "restore":
                if submission["status"] not in {"approved", "used"}:
                    raise HTTPException(status_code=409, detail="Only approved quarantined submissions can be restored")
                cur.execute(
                    "UPDATE annotation_submissions SET training_state = 'eligible' WHERE id = %s RETURNING *;",
                    (submission_id,),
                )
            else:
                cur.execute(
                    """
                    UPDATE annotation_submissions
                    SET status = 'rejected', reviewed_at = NOW()
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

def alerts() -> List[Dict[str, Any]]:
    sql = """
    WITH inventory_totals AS (
        SELECT i.id AS item_id, i.name, i.category,
               COALESCE(SUM(
                   b.quantity - CASE
                       WHEN b.open_unit_remaining_percent IS NOT NULL
                       THEN 1 - (b.open_unit_remaining_percent / 100.0)
                       ELSE 0
                   END
               ) FILTER (WHERE b.quantity > 0), 0) AS quantity,
               MAX(b.last_updated) AS last_updated
        FROM items i
        LEFT JOIN inventory_batches b ON b.item_id = i.id
        GROUP BY i.id, i.name, i.category
    ), active_alerts AS (
        SELECT t.item_id AS id, t.item_id, NULL::integer AS batch_id,
               t.name, t.category, t.quantity,
               CASE WHEN t.quantity = 0 THEN 'MISSING' ELSE 'LOW' END AS status,
               'stock'::text AS alert_type,
               NULL::date AS expiry_date,
               t.last_updated
        FROM inventory_totals t
        WHERE t.quantity <= 1

        UNION ALL

        SELECT b.id, i.id AS item_id, b.id AS batch_id,
               i.name, i.category, b.quantity,
               CASE
                   WHEN COALESCE(b.expiry_date, b.expiry_estimate_date) <= CURRENT_DATE THEN 'EXPIRED'
                   ELSE 'EXPIRING'
               END AS status,
               'expiry'::text AS alert_type,
               COALESCE(b.expiry_date, b.expiry_estimate_date) AS expiry_date,
               b.last_updated
        FROM inventory_batches b
        JOIN items i ON i.id = b.item_id
        WHERE b.quantity > 0
          AND COALESCE(b.expiry_date, b.expiry_estimate_date) <= CURRENT_DATE + INTERVAL '3 days'
    )
    SELECT * FROM active_alerts
    ORDER BY name, alert_type, expiry_date;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            return cur.fetchall()


def events(limit: int = 50) -> List[Dict[str, Any]]:
    sql = """
    SELECT e.id, e.action, e.confidence, e.created_at,
           i.name AS item_name, i.category AS item_category,e.quantity_change,
           e.scan_id
    FROM events e
    LEFT JOIN items i ON i.id = e.item_id
    ORDER BY e.created_at DESC
    LIMIT %s;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, (limit,))
            return cur.fetchall()

def infer(payload: Dict[str, Any]):
    """
    payload:
    {
      "image_ref": "C:/Users/Netanel/Desktop/fridge9000/images/test.jpg",
      "conf": 0.25
    }

    returns:
    {
      "ok": true,
      "image_ref": "...",
      "detections": [{"label":"bottle","confidence":0.81}, ...]
    }
    """
    image_ref = payload.get("image_ref")
    conf = float(payload.get("conf", 0.25))

    if not image_ref:
        return {"ok": False, "error": "image_ref required"}

    # OpenCV expects backslashes ok, but normalize slashes is fine
    img = cv2.imread(image_ref)
    if img is None:
        return {"ok": False, "error": f"could not read image at: {image_ref}"}
    image_height, image_width = img.shape[:2]

    try:
        model = get_detection_model()
        with _MODEL_LOCK:
            results = model.predict(img, conf=conf, verbose=False)
            r = results[0]
    except Exception as exc:
        LOGGER.exception("Active detector inference failed")
        return {"ok": False, "error": str(exc)}

    detections = []
    if r.boxes is not None:
        for b in r.boxes:
            cls_id = int(b.cls[0].item())
            label = model.names.get(cls_id, str(cls_id))
            confidence = float(b.conf[0].item())
            xyxy = b.xyxy[0].tolist()
            detections.append({
                "label": label,
                "confidence": confidence,
                "x1": float(xyxy[0]),
                "y1": float(xyxy[1]),
                "x2": float(xyxy[2]),
                "y2": float(xyxy[3]),
            })

    # מיון לפי confidence
    detections.sort(key=lambda x: x["confidence"], reverse=True)

    return {
        "ok": True,
        "image_ref": image_ref,
        "image_width": image_width,
        "image_height": image_height,
        "detections": detections,
    }

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



def reset_inventory():
    """
    Completely clears the inventory and related events.
    """
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                # Optionally clear events first to avoid FK issues
                cur.execute("DELETE FROM events;")
                # Inventory reads are derived from batches, so both stores must reset.
                cur.execute("DELETE FROM inventory_batches;")
                cur.execute("DELETE FROM inventory;")
                # Optional: clear items table if you want a full reset
                # cur.execute("DELETE FROM items;")
                conn.commit()
        return {"ok": True, "message": "Inventory has been reset."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def create_event(payload: Dict[str, Any]):
    
    action = payload.get("action")
    item_name = payload.get("item_name")
    confidence = payload.get("confidence")
    scan_id = payload.get("scan_id")

    if not action or not item_name:
        return {"ok": False, "error": "action and item_name required"}

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # get item id
            cur.execute("SELECT id FROM items WHERE name = %s;", (item_name,))
            row = cur.fetchone()
            if not row:
                return {"ok": False, "error": "item not found"}

            item_id = row["id"]

            if action in ("Added", "Removed"):
                change_inventory_batches(cur, item_id, action, 1)

            # insert event
            cur.execute(
                "INSERT INTO events(scan_id, item_id, action, confidence) VALUES (%s,%s,%s,%s) RETURNING id;",
                (scan_id, item_id, action, confidence),
            )
            event_id = cur.fetchone()["id"]
            sync_inventory_summary(conn)

            conn.commit()

    return {"ok": True, "event_id": event_id}

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

async def update_inventory_by_image(
    action: str,
    file: UploadFile = File(...)
):
    if action not in ("Added", "Removed"):
        raise HTTPException(status_code=400, detail="action must be Added or Removed")

    try:
        ext = file.filename.split(".")[-1]
        filename = f"{uuid.uuid4()}.{ext}"
        file_path = os.path.join(UPLOAD_DIR, filename)

        with open(file_path, "wb") as f:
            f.write(await file.read())

        infer_res = infer({"image_ref": file_path, "conf": 0.25})

        if not infer_res.get("ok"):
            raise HTTPException(status_code=500, detail=infer_res.get("error"))

        filtered_dets = apply_rules(infer_res["detections"])

        if not filtered_dets:
            raise HTTPException(status_code=400, detail="No valid items detected in image")

        items_to_update = {}
        for d in filtered_dets:
            name = d["item_name"]
            if name not in items_to_update:
                items_to_update[name] = {
                    "category": d["category"],
                    "confidence": d["confidence"],
                    "count": 1,
                }
            else:
                items_to_update[name]["count"] += 1
                items_to_update[name]["confidence"] = max(
                    items_to_update[name]["confidence"],
                    d["confidence"]
                )

        updated_items = []

        with get_conn() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                for name, data in items_to_update.items():
                    cur.execute("SELECT id FROM items WHERE name = %s;", (name,))
                    item = cur.fetchone()

                    if not item:
                        if action == "Removed":
                            raise HTTPException(
                                status_code=400,
                                detail=f"{name} is not in inventory"
                            )

                        cur.execute(
                            "INSERT INTO items(name, category) VALUES (%s, %s) RETURNING id;",
                            (name, data["category"]),
                        )
                        item_id = cur.fetchone()["id"]
                    else:
                        item_id = item["id"]

                    try:
                        new_qty = change_inventory_batches(
                            cur, item_id, action, data["count"]
                        )
                    except HTTPException as exc:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Not enough {name} in inventory",
                        ) from exc

                    cur.execute(
                        """
                        INSERT INTO events(scan_id, item_id, action, confidence)
                        VALUES (%s, %s, %s, %s);
                        """,
                        (None, item_id, action, data["confidence"]),
                    )

                    updated_items.append({
                        "name": name,
                        "action": action,
                        "quantity_changed": data["count"],
                        "new_quantity": new_qty,
                    })

                sync_inventory_summary(conn)
                conn.commit()

        return {
            "ok": True,
            "action": action,
            "updated_items": updated_items,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def manual_inventory(payload: Dict[str, Any]):
    """
    Manually add or remove items.

    payload example:
    {
        "item_name": "Milk",
        "action": "Added",   # or "Removed"
        "quantity": 2,
        "expiry_date": "2026-08-01",
        "expiry_source": "manual"  # or "estimated"
    }
    """

    item_name = payload.get("item_name")
    action = payload.get("action")
    quantity_change = int(payload.get("quantity", 1))
    selected_expiry_date = parse_expiry_date(payload.get("expiry_date"))
    without_expiry = payload.get("without_expiry") is True
    expiry_source = payload.get("expiry_source") or "manual"

    if not item_name or action not in ("Added", "Removed"):
        raise HTTPException(
            status_code=400,
            detail="item_name and action ('Added' or 'Removed') required"
        )

    if quantity_change <= 0:
        raise HTTPException(
            status_code=400,
            detail="quantity must be greater than 0"
        )

    if action == "Added" and not selected_expiry_date:
        selected_expiry_date = estimate_expiry_date(item_name)
        expiry_source = "estimated"

    if action == "Removed" and not selected_expiry_date and not without_expiry:
        raise HTTPException(
            status_code=400,
            detail="An expiry date must be selected when removing inventory"
        )

    if action == "Added" and selected_expiry_date < date.today():
        raise HTTPException(
            status_code=400,
            detail="The expiry date cannot be in the past"
        )

    if expiry_source not in ("manual", "estimated"):
        expiry_source = "manual"

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:

            # --- Ensure item exists ---
            cur.execute("SELECT id, category FROM items WHERE LOWER(name) = LOWER(%s);", (item_name,))
            row = cur.fetchone()

            if row:
                item_id = row["id"]
            else:
                # אם מנסים להסיר פריט שלא קיים
                if action == "Removed":
                    raise HTTPException(
                        status_code=400,
                        detail=f"{item_name} is not in inventory"
                    )

                # יצירת פריט חדש
                cur.execute(
                    "INSERT INTO items(name, category) VALUES (%s, %s) RETURNING id;",
                    (item_name, "General"),
                )
                item_id = cur.fetchone()["id"]

            if action == "Removed":
                if without_expiry:
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
                        (item_id, selected_expiry_date),
                    )
                batches = cur.fetchall()
                remaining = quantity_change
                for batch in batches:
                    if remaining <= 0:
                        break
                    take = min(batch["quantity"], remaining)
                    remaining -= take
                    cur.execute(
                        """
                        UPDATE inventory_batches
                        SET quantity = %s,
                            open_unit_remaining_percent = NULL,
                            last_updated = NOW()
                        WHERE id = %s;
                        """,
                        (batch["quantity"] - take, batch["id"]),
                    )

                if remaining > 0:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Cannot remove {quantity_change} {item_name} item(s) from the selected "
                            f"inventory group. Only {quantity_change - remaining} available."
                        )
                    )
            else:
                expiry_date = selected_expiry_date if expiry_source == "manual" else None
                expiry_estimate_date = selected_expiry_date if expiry_source == "estimated" else None
                cur.execute(
                    """
                    SELECT id, quantity
                    FROM inventory_batches
                    WHERE item_id = %s
                      AND COALESCE(expiry_date, expiry_estimate_date) = %s
                      AND expiry_source = %s
                    FOR UPDATE;
                    """,
                    (item_id, selected_expiry_date, expiry_source),
                )
                existing_batch = cur.fetchone()
                if existing_batch:
                    cur.execute(
                        """
                        UPDATE inventory_batches
                        SET quantity = %s, last_updated = NOW()
                        WHERE id = %s;
                        """,
                        (existing_batch["quantity"] + quantity_change, existing_batch["id"]),
                    )
                else:
                    cur.execute(
                        """
                        INSERT INTO inventory_batches(
                            item_id, quantity, expiry_date, expiry_estimate_date, expiry_source
                        )
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

            sync_inventory_summary(conn)

            cur.execute(
                "SELECT COALESCE(SUM(quantity), 0) AS quantity FROM inventory_batches WHERE item_id = %s;",
                (item_id,),
            )
            new_qty = cur.fetchone()["quantity"]
            status = "MISSING" if new_qty == 0 else "LOW" if new_qty == 1 else "OK"

            # --- Create event ---
            cur.execute(
                """
                INSERT INTO events(scan_id, item_id, action, confidence, quantity_change)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id;
                """,
                (None, item_id, action, 1.0, quantity_change),
            )
            event_id = cur.fetchone()["id"]

            conn.commit()

    return {
        "ok": True,
        "item_name": item_name,
        "action": action,
        "quantity_changed": quantity_change,
        "new_quantity": new_qty,
        "status": status,
        "event_id": event_id,
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

async def upload_receipt(file: UploadFile = File(...)):
    try:
        import re

        ext = file.filename.split(".")[-1].lower()

        if ext not in ("pdf", "jpg", "jpeg", "png"):
            raise HTTPException(
                status_code=400,
                detail="Only PDF, JPG, JPEG or PNG files are supported"
            )

        filename = f"{uuid.uuid4()}.{ext}"
        file_path = os.path.join(UPLOAD_DIR, filename)

        with open(file_path, "wb") as f:
            f.write(await file.read())

        if ext == "pdf":
            pages = convert_from_path(file_path, dpi=300)
        else:
            from PIL import Image
            pages = [Image.open(file_path)]

        full_text = ""

        for i, page in enumerate(pages):
            text = pytesseract.image_to_string(page, lang="eng")

            print(f"----- PAGE {i + 1} OCR -----")
            print(text)

            full_text += text + "\n"

        lines = [
            line.strip()
            for line in full_text.splitlines()
            if line.strip()
        ]

        noise_words = [
            "receipt", "invoice", "tax", "vat",
            "cash", "credit", "visa", "mastercard", "change",
            "store", "branch", "date", "time", "cashier",
            "card", "customer", "thank", "thanks",
            "phone", "address", "qty", "quantity", "price",
            "item", "code", "barcode", "description",
        ]

        stop_words = [
            "subtotal",
            "sub-total",
            "sub-totai",
            "total",
            "payment",
            "you saved",
            "saved today",
            "amount due",
            "balance",
            "debit",
            "credit",
            "change",
            "thank you",
            "thanks",
        ]

        detected_items = []
        pending_item = None
        pending_qty = 1

        for raw_line in lines:
            line = raw_line.strip()
            line = line.replace("SR", "")

            if len(line) < 2:
                continue

            lowered = line.lower()

            if any(word in lowered for word in stop_words):
                break

            if any(word in lowered for word in noise_words):
                continue

            has_letters = re.search(r"[A-Za-z]", line)

            # Price examples: 9.99, 9 ,99, $9.99, SR 77.80
            has_price = re.search(r"\$?\s*\d+\s*[.,]\s*\d{2}", line)

            # Quantity at beginning of line, e.g. "2 WH Asahi 1+1/2 SR 77.80"
            qty_match = re.match(r"^\s*(\d+)\s+", line)
            quantity = int(qty_match.group(1)) if qty_match else 1

            # If this is only a price line, attach it to pending item
            if has_price and not has_letters:
                if pending_item:
                    for _ in range(pending_qty):
                        detected_items.append(pending_item.title())

                    pending_item = None
                    pending_qty = 1

                continue

            if not has_letters:
                continue

            cleaned_line = line

            # Remove price
            cleaned_line = re.sub(r"\$?\s*\d+\s*[.,]\s*\d{2}", " ", cleaned_line)

            # Remove long codes/barcodes
            cleaned_line = re.sub(r"\b\d{5,}\b", " ", cleaned_line)

            # Remove parenthesis content
            cleaned_line = re.sub(r"\([^)]*\)", " ", cleaned_line)

            # Remove leading quantity only
            cleaned_line = re.sub(r"^\s*\d+\s+", " ", cleaned_line)

            # Remove standalone numbers, but after leading quantity was saved
            cleaned_line = re.sub(r"\b\d+\b", " ", cleaned_line)

            # Keep English letters and useful separators
            cleaned_line = re.sub(r"[^A-Za-z\s\-']", " ", cleaned_line)

            item_name = " ".join(cleaned_line.split()).strip()

            if len(item_name) < 2:
                continue

            if has_price:
                for _ in range(quantity):
                    detected_items.append(item_name.title())

                pending_item = None
                pending_qty = 1
            else:
                pending_item = item_name
                pending_qty = quantity

        if pending_item:
            for _ in range(pending_qty):
                detected_items.append(pending_item.title())

        if not detected_items:
            raise HTTPException(status_code=400, detail="No items found in receipt")

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO scans(image_ref, source)
                    VALUES (%s, 'receipt')
                    RETURNING id;
                    """,
                    (file_path,),
                )
                scan_id = cur.fetchone()[0]

                for item in detected_items:
                    cur.execute(
                        """
                        INSERT INTO scan_detections(scan_id, label, confidence)
                        VALUES (%s, %s, %s);
                        """,
                        (scan_id, item, 1.0),
                    )

                conn.commit()

        return {
            "ok": True,
            "scan_id": scan_id,
            "items_count": len(detected_items),
            "items": detected_items,
        }

    except HTTPException:
        raise

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
