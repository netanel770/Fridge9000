from typing import Any, Dict, List

from fastapi import HTTPException
from psycopg2.extras import RealDictCursor

try:
    from db.connection import get_conn
    from services.inventory import change_inventory_batches, sync_inventory_summary
except ModuleNotFoundError:
    from backend.db.connection import get_conn
    from backend.services.inventory import change_inventory_batches, sync_inventory_summary



def alerts(household_id: int = 1) -> List[Dict[str, Any]]:
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
        LEFT JOIN inventory_batches b ON b.item_id = i.id AND b.household_id = %s
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
        WHERE b.household_id = %s AND b.quantity > 0
          AND COALESCE(b.expiry_date, b.expiry_estimate_date) <= CURRENT_DATE + INTERVAL '3 days'
    )
    SELECT * FROM active_alerts
    ORDER BY name, alert_type, expiry_date;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, (household_id, household_id))
            return cur.fetchall()


def events(limit: int = 50, household_id: int = 1) -> List[Dict[str, Any]]:
    sql = """
    SELECT e.id, e.action, e.confidence, e.created_at,
           i.name AS item_name, i.category AS item_category,e.quantity_change,
           e.scan_id
    FROM events e
    LEFT JOIN items i ON i.id = e.item_id
    WHERE e.household_id = %s
    ORDER BY e.created_at DESC
    LIMIT %s;
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, (household_id, limit))
            return cur.fetchall()

def create_event(payload: Dict[str, Any], household_id: int = 1):

    action = payload.get("action")
    item_name = payload.get("item_name")
    confidence = payload.get("confidence")
    scan_id = payload.get("scan_id")

    if not action or not item_name:
        return {"ok": False, "error": "action and item_name required"}

    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            if scan_id is not None:
                cur.execute(
                    "SELECT 1 FROM scans WHERE id = %s AND household_id = %s;",
                    (scan_id, household_id),
                )
                if cur.fetchone() is None:
                    raise HTTPException(status_code=404, detail="Scan not found")
            # get item id
            cur.execute("SELECT id FROM items WHERE name = %s;", (item_name,))
            row = cur.fetchone()
            if not row:
                return {"ok": False, "error": "item not found"}

            item_id = row["id"]

            if action in ("Added", "Removed"):
                change_inventory_batches(cur, item_id, action, 1, household_id)

            # insert event
            cur.execute(
                "INSERT INTO events(household_id, scan_id, item_id, action, confidence) VALUES (%s,%s,%s,%s,%s) RETURNING id;",
                (household_id, scan_id, item_id, action, confidence),
            )
            event_id = cur.fetchone()["id"]
            sync_inventory_summary(conn, household_id)

            conn.commit()

    return {"ok": True, "event_id": event_id}
