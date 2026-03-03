import os
from datetime import datetime
from typing import List, Optional, Dict, Any
from fastapi.middleware.cors import CORSMiddleware
import psycopg2
from psycopg2.extras import RealDictCursor
from fastapi import FastAPI
from dotenv import load_dotenv
from ultralytics import YOLO
import cv2
from fastapi import UploadFile, File
import uuid
import json
from fastapi import HTTPException


UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)
origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
load_dotenv()

app = FastAPI(title="Fridge 9000 API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
DATABASE_URL = os.getenv("DATABASE_URL")
MODEL = YOLO("yolo11s.pt")
RULES_PATH = os.path.join(os.path.dirname(__file__), "rules.json")
_RULES_CACHE = None
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
        normalized.append({"item_name": item_name, "category": category, "confidence": conf})
    return normalized



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
        # תראה את זה גם בלוגים וגם בפרונט
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/inventory")
def inventory() -> List[Dict[str, Any]]:
    sql = """
    SELECT i.id, i.name, i.category,
           inv.quantity, inv.status, inv.last_updated
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    ORDER BY i.category, i.name;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            return cur.fetchall()


@app.post("/scans/{scan_id}/review")
def review_scan(scan_id: int, payload: Dict[str, Any]):
    items = payload.get("items", [])
    if not isinstance(items, list):
        return {"ok": False, "error": "items must be a list"}

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            for it in items:
                orig = it.get("original_label")
                # שינוי: ניקוי רווחים והפיכה לאות גדולה בתחילת מילה (נרמול)
                final = it.get("final_label", orig).strip().capitalize()
                included = bool(it.get("included", True))
                
                if not orig or not final:
                    continue

                cur.execute(
                    """
                    INSERT INTO detection_reviews(scan_id, original_label, final_label, included)
                    VALUES (%s,%s,%s,%s);
                    """,
                    (scan_id, orig, final, included),
                )

            # נרמול רשימת ה-labels
            included_labels = [it.get("final_label", it.get("original_label")).strip().capitalize() 
                               for it in items if it.get("included", True)]

            for name in set(included_labels):
                if not name: continue
                
                # בזכות ה-CITEXT ב-DB, החיפוש הזה ימצא גם 'milk' וגם 'Milk'
                cur.execute("SELECT id FROM items WHERE name = %s;", (name,))
                row = cur.fetchone()
                
                if row:
                    item_id = row["id"]
                else:
                    cur.execute("INSERT INTO items(name, category) VALUES (%s,%s) RETURNING id;", (name, "Unknown"))
                    item_id = cur.fetchone()["id"]

                cur.execute("""
                    INSERT INTO inventory(item_id, quantity, status)
                    VALUES (%s, 1, 'OK')
                    ON CONFLICT (item_id)
                    DO UPDATE SET quantity=1, status='OK', last_updated=NOW();
                """, (item_id,))

            conn.commit()
    return {"ok": True}

@app.get("/scans/{scan_id}/detections")
def get_scan_detections(scan_id: int):
    sql = """
    SELECT id, label, confidence, created_at
    FROM scan_detections
    WHERE scan_id = %s
    ORDER BY confidence DESC;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, (scan_id,))
            return cur.fetchall()

@app.get("/alerts")
def alerts() -> List[Dict[str, Any]]:
    sql = """
    SELECT i.id, i.name, i.category, inv.quantity, inv.status, inv.last_updated
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.status IN ('LOW', 'MISSING')
    ORDER BY inv.status, i.name;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            return cur.fetchall()


@app.get("/events")
def events(limit: int = 50) -> List[Dict[str, Any]]:
    sql = """
    SELECT e.id, e.action, e.confidence, e.created_at,
           i.name AS item_name, i.category AS item_category,
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
            detections.append({"label": label, "confidence": confidence})

    # מיון לפי confidence
    detections.sort(key=lambda x: x["confidence"], reverse=True)

    return {"ok": True, "image_ref": image_ref, "detections": detections}

