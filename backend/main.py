import os
import threading
from datetime import datetime, date, timedelta
from typing import List, Optional, Dict, Any
from fastapi.middleware.cors import CORSMiddleware
import psycopg2
from psycopg2.extras import RealDictCursor
from fastapi import FastAPI
from dotenv import load_dotenv
from ultralytics import YOLO, SAM
import cv2
import numpy as np
from fastapi import UploadFile, File
import uuid
import json
from fastapi import HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
import pytesseract
from pdf2image import convert_from_path
import re



UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)
origins = [
    "http://localhost:5173",
    "http://localhost:8081",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8081",
]
load_dotenv()

app = FastAPI(title="Fridge 9000 API")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
DATABASE_URL = os.getenv("DATABASE_URL")
MODEL = YOLO("best.pt")
RULES_PATH = os.path.join(os.path.dirname(__file__), "rules.json")
_RULES_CACHE = None
_SAM_MODEL = None
_SAM_LOCK = threading.Lock()
_OUTLINE_JOB_LOCK = threading.Lock()
_OUTLINE_JOBS = {}
_ACTIVE_OUTLINE_JOB_ID = None
SEGMENTATION_MODEL_PATH = os.getenv(
    "SEGMENTATION_MODEL_PATH",
    os.path.join(os.path.dirname(__file__), "sam2_t.pt"),
)
OUTLINE_DIR = os.path.join(UPLOAD_DIR, "outlines")
os.makedirs(OUTLINE_DIR, exist_ok=True)
def get_conn():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg2.connect(DATABASE_URL)

def load_rules():
    global _RULES_CACHE
    if _RULES_CACHE is None:
        with open(RULES_PATH, "r", encoding="utf-8") as f:
            _RULES_CACHE = json.load(f)
    return _RULES_CACHE


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
                LEFT JOIN inventory_batches b
                    ON b.item_id = inv.item_id
                   AND b.expiry_date IS NULL
                   AND b.expiry_estimate_date IS NULL
                   AND b.expiry_source = 'manual'
                WHERE inv.quantity > 0
                  AND b.id IS NULL;
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



ensure_schema()

@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.utcnow().isoformat()}

@app.post("/door/closed/upload")
async def door_closed_upload(file: UploadFile = File(...)):
    try:
        ext = file.filename.split(".")[-1]
        filename = f"{uuid.uuid4()}.{ext}"
        file_path = os.path.join(UPLOAD_DIR, filename)

        with open(file_path, "wb") as f:
            f.write(await file.read())

        return door_closed({"image_ref": file_path, "conf": 0.25})

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))



@app.get("/inventory")
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


@app.get("/inventory/batches")
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


@app.patch("/inventory/batches/{batch_id}/remaining")
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


@app.patch("/inventory/batches/{batch_id}/expiry")
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


@app.post("/inventory/batches/{batch_id}/remove")
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


@app.get("/inventory/all")
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
        
@app.post("/scans/{scan_id}/review")
def review_scan(scan_id: int, payload: Dict[str, Any]):
    items = payload.get("items", [])
    mode = payload.get("mode", "Added")

    if mode not in ("Added", "Removed"):
        raise HTTPException(status_code=400, detail="mode must be Added or Removed")

    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="items must be a list")

    included_items_map = {}

    for it in items:
        included = bool(it.get("included", True))
        if not included:
            continue

        label = it.get("final_label") or it.get("original_label")
        confidence = float(it.get("confidence", 1.0))

        if not label:
            continue

        name = label.strip().capitalize()
        expiry_date = parse_expiry_date(it.get("expiry_date"))
        expiry_estimate_date = parse_expiry_date(it.get("expiry_estimate_date"))
        expiry_source = it.get("expiry_source") or ("manual" if expiry_date else "estimated")

        if mode == "Removed":
            selected_expiry_date = expiry_date or expiry_estimate_date
            if not selected_expiry_date:
                raise HTTPException(
                    status_code=400,
                    detail=f"Expiry date is required when removing {name}",
                )
            expiry_date = selected_expiry_date
            expiry_estimate_date = None
            expiry_source = "inventory"
        elif not expiry_date and not expiry_estimate_date:
            expiry_estimate_date = estimate_expiry_date(name)
            expiry_source = "estimated"

        key = (
            (name, expiry_date)
            if mode == "Removed"
            else (name, expiry_date, expiry_estimate_date, expiry_source)
        )
        if key not in included_items_map:
            included_items_map[key] = {
                "name": name,
                "confidence": confidence,
                "quantity": 1,
                "expiry_date": expiry_date,
                "expiry_estimate_date": expiry_estimate_date,
                "expiry_source": expiry_source,
            }
        else:
            included_items_map[key]["quantity"] += 1
            included_items_map[key]["confidence"] = max(
                included_items_map[key]["confidence"],
                confidence,
            )

    included_items = list(included_items_map.values())

    if not included_items:
        raise HTTPException(status_code=400, detail="No included items selected")

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
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
                                f"Cannot remove {quantity_change} {name} item(s) with expiry date "
                                f"{expiry_date}. Only {available} available."
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


@app.get("/scans/{scan_id}/detections")
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


@app.get("/items/{item_id}/representative-image")
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


