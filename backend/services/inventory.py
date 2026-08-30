import os
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import File, HTTPException, UploadFile
from psycopg2.extras import RealDictCursor

try:
    from core.config import UPLOAD_DIR
    from db.connection import get_conn
    from services.detection import apply_rules, infer
except ModuleNotFoundError:
    from backend.core.config import UPLOAD_DIR
    from backend.db.connection import get_conn
    from backend.services.detection import apply_rules, infer



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

def sync_inventory_summary(conn, household_id: int = 1):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM items;")
        items = cur.fetchall()
        for item in items:
            cur.execute(
                "SELECT COALESCE(SUM(quantity), 0) AS quantity FROM inventory_batches WHERE household_id = %s AND item_id = %s;",
                (household_id, item[0]),
            )
            quantity = cur.fetchone()[0]
            status = "MISSING" if quantity == 0 else "LOW" if quantity == 1 else "OK"
            cur.execute(
                """
                INSERT INTO inventory(household_id, item_id, quantity, status, last_updated)
                VALUES (%s, %s, %s, %s, NOW())
                ON CONFLICT (household_id, item_id)
                DO UPDATE SET quantity = EXCLUDED.quantity, status = EXCLUDED.status, last_updated = NOW();
                """,
                (household_id, item[0], quantity, status),
            )


def change_inventory_batches(
    cur, item_id: int, action: str, quantity: int, household_id: int = 1
) -> int:
    """Apply a legacy inventory change to the authoritative batch state."""
    cur.execute(
        "SELECT COALESCE(SUM(quantity), 0) AS quantity FROM inventory_batches WHERE household_id = %s AND item_id = %s;",
        (household_id, item_id),
    )
    current_quantity = cur.fetchone()["quantity"]

    if action == "Added":
        cur.execute(
            """
            SELECT id
            FROM inventory_batches
            WHERE household_id = %s AND item_id = %s
              AND expiry_date IS NULL
              AND expiry_estimate_date IS NULL
            ORDER BY created_at, id
            LIMIT 1
            FOR UPDATE;
            """,
            (household_id, item_id),
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
                INSERT INTO inventory_batches(household_id, item_id, quantity, expiry_source)
                VALUES (%s, %s, %s, 'manual');
                """,
                (household_id, item_id, quantity),
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
        WHERE household_id = %s AND item_id = %s AND quantity > 0
        ORDER BY COALESCE(expiry_date, expiry_estimate_date) NULLS LAST,
                 created_at, id
        FOR UPDATE;
        """,
        (household_id, item_id),
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

def inventory(household_id: int = 1) -> List[Dict[str, Any]]:
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
    LEFT JOIN inventory_batches b ON b.item_id = i.id AND b.household_id = %s
    GROUP BY i.id, i.name, i.category
    HAVING SUM(b.quantity) > 0
    ORDER BY i.category, i.name;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, (household_id,))
            return cur.fetchall()


