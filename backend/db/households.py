_MEMBERSHIP_COLUMNS = """
    m.id AS membership_id, m.household_id, m.user_id, m.role, m.status,
    m.requested_at, m.reviewed_at, m.reviewed_by_user_id,
    h.name AS household_name, h.join_code, h.is_legacy,
    u.email::text AS email, u.display_name
"""


def create_household(cursor, name: str, join_code: str, creator_user_id: int):
    cursor.execute(
        """
        INSERT INTO households(name, join_code, creator_user_id)
        VALUES (%s, %s, %s)
        RETURNING id, name, join_code, creator_user_id, created_at, updated_at;
        """,
        (name, join_code, creator_user_id),
    )
    return cursor.fetchone()


def create_owner_membership(cursor, household_id: int, user_id: int):
    cursor.execute(
        """
        INSERT INTO household_memberships(household_id, user_id, role, status)
        VALUES (%s, %s, 'OWNER', 'ACTIVE')
        RETURNING *;
        """,
        (household_id, user_id),
    )
    return cursor.fetchone()


def get_household_by_join_code(cursor, join_code: str, *, for_update=False):
    lock = " FOR UPDATE" if for_update else ""
    cursor.execute(
        f"""
        SELECT id, name, join_code, creator_user_id, is_legacy, created_at, updated_at
        FROM households
        WHERE join_code = %s AND is_legacy = FALSE{lock};
        """,
        (join_code,),
    )
    return cursor.fetchone()


def get_membership(cursor, household_id: int, user_id: int, *, for_update=False):
    lock = " FOR UPDATE OF m" if for_update else ""
    cursor.execute(
        f"""
        SELECT {_MEMBERSHIP_COLUMNS}
        FROM household_memberships m
        JOIN households h ON h.id = m.household_id
        JOIN users u ON u.id = m.user_id
        WHERE m.household_id = %s AND m.user_id = %s{lock};
        """,
        (household_id, user_id),
    )
    return cursor.fetchone()


def request_membership(cursor, household_id: int, user_id: int):
    cursor.execute(
        """
        INSERT INTO household_memberships(household_id, user_id, role, status)
        VALUES (%s, %s, 'MEMBER', 'PENDING')
        ON CONFLICT (household_id, user_id) DO UPDATE
        SET role = 'MEMBER', status = 'PENDING', requested_at = NOW(),
            reviewed_at = NULL, reviewed_by_user_id = NULL
        WHERE household_memberships.status IN ('REJECTED', 'REMOVED')
        RETURNING *;
        """,
        (household_id, user_id),
    )
    return cursor.fetchone()


def list_user_memberships(cursor, user_id: int):
    cursor.execute(
        f"""
        SELECT {_MEMBERSHIP_COLUMNS}
        FROM household_memberships m
        JOIN households h ON h.id = m.household_id
        JOIN users u ON u.id = m.user_id
        WHERE m.user_id = %s AND h.is_legacy = FALSE
        ORDER BY h.name, h.id;
        """,
        (user_id,),
    )
    return cursor.fetchall()


def list_active_memberships(cursor, user_id: int):
    cursor.execute(
        f"""
        SELECT {_MEMBERSHIP_COLUMNS}
        FROM household_memberships m
        JOIN households h ON h.id = m.household_id
        JOIN users u ON u.id = m.user_id
        WHERE m.user_id = %s AND m.status = 'ACTIVE' AND h.is_legacy = FALSE
        ORDER BY h.id;
        """,
        (user_id,),
    )
    return cursor.fetchall()


def list_household_members(cursor, household_id: int):
    cursor.execute(
        f"""
        SELECT {_MEMBERSHIP_COLUMNS}
        FROM household_memberships m
        JOIN households h ON h.id = m.household_id
        JOIN users u ON u.id = m.user_id
        WHERE m.household_id = %s
        ORDER BY CASE m.status WHEN 'PENDING' THEN 0 ELSE 1 END,
                 COALESCE(u.display_name, u.email), m.user_id;
        """,
        (household_id,),
    )
    return cursor.fetchall()


def review_membership(
    cursor, membership_id: int, status: str, reviewer_user_id: int
):
    cursor.execute(
        """
        UPDATE household_memberships
        SET status = %s, reviewed_at = NOW(), reviewed_by_user_id = %s
        WHERE id = %s
        RETURNING *;
        """,
        (status, reviewer_user_id, membership_id),
    )
    return cursor.fetchone()