@app.post("/outlines/prepare")
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


@app.get("/outlines/jobs/{job_id}")
def get_outline_preparation_job(job_id: str):
    job = outline_job_snapshot(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Outline preparation job not found")
    return job


@app.post("/items/{item_id}/representative-image")
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

@app.get("/alerts")
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


@app.get("/events")
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

@app.post("/infer")
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

    results = MODEL.predict(img, conf=conf, verbose=False)
    r = results[0]

    detections = []
    if r.boxes is not None:
        for b in r.boxes:
            cls_id = int(b.cls[0].item())
            label = MODEL.names.get(cls_id, str(cls_id))
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

    return {"ok": True, "image_ref": image_ref, "detections": detections}

@app.get("/scans/latest")
def latest_scan():
    sql = """
    SELECT id, created_at, image_ref
    FROM scans
    ORDER BY created_at DESC
    LIMIT 1;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            row = cur.fetchone()
            return row or {}

@app.post("/scans")
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



@app.post("/inventory/reset")
def reset_inventory():
    """
    Completely clears the inventory and related events.
    """
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                # Optionally clear events first to avoid FK issues
                cur.execute("DELETE FROM events;")
                # Clear inventory
                cur.execute("DELETE FROM inventory;")
                # Optional: clear items table if you want a full reset
                # cur.execute("DELETE FROM items;")
                conn.commit()
        return {"ok": True, "message": "Inventory has been reset."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/events")
def create_event(payload: Dict[str, Any]):
    
    action = payload.get("action")
    item_name = payload.get("item_name")
    confidence = payload.get("confidence")
    scan_id = payload.get("scan_id")

    if not action or not item_name:
        return {"ok": False, "error": "action and item_name required"}

    with get_conn() as conn:
        with conn.cursor() as cur:
            # get item id
            cur.execute("SELECT id FROM items WHERE name = %s;", (item_name,))
            row = cur.fetchone()
            if not row:
                return {"ok": False, "error": "item not found"}

            item_id = row[0]

            # insert event
            cur.execute(
                "INSERT INTO events(scan_id, item_id, action, confidence) VALUES (%s,%s,%s,%s) RETURNING id;",
                (scan_id, item_id, action, confidence),
            )
            event_id = cur.fetchone()[0]

            # update inventory
            cur.execute(
                "SELECT quantity FROM inventory WHERE item_id = %s;",
                (item_id,),
            )
            inv = cur.fetchone()

            if inv:
                quantity = inv[0]
            else:
                quantity = 0
                cur.execute(
                    "INSERT INTO inventory(item_id, quantity) VALUES (%s, 0);",
                    (item_id,),
                )

            if action == "Added":
                quantity += 1
            elif action == "Removed":
                quantity = max(0, quantity - 1)

            # determine status
            if quantity == 0:
                status = "MISSING"
            elif quantity == 1:
                status = "LOW"
            else:
                status = "OK"

            cur.execute(
                "UPDATE inventory SET quantity=%s, status=%s, last_updated=NOW() WHERE item_id=%s;",
                (quantity, status, item_id),
            )

            conn.commit()

    return {"ok": True, "event_id": event_id}

@app.post("/door/closed")
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
                INSERT INTO scans(image_ref)
                VALUES (%s)
                RETURNING id;
                """,
                (image_ref,),
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
    }

@app.post("/inventory/image/update")
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

                    cur.execute(
                        "SELECT quantity FROM inventory WHERE item_id = %s;",
                        (item_id,),
                    )
                    inv = cur.fetchone()
                    current_qty = inv["quantity"] if inv else 0

                    if action == "Removed" and current_qty <= 0:
                        raise HTTPException(
                            status_code=400,
                            detail=f"{name} is not in inventory"
                        )

                    if action == "Removed" and current_qty < data["count"]:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Not enough {name} in inventory"
                        )

                    if not inv:
                        cur.execute(
                            "INSERT INTO inventory(item_id, quantity, status) VALUES (%s, 0, 'MISSING');",
                            (item_id,),
                        )

                    if action == "Added":
                        new_qty = current_qty + data["count"]
                    else:
                        new_qty = current_qty - data["count"]

                    status = "MISSING" if new_qty == 0 else "LOW" if new_qty == 1 else "OK"

                    cur.execute(
                        """
                        UPDATE inventory
                        SET quantity = %s, status = %s, last_updated = NOW()
                        WHERE item_id = %s;
                        """,
                        (new_qty, status, item_id),
                    )

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

@app.post("/inventory/manual")
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

    if action == "Removed" and not selected_expiry_date:
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
                            f"Cannot remove {quantity_change} {item_name} item(s) with expiry date "
                            f"{selected_expiry_date}. Only {quantity_change - remaining} available."
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
@app.get("/scans/{scan_id}/detections/{detection_id}/boxed")
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

    boxed_filename = f"boxed_{scan_id}_{detection_id}.jpg"
    boxed_path = os.path.join(UPLOAD_DIR, boxed_filename)

    cv2.imwrite(boxed_path, img)

    return FileResponse(boxed_path, media_type="image/jpeg")

@app.post("/receipts/upload")
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
                    INSERT INTO scans(image_ref)
                    VALUES (%s)
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