def inventory_batches(household_id: int = 1) -> List[Dict[str, Any]]:
    sql = """
    SELECT b.id, b.item_id, i.name, i.category,
           b.quantity, b.expiry_date, b.expiry_estimate_date, b.expiry_source,
           b.open_unit_remaining_percent,
           b.created_at, b.last_updated
    FROM inventory_batches b
    JOIN items i ON i.id = b.item_id
    WHERE b.household_id = %s AND b.quantity > 0
    ORDER BY i.category, i.name, b.expiry_date, b.created_at, b.id;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, (household_id,))
            return cur.fetchall()


def update_inventory_batch_remaining(
    batch_id: int, payload: Dict[str, Any], household_id: int = 1
):
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
                WHERE id = %s AND household_id = %s AND quantity > 0
                FOR UPDATE;
                """,
                (batch_id, household_id),
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
                    INSERT INTO events(household_id, scan_id, item_id, action, confidence, quantity_change)
                    VALUES (%s, NULL, %s, 'Removed', 1.0, 1);
                    """,
                    (household_id, batch["item_id"]),
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
                            household_id, item_id, quantity, expiry_date, expiry_estimate_date,
                            expiry_source, open_unit_remaining_percent, created_at, last_updated
                        ) VALUES (%s, %s, 1, %s, %s, %s, %s, %s, NOW())
                        RETURNING id;
                        """,
                        (
                            household_id,
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

            sync_inventory_summary(conn, household_id)
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


def update_inventory_batch_expiry(
    batch_id: int, payload: Dict[str, Any], household_id: int = 1
):
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
                WHERE id = %s AND household_id = %s AND quantity > 0
                RETURNING id, item_id, quantity, expiry_date;
                """,
                (expiry_date, batch_id, household_id),
            )
            updated_batch = cur.fetchone()
            if not updated_batch:
                raise HTTPException(status_code=404, detail="Inventory batch not found")
            conn.commit()
            return {"ok": True, "batch": updated_batch}


def remove_inventory_batch(batch_id: int, household_id: int = 1):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, item_id, quantity
                FROM inventory_batches
                WHERE id = %s AND household_id = %s AND quantity > 0
                FOR UPDATE;
                """,
                (batch_id, household_id),
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
                INSERT INTO events(household_id, scan_id, item_id, action, confidence, quantity_change)
                VALUES (%s, NULL, %s, 'Removed', 1.0, %s);
                """,
                (household_id, batch["item_id"], batch["quantity"]),
            )
            sync_inventory_summary(conn, household_id)
            conn.commit()
            return {"ok": True, "removed_quantity": batch["quantity"]}


def remove_inventory_batch_quantity(
    batch_id: int, payload: Dict[str, Any], household_id: int = 1
):
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
                WHERE id = %s AND household_id = %s AND quantity > 0
                FOR UPDATE;
                """,
                (batch_id, household_id),
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
                INSERT INTO events(household_id, scan_id, item_id, action, confidence, quantity_change)
                VALUES (%s, NULL, %s, 'Removed', 1.0, %s);
                """,
                (household_id, batch["item_id"], quantity),
            )
            sync_inventory_summary(conn, household_id)
            conn.commit()
            return {
                "ok": True,
                "removed_quantity": quantity,
                "remaining_quantity": batch["quantity"] - quantity,
            }


def inventory_all(household_id: int = 1) -> List[Dict[str, Any]]:
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
    LEFT JOIN inventory_batches b ON b.item_id = i.id AND b.household_id = %s
    GROUP BY i.id, i.name, i.category
    ORDER BY i.category, i.name;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, (household_id,))
            return cur.fetchall()

def reset_inventory(household_id: int = 1):
    """
    Completely clears the inventory and related events.
    """
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                # Optionally clear events first to avoid FK issues
                cur.execute("DELETE FROM events WHERE household_id = %s;", (household_id,))
                # Inventory reads are derived from batches, so both stores must reset.
                cur.execute("DELETE FROM inventory_batches WHERE household_id = %s;", (household_id,))
                cur.execute("DELETE FROM inventory WHERE household_id = %s;", (household_id,))
                # Optional: clear items table if you want a full reset
                # cur.execute("DELETE FROM items;")
                conn.commit()
        return {"ok": True, "message": "Inventory has been reset."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

async def update_inventory_by_image(
    action: str,
    file: UploadFile = File(...),
    household_id: int = 1,
):
    if action not in ("Added", "Removed"):
        raise HTTPException(status_code=400, detail="action must be Added or Removed")

    try:
        ext = file.filename.split(".")[-1]
        filename = f"{uuid.uuid4()}.{ext}"
        os.makedirs(UPLOAD_DIR, exist_ok=True)
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
                            cur, item_id, action, data["count"], household_id
                        )
                    except HTTPException as exc:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Not enough {name} in inventory",
                        ) from exc

                    cur.execute(
                        """
                        INSERT INTO events(household_id, scan_id, item_id, action, confidence)
                        VALUES (%s, %s, %s, %s, %s);
                        """,
                        (household_id, None, item_id, action, data["confidence"]),
                    )

                    updated_items.append({
                        "name": name,
                        "action": action,
                        "quantity_changed": data["count"],
                        "new_quantity": new_qty,
                    })

                sync_inventory_summary(conn, household_id)
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

def manual_inventory(payload: Dict[str, Any], household_id: int = 1):
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
                # ×× ×ž× ×¡×™× ×œ×”×¡×™×¨ ×¤×¨×™×˜ ×©×œ× ×§×™×™×
                if action == "Removed":
                    raise HTTPException(
                        status_code=400,
                        detail=f"{item_name} is not in inventory"
                    )

                # ×™×¦×™×¨×ª ×¤×¨×™×˜ ×—×“×©
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
                        WHERE household_id = %s AND item_id = %s
                          AND quantity > 0
                          AND expiry_date IS NULL
                          AND expiry_estimate_date IS NULL
                        ORDER BY created_at
                        FOR UPDATE
                        """,
                        (household_id, item_id),
                    )
                else:
                    cur.execute(
                        """
                        SELECT id, quantity FROM inventory_batches
                        WHERE household_id = %s AND item_id = %s
                          AND quantity > 0
                          AND COALESCE(expiry_date, expiry_estimate_date) = %s
                        ORDER BY created_at
                        FOR UPDATE
                        """,
                        (household_id, item_id, selected_expiry_date),
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
                    WHERE household_id = %s AND item_id = %s
                      AND COALESCE(expiry_date, expiry_estimate_date) = %s
                      AND expiry_source = %s
                    FOR UPDATE;
                    """,
                    (household_id, item_id, selected_expiry_date, expiry_source),
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
                            household_id, item_id, quantity, expiry_date, expiry_estimate_date, expiry_source
                        )
                        VALUES (%s, %s, %s, %s, %s, %s);
                        """,
                        (
                            household_id,
                            item_id,
                            quantity_change,
                            expiry_date,
                            expiry_estimate_date,
                            expiry_source,
                        ),
                    )

            sync_inventory_summary(conn, household_id)

            cur.execute(
                "SELECT COALESCE(SUM(quantity), 0) AS quantity FROM inventory_batches WHERE household_id = %s AND item_id = %s;",
                (household_id, item_id),
            )
            new_qty = cur.fetchone()["quantity"]
            status = "MISSING" if new_qty == 0 else "LOW" if new_qty == 1 else "OK"

            # --- Create event ---
            cur.execute(
                """
                INSERT INTO events(household_id, scan_id, item_id, action, confidence, quantity_change)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING id;
                """,
                (household_id, None, item_id, action, 1.0, quantity_change),
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
