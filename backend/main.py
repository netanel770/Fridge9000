
import os
from datetime import datetime
from typing import List, Dict, Any
from collections import Counter

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import psycopg2
from psycopg2.extras import RealDictCursor

from dotenv import load_dotenv
from ultralytics import YOLO
import cv2
import uuid
import json

# ------------------ INIT ------------------

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

load_dotenv()

app = FastAPI(title="Fridge 9000 API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:8081",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:8081",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATABASE_URL = os.getenv("DATABASE_URL")
MODEL = YOLO("best.pt")

RULES_PATH = os.path.join(os.path.dirname(__file__), "rules.json")
_RULES_CACHE = None


# ------------------ DB ------------------

def get_conn():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg2.connect(DATABASE_URL)


# ------------------ RULES ------------------

def load_rules():
    global _RULES_CACHE
    if _RULES_CACHE is None:
        with open(RULES_PATH, "r", encoding="utf-8") as f:
            _RULES_CACHE = json.load(f)
    return _RULES_CACHE


def apply_rules(detections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rules = load_rules()

    deny = set(x.lower() for x in rules.get("deny_labels", []))
    label_to_item = rules.get("label_to_item", {})
    item_to_category = rules.get("item_to_category", {})

    min_conf_default = float(rules.get("min_conf_default", 0.25))
    min_conf_by_item = rules.get("min_conf_by_item", {})

    out = []

    for d in detections:
        label = d.get("label", "").lower()
        conf = float(d.get("confidence", 0))

        if not label or label in deny:
            continue

        item = label_to_item.get(label, label).capitalize()

        if conf < float(min_conf_by_item.get(item, min_conf_default)):
            continue

        out.append({
            "item_name": item,
            "category": item_to_category.get(item, "General"),
            "confidence": conf
        })

    return out


# ------------------ AI ------------------

def infer(image_ref: str, conf: float = 0.25):
    img = cv2.imread(image_ref)
    if img is None:
        return {"ok": False, "error": "image not found"}

    results = MODEL.predict(img, conf=conf, verbose=False)[0]

    detections = []

    if results.boxes is not None:
        for b in results.boxes:
            cls = int(b.cls[0].item())
            label = MODEL.names.get(cls, str(cls))
            detections.append({
                "label": label,
                "confidence": float(b.conf[0].item())
            })

    return {"ok": True, "detections": detections}


# ------------------ HELPERS ------------------

def ensure_item(cur, name: str):
    rules = load_rules()
    category = rules.get("item_to_category", {}).get(name, "General")

    cur.execute("SELECT id FROM items WHERE name=%s;", (name,))
    row = cur.fetchone()

    if row:
        return row["id"]

    cur.execute(
        "INSERT INTO items(name, category) VALUES (%s,%s) RETURNING id;",
        (name, category),
    )
    return cur.fetchone()["id"]


def compute_status(qty: int):
    if qty <= 0:
        return "MISSING"
    if qty == 1:
        return "LOW"
    return "OK"


# ------------------ ROUTES ------------------

@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.utcnow().isoformat()}


# ------------------ SCAN ------------------

@app.post("/door/closed/upload")
async def upload(file: UploadFile = File(...)):
    ext = file.filename.split(".")[-1]
    filename = f"{uuid.uuid4()}.{ext}"
    path = os.path.join(UPLOAD_DIR, filename)

    with open(path, "wb") as f:
        f.write(await file.read())

    return {
        "ok": True,
        "image_ref": path,
        "timestamp": datetime.utcnow().isoformat()
    }


@app.post("/door/closed")
def process_scan(payload: Dict[str, Any]):
    image_ref = payload.get("image_ref")
    conf = float(payload.get("conf", 0.25))

    if not image_ref:
        return {"ok": False, "error": "image_ref required"}

    # ATOMIC TRANSACTION
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:

            # 1. CREATE SCAN
            cur.execute(
                "INSERT INTO scans(image_ref) VALUES (%s) RETURNING id;",
                (image_ref,),
            )
            scan_id = cur.fetchone()["id"]

            # 2. RUN MODEL
            res = infer(image_ref, conf)
            if not res["ok"]:
                conn.rollback()
                return res

            filtered = apply_rules(res["detections"])
            counts = Counter(d["item_name"] for d in filtered)

            # 3. PROCESS DETECTIONS
            for name, qty in counts.items():

                item_id = ensure_item(cur, name)

                # log raw detection per scan
                cur.execute(
                    """
                    INSERT INTO scan_detections(scan_id, label, confidence)
                    VALUES (%s,%s,%s);
                    """,
                    (scan_id, name, 1.0),
                )

                # ATOMIC ACCUMULATION
                cur.execute("""
                    INSERT INTO inventory(item_id, quantity, status)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (item_id)
                    DO UPDATE SET
                        quantity = inventory.quantity + EXCLUDED.quantity,
                        status = CASE
                            WHEN inventory.quantity + EXCLUDED.quantity <= 0 THEN 'MISSING'
                            WHEN inventory.quantity + EXCLUDED.quantity = 1 THEN 'LOW'
                            ELSE 'OK'
                        END,
                        last_updated = NOW()
                    RETURNING quantity;
                """, (item_id, qty, compute_status(qty)))

                new_qty = cur.fetchone()["quantity"]

                # EVENT LOG
                cur.execute("""
                    INSERT INTO events(scan_id, item_id, action, confidence)
                    VALUES (%s,%s,%s,%s);
                """, (scan_id, item_id, "DETECTED", 1.0))

            conn.commit()

    return {
        "ok": True,
        "scan_id": scan_id,
        "image_ref": image_ref,
        "items_detected": sum(counts.values())
    }



@app.get("/scans/{scan_id}/detections")
def get_scan_detections(scan_id: int):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT label, COUNT(*) as count
                FROM scan_detections
                WHERE scan_id = %s
                GROUP BY label
                ORDER BY count DESC;
            """, (scan_id,))
            return cur.fetchall()



@app.get("/scans/latest")
def latest_scan():
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT id, created_at, image_ref
                FROM scans
                ORDER BY created_at DESC
                LIMIT 1;
            """)
            return cur.fetchone() or {}






