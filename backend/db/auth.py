from typing import Any


_USER_COLUMNS = """
    id, email::text AS email, display_name, password_hash,
    is_active, is_system_admin, created_at, updated_at
"""


def create_user(
    cursor, email: str, display_name: str | None, password_hash: str | None
):
    cursor.execute(
        f"""
        INSERT INTO users(email, display_name, password_hash)
        VALUES (%s, %s, %s)
        RETURNING {_USER_COLUMNS};
        """,
        (email, display_name, password_hash),
    )
    return cursor.fetchone()


def create_auth_identity(
    cursor,
    user_id: int,
    provider: str,
    provider_subject: str,
    verified_email: str | None,
):
    cursor.execute(
        """
        INSERT INTO auth_identities(
            user_id, provider, provider_subject, verified_email
        )
        VALUES (%s, %s, %s, %s)
        RETURNING id, user_id, provider, provider_subject,
                  verified_email::text AS verified_email, created_at;
        """,
        (user_id, provider, provider_subject, verified_email),
    )
    return cursor.fetchone()


def get_auth_identity_with_user(
    cursor, provider: str, provider_subject: str, *, for_update: bool = False
):
    lock = " FOR UPDATE OF i, u" if for_update else ""
    cursor.execute(
        f"""
        SELECT i.id AS identity_id, i.provider, i.provider_subject,
               i.verified_email::text AS verified_email,
               u.id, u.email::text AS email, u.display_name, u.password_hash,
               u.is_active, u.is_system_admin, u.created_at, u.updated_at
        FROM auth_identities i
        JOIN users u ON u.id = i.user_id
        WHERE i.provider = %s AND i.provider_subject = %s{lock};
        """,
        (provider, provider_subject),
    )
    return cursor.fetchone()


def get_user_by_email(cursor, email: str, *, for_update: bool = False):
    lock = " FOR UPDATE" if for_update else ""
    cursor.execute(
        f"SELECT {_USER_COLUMNS} FROM users WHERE email = %s{lock};",
        (email,),
    )
    return cursor.fetchone()


def get_user_by_id(cursor, user_id: int, *, for_update: bool = False):
    lock = " FOR UPDATE" if for_update else ""
    cursor.execute(
        f"SELECT {_USER_COLUMNS} FROM users WHERE id = %s{lock};",
        (user_id,),
    )
    return cursor.fetchone()


def create_refresh_session(
    cursor,
    session_id: str,
    user_id: int,
    token_hash: str,
    created_at,
    expires_at,
) -> None:
    cursor.execute(
        """
        INSERT INTO refresh_sessions(id, user_id, token_hash, created_at, expires_at)
        VALUES (%s, %s, %s, %s, %s);
        """,
        (session_id, user_id, token_hash, created_at, expires_at),
    )


def get_refresh_session_with_user_for_update(cursor, session_id: str):
    cursor.execute(
        """
        SELECT s.id::text AS session_id, s.user_id, s.token_hash,
               s.created_at AS session_created_at,
               s.expires_at AS session_expires_at,
               s.revoked_at AS session_revoked_at,
               u.id, u.email::text AS email, u.display_name, u.password_hash,
               u.is_active, u.is_system_admin, u.created_at, u.updated_at
        FROM refresh_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.id = %s
        FOR UPDATE OF s, u;
        """,
        (session_id,),
    )
    return cursor.fetchone()


def revoke_refresh_session(cursor, session_id: str, revoked_at) -> None:
    cursor.execute(
        """
        UPDATE refresh_sessions
        SET revoked_at = COALESCE(revoked_at, %s)
        WHERE id = %s;
        """,
        (revoked_at, session_id),
    )
