def list_active_system_admins(cursor):
    cursor.execute(
        """
        SELECT id, email::text AS email, display_name, is_active,
               is_system_admin, created_at, updated_at
        FROM users
        WHERE is_system_admin = TRUE AND is_active = TRUE
        ORDER BY COALESCE(display_name, email::text), id;
        """
    )
    return cursor.fetchall()


def grant_system_admin(cursor, user_id: int):
    cursor.execute(
        """
        UPDATE users
        SET is_system_admin = TRUE, updated_at = NOW()
        WHERE id = %s AND is_active = TRUE
        RETURNING id, email::text AS email, display_name, is_active,
                  is_system_admin, created_at, updated_at;
        """,
        (user_id,),
    )
    return cursor.fetchone()