@app.get("/scans/latest")
def latest_scan():
    sql = """
    SELECT id, created_at, image_ref, delta_skipped
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
    """
    payload example:
    {
      "image_ref": "local://scan_x.jpg",
      "prev_scan_id": 12,
      "delta_skipped": false
    }
    """
    image_ref = payload.get("image_ref")
    prev_scan_id = payload.get("prev_scan_id")  # optional
    delta_skipped = bool(payload.get("delta_skipped", False))

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO scans(image_ref, delta_skipped, prev_scan_id) VALUES (%s, %s, %s) RETURNING id, created_at;",
                (image_ref, delta_skipped, prev_scan_id),
            )
            scan_id, created_at = cur.fetchone()
            conn.commit()

    return {"ok": True, "scan_id": scan_id, "created_at": created_at, "delta_skipped": delta_skipped}


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
    """
    מפעיל את המערכת: יצירת סריקה, הרצת מודל, החלת חוקים (Rules Engine),
    חישוב דלתא (הוספה/הסרה) ועדכון המלאי.
    """
    image_ref = payload.get("image_ref")
    conf = float(payload.get("conf", 0.25))
    if not image_ref:
        return {"ok": False, "error": "image_ref required"}

    # 1. מציאת ה-ID של הסריקה הקודמת לצורך השוואה
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id FROM scans ORDER BY created_at DESC LIMIT 1;")
            prev = cur.fetchone()
            prev_scan_id = prev["id"] if prev else None

    # 2. יצירת רשומה חדשה לסריקה הנוכחית
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO scans(image_ref, delta_skipped, prev_scan_id) VALUES (%s, %s, %s) RETURNING id;",
                (image_ref, False, prev_scan_id),
            )
            scan_id = cur.fetchone()[0]
            conn.commit()

    # 3. הרצת מודל ה-AI (Inference)
    infer_res = infer({"image_ref": image_ref, "conf": conf})
    if not infer_res.get("ok"):
        return {"ok": False, "error": infer_res.get("error"), "scan_id": scan_id}

    raw_dets = infer_res["detections"]

    # --- שלב ה-RULES ENGINE: כאן הקסם קורה ---
    # אנחנו מעבירים את הזיהויים הגולמיים דרך פונקציית החוקים
    filtered_dets = apply_rules(raw_dets)
    
    # יצירת סט של שמות פריטים מנורמלים (למשל: {"Milk", "Yogurt"})
    current_items = set([d["item_name"] for d in filtered_dets])
    # ----------------------------------------

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # 4. שמירת הזיהויים המנורמלים ב-scan_detections (כדי שה-Review UI יראה אותם נקיים)
            for d in filtered_dets:
                cur.execute(
                    "INSERT INTO scan_detections(scan_id, label, confidence) VALUES (%s,%s,%s);",
                    (scan_id, d["item_name"], d["confidence"]),
                )

            # 5. טעינת הפריטים שהיו בסריקה הקודמת לצורך השוואה
            prev_items = set()
            if prev_scan_id:
                cur.execute(
                    "SELECT label FROM scan_detections WHERE scan_id=%s;",
                    (prev_scan_id,),
                )
                prev_rows = cur.fetchall()
                prev_items = set([r["label"] for r in prev_rows])

            # 6. חישוב מה נוסף ומה הוסר (Delta)
            added = list(current_items - prev_items)
            removed = list(prev_items - current_items)

            # פונקציית עזר להבטחת קיום פריט בטבלת items עם קטגוריה נכונה מהחוקים
            def ensure_item(name: str):
                rules = load_rules()
                category = rules["item_to_category"].get(name, "General")
                
                cur.execute("SELECT id FROM items WHERE name=%s;", (name,))
                row = cur.fetchone()
                if row:
                    return row["id"]
                
                cur.execute(
                    "INSERT INTO items(name, category) VALUES (%s, %s) RETURNING id;",
                    (name, category),
                )
                return cur.fetchone()["id"]

            # פונקציית עזר להחלת אירוע (Added/Removed) ועדכון מלאי
            def apply_event(action: str, name: str, confidence: float):
                item_id = ensure_item(name)

                # הזרקת האירוע ללוג
                cur.execute(
                    "INSERT INTO events(scan_id, item_id, action, confidence) VALUES (%s,%s,%s,%s);",
                    (scan_id, item_id, action, confidence),
                )

                # חישוב כמות חדשה
                cur.execute("SELECT quantity FROM inventory WHERE item_id=%s;", (item_id,))
                inv = cur.fetchone()
                quantity = inv["quantity"] if inv else 0
                
                if not inv:
                    cur.execute("INSERT INTO inventory(item_id, quantity) VALUES (%s, 0);", (item_id,))

                if action == "Added":
                    quantity += 1
                elif action == "Removed":
                    quantity = max(0, quantity - 1)

                # קביעת סטטוס לפי כמות
                status = "MISSING" if quantity == 0 else "LOW" if quantity == 1 else "OK"

                cur.execute(
                    "UPDATE inventory SET quantity=%s, status=%s, last_updated=NOW() WHERE item_id=%s;",
                    (quantity, status, item_id),
                )

            # 7. יצירת האירועים בפועל
            conf_map = {d["item_name"]: d["confidence"] for d in filtered_dets}

            for item in added:
                apply_event("Added", item, conf_map.get(item, 0.5))
            for item in removed:
                apply_event("Removed", item, 0.5)

            conn.commit()

    return {
        "ok": True,
        "scan_id": scan_id,
        "prev_scan_id": prev_scan_id,
        "added": added,
        "removed": removed,
        "events_created": len(added) + len(removed),
    }