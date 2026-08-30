import secrets
from dataclasses import dataclass

import psycopg2
from fastapi import HTTPException
from psycopg2.extras import RealDictCursor

try:
    from db import households as household_db
    from db.connection import get_conn
except ModuleNotFoundError:
    from backend.db import households as household_db
    from backend.db.connection import get_conn


_JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_MANAGEMENT_ROLES = {"OWNER", "MANAGER"}


@dataclass(frozen=True)
class HouseholdContext:
    household_id: int
    user_id: int
    role: str


def _join_code() -> str:
    return "".join(secrets.choice(_JOIN_CODE_ALPHABET) for _ in range(10))


def create_household(user_id: int, name: str) -> dict:
    normalized_name = name.strip()
    if not normalized_name:
        raise HTTPException(status_code=422, detail="Fridge name is required")
    for _ in range(5):
        try:
            with get_conn() as conn:
                with conn.cursor(cursor_factory=RealDictCursor) as cursor:
                    household = household_db.create_household(
                        cursor, normalized_name, _join_code(), user_id
                    )
                    household_db.create_owner_membership(
                        cursor, household["id"], user_id
                    )
                    conn.commit()
                    return {
                        "id": household["id"],
                        "name": household["name"],
                        "join_code": household["join_code"],
                        "role": "OWNER",
                        "status": "ACTIVE",
                    }
        except psycopg2.errors.UniqueViolation as exc:
            if exc.diag.constraint_name != "households_join_code_key":
                raise
    raise HTTPException(status_code=503, detail="Could not allocate a join code")


def join_household(user_id: int, join_code: str) -> dict:
    normalized_code = join_code.strip().upper()
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            household = household_db.get_household_by_join_code(
                cursor, normalized_code, for_update=True
            )
            if household is None:
                raise HTTPException(status_code=404, detail="Fridge not found")
            current = household_db.get_membership(
                cursor, household["id"], user_id, for_update=True
            )
            if current and current["status"] == "ACTIVE":
                raise HTTPException(
                    status_code=409, detail="Already an active fridge member"
                )
            if current and current["status"] == "PENDING":
                raise HTTPException(
                    status_code=409, detail="Join request is already pending"
                )
            membership = household_db.request_membership(
                cursor, household["id"], user_id
            )
            conn.commit()
            return {
                "fridge_id": household["id"],
                "fridge_name": household["name"],
                "role": membership["role"],
                "status": membership["status"],
            }


def list_my_households(user_id: int) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            rows = household_db.list_user_memberships(cursor, user_id)
    return [
        {
            "fridge_id": row["household_id"],
            "fridge_name": row["household_name"],
            "role": row["role"],
            "status": row["status"],
        }
        for row in rows
    ]


def resolve_active_household(user_id: int, household_id: int | None) -> HouseholdContext:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            if household_id is None:
                memberships = household_db.list_active_memberships(cursor, user_id)
                if not memberships:
                    raise HTTPException(
                        status_code=403, detail="No active fridge membership"
                    )
                if len(memberships) > 1:
                    raise HTTPException(
                        status_code=400, detail="X-Fridge-ID is required"
                    )
                membership = memberships[0]
            else:
                membership = household_db.get_membership(
                    cursor, household_id, user_id
                )
                if not membership or membership["status"] != "ACTIVE":
                    raise HTTPException(
                        status_code=403, detail="No active fridge membership"
                    )
    return HouseholdContext(
        household_id=membership["household_id"],
        user_id=user_id,
        role=membership["role"],
    )


def list_members(context: HouseholdContext) -> dict:
    if context.role not in _MANAGEMENT_ROLES:
        raise HTTPException(status_code=403, detail="Fridge manager access required")
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            members = household_db.list_household_members(
                cursor, context.household_id
            )
    return {
        "fridge_id": context.household_id,
        "join_code": members[0]["join_code"] if members else None,
        "members": [
            {
                "user_id": row["user_id"],
                "email": row["email"],
                "display_name": row["display_name"],
                "role": row["role"],
                "status": row["status"],
                "requested_at": row["requested_at"],
                "reviewed_at": row["reviewed_at"],
            }
            for row in members
        ],
    }


def manage_membership(
    context: HouseholdContext, target_user_id: int, action: str
) -> dict:
    if context.role not in _MANAGEMENT_ROLES:
        raise HTTPException(status_code=403, detail="Fridge manager access required")
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            target = household_db.get_membership(
                cursor, context.household_id, target_user_id, for_update=True
            )
            if target is None:
                raise HTTPException(status_code=404, detail="Membership not found")
            if target["role"] == "OWNER":
                raise HTTPException(status_code=409, detail="The fridge owner cannot be modified")
            if context.role == "MANAGER" and target["role"] != "MEMBER":
                raise HTTPException(status_code=403, detail="Managers may modify members only")
            if action in {"approve", "reject"}:
                if target["status"] != "PENDING" or target["role"] != "MEMBER":
                    raise HTTPException(status_code=409, detail="Membership is not pending")
                new_status = "ACTIVE" if action == "approve" else "REJECTED"
            elif action == "remove":
                if target["status"] != "ACTIVE":
                    raise HTTPException(status_code=409, detail="Membership is not active")
                new_status = "REMOVED"
            else:
                raise ValueError("Unsupported membership action")
            updated = household_db.review_membership(
                cursor, target["membership_id"], new_status, context.user_id
            )
            conn.commit()
            return {
                "user_id": updated["user_id"],
                "role": updated["role"],
                "status": updated["status"],
            }
