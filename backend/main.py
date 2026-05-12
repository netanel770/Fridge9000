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
    "http://localhost:8081",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8081",
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
MODEL = YOLO("best.pt")
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
        raise HTTPException(status_code=500, detail=str(e))



@app.get("/inventory")
def inventory() -> List[Dict[str, Any]]:
    sql = """
    SELECT i.id, i.name, i.category,
           inv.quantity, inv.status, inv.last_updated
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.quantity > 0
    ORDER BY i.category, i.name;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            return cur.fetchall()


@app.get("/inventory/all")
def inventory_all() -> List[Dict[str, Any]]:
    sql = """
    SELECT i.id, i.name, i.category,
           COALESCE(inv.quantity, 0) AS quantity,
           COALESCE(inv.status, 'MISSING') AS status,
           inv.last_updated
    FROM items i
    LEFT JOIN inventory inv ON i.id = inv.item_id
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

    included_items = []

    for it in items:
        included = bool(it.get("included", True))
        if not included:
            continue

        label = it.get("final_label") or it.get("original_label")
        confidence = float(it.get("confidence", 1.0))

        if label:
            included_items.append({
                "name": label.strip().capitalize(),
                "confidence": confidence,
            })

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

                cur.execute("SELECT id, category FROM items WHERE name = %s;", (name,))
                item = cur.fetchone()

                if not item:
                    if mode == "Removed":
                        raise HTTPException(
                            status_code=400,
                            detail=f"{name} is not in inventory"
                        )

                    cur.execute(
                        "INSERT INTO items(name, category) VALUES (%s, %s) RETURNING id;",
                        (name, "Unknown"),
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

                if mode == "Removed" and current_qty <= 0:
                    raise HTTPException(
                        status_code=400,
                        detail=f"{name} is not in inventory"
                    )

                if not inv:
                    cur.execute(
                        """
                        INSERT INTO inventory(item_id, quantity, status)
                        VALUES (%s, 0, 'MISSING');
                        """,
                        (item_id,),
                    )

                if mode == "Added":
                    new_qty = current_qty + 1
                else:
                    new_qty = current_qty - 1

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
                    INSERT INTO events(scan_id, item_id, action, confidence, quantity_change)
                    VALUES (%s, %s, %s, %s, %s);
                    """,
                    (scan_id, item_id, mode, confidence, 1),
                )

            conn.commit()

    return {"ok": True, "mode": mode, "updated_items": included_items}

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
            detections.append({"label": label, "confidence": confidence})

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
                    INSERT INTO scan_detections(scan_id, label, confidence)
                    VALUES (%s, %s, %s);
                    """,
                    (scan_id, d["item_name"], d["confidence"]),
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
        "quantity": 2        # optional, default 1
    }
    """

    item_name = payload.get("item_name")
    action = payload.get("action")
    quantity_change = int(payload.get("quantity", 1))

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

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:

            # --- Ensure item exists ---
            cur.execute("SELECT id, category FROM items WHERE name = %s;", (item_name,))
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

            # --- Get current inventory ---
            cur.execute(
                "SELECT quantity FROM inventory WHERE item_id = %s;",
                (item_id,),
            )
            inv = cur.fetchone()

            current_qty = inv["quantity"] if inv else 0

            # --- Validation for removal ---
            if action == "Removed":
                if current_qty <= 0:
                    raise HTTPException(
                        status_code=400,
                        detail=f"{item_name} is not in inventory"
                    )

                if current_qty < quantity_change:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Cannot remove {quantity_change}. Only {current_qty} available."
                    )

            # --- Create inventory row if not exists ---
            if not inv:
                cur.execute(
                    """
                    INSERT INTO inventory(item_id, quantity, status)
                    VALUES (%s, 0, 'MISSING');
                    """,
                    (item_id,),
                )

            # --- Calculate new quantity ---
            if action == "Added":
                new_qty = current_qty + quantity_change
            else:
                new_qty = current_qty - quantity_change

            # --- Determine status ---
            if new_qty == 0:
                status = "MISSING"
            elif new_qty == 1:
                status = "LOW"
            else:
                status = "OK"

            # --- Update inventory ---
            cur.execute(
                """
                UPDATE inventory
                SET quantity=%s, status=%s, last_updated=NOW()
                WHERE item_id=%s;
                """,
                (new_qty, status, item_id),
            )

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