@app.post("/scans/{scan_id}/review")
def review_scan(scan_id: int, payload: Dict[str, Any]):
    items = payload.get("items", [])

    if not isinstance(items, list):
        return {"ok": False, "error": "items must be a list"}

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:

            included_labels = []

            for it in items:
                orig = it.get("original_label")
                final = it.get("final_label", orig)
                included = bool(it.get("included", True))

                if not orig or not final:
                    continue

                final = final.strip().capitalize()

                # log review decision (using EVENTS table)
                cur.execute("""
                    INSERT INTO events(scan_id, item_id, action, confidence)
                    VALUES (%s, NULL, %s, %s);
                """, (scan_id, f"REVIEW_{'INCLUDED' if included else 'EXCLUDED'}", 1.0))

                if included:
                    included_labels.append(final)

            # rebuild inventory snapshot (LIKE OLD SYSTEM)
            for name in set(included_labels):

                cur.execute("SELECT id FROM items WHERE name=%s;", (name,))
                row = cur.fetchone()

                if row:
                    item_id = row["id"]
                else:
                    cur.execute(
                        "INSERT INTO items(name, category) VALUES (%s,%s) RETURNING id;",
                        (name, "Unknown"),
                    )
                    item_id = cur.fetchone()["id"]

                # SNAPSHOT behavior (overwrite, not increment)
                cur.execute("""
                    INSERT INTO inventory(item_id, quantity, status)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (item_id)
                    DO UPDATE SET
                        quantity = inventory.quantity + EXCLUDED.quantity,
                        status = EXCLUDED.status,
                        last_updated = NOW();
                """, (item_id, 1, "OK"))

            conn.commit()

    return {"ok": True, "scan_id": scan_id}



# ------------------ INVENTORY ------------------

@app.get("/inventory")
def inventory():
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT i.name, i.category, inv.quantity, inv.status, inv.last_updated
                FROM inventory inv
                JOIN items i ON i.id = inv.item_id
                ORDER BY i.name;
            """)
            return cur.fetchall()


# ------------------ ALERTS ------------------

@app.get("/alerts")
def alerts():
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT i.name, i.category, inv.quantity, inv.status, inv.last_updated
                FROM inventory inv
                JOIN items i ON i.id = inv.item_id
                WHERE inv.status IN ('LOW', 'MISSING')
                ORDER BY inv.status, i.name;
            """)
            return cur.fetchall()


# ------------------ EVENTS ------------------

@app.get("/events")
def events(limit: int = 50):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT e.id, e.action, e.confidence, e.created_at,
                       i.name AS item_name
                FROM events e
                LEFT JOIN items i ON i.id = e.item_id
                ORDER BY e.created_at DESC
                LIMIT %s;
            """, (limit,))
            return cur.fetchall()


# ------------------ RESET ------------------

@app.post("/inventory/reset")
def reset():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM events;")
            cur.execute("DELETE FROM scan_detections;")
            cur.execute("DELETE FROM inventory;")
            conn.commit()

    return {"ok": True}

