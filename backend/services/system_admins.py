from fastapi import HTTPException
from psycopg2.extras import RealDictCursor

try:
    from db import system_admins as admin_db
    from db.connection import get_conn
except ModuleNotFoundError:
    from backend.db import system_admins as admin_db
    from backend.db.connection import get_conn


def list_system_admins() -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            return admin_db.list_active_system_admins(cursor)


def grant_system_admin(user_id: int) -> dict:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            user = admin_db.grant_system_admin(cursor, user_id)
            if user is None:
                raise HTTPException(
                    status_code=404, detail="Active registered user not found"
                )
            conn.commit()
            return user
