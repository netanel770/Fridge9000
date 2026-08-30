from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from hmac import compare_digest
from uuid import uuid4

import psycopg2
from fastapi import HTTPException
from psycopg2.extras import RealDictCursor

try:
    from core.config import (
        JWT_ACCESS_TOKEN_LIFETIME_SECONDS,
        JWT_REFRESH_TOKEN_LIFETIME_SECONDS,
    )
    from core.security import (
        create_access_token,
        create_refresh_token,
        decode_refresh_token,
        hash_password,
        verify_password,
    )
    from core.google_auth import (
        GoogleAuthUnavailable,
        GoogleTokenVerificationError,
        verify_google_id_token,
    )
    from db import auth as auth_db
    from db.connection import get_conn
except ModuleNotFoundError:
    from backend.core.config import (
        JWT_ACCESS_TOKEN_LIFETIME_SECONDS,
        JWT_REFRESH_TOKEN_LIFETIME_SECONDS,
    )
    from backend.core.security import (
        create_access_token,
        create_refresh_token,
        decode_refresh_token,
        hash_password,
        verify_password,
    )
    from backend.core.google_auth import (
        GoogleAuthUnavailable,
        GoogleTokenVerificationError,
        verify_google_id_token,
    )
    from backend.db import auth as auth_db
    from backend.db.connection import get_conn


@dataclass(frozen=True)
class AuthenticatedUser:
    id: int
    email: str
    display_name: str | None
    is_active: bool
    is_system_admin: bool
    created_at: datetime
    updated_at: datetime


_GOOGLE_PROVIDER = "GOOGLE"
_GOOGLE_UNIQUE_CONSTRAINTS = {
    "users_email_key",
    "auth_identities_provider_provider_subject_key",
}


def _authentication_error(detail: str) -> HTTPException:
    return HTTPException(
        status_code=401,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _public_user(row) -> AuthenticatedUser:
    return AuthenticatedUser(
        id=row["id"],
        email=row["email"],
        display_name=row["display_name"],
        is_active=row["is_active"],
        is_system_admin=row["is_system_admin"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _hash_refresh_token(refresh_token: str) -> str:
    return sha256(refresh_token.encode("utf-8")).hexdigest()


def _issue_token_pair(cursor, user, issued_at: datetime | None = None) -> dict:
    issued_at = issued_at or datetime.now(timezone.utc)
    session_id = str(uuid4())
    access_token = create_access_token(user["id"])
    refresh_token = create_refresh_token(user["id"], session_id)
    access_expires_at = issued_at + timedelta(
        seconds=JWT_ACCESS_TOKEN_LIFETIME_SECONDS
    )
    refresh_expires_at = issued_at + timedelta(
        seconds=JWT_REFRESH_TOKEN_LIFETIME_SECONDS
    )
    auth_db.create_refresh_session(
        cursor,
        session_id,
        user["id"],
        _hash_refresh_token(refresh_token),
        issued_at,
        refresh_expires_at,
    )
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "access_token_expires_at": access_expires_at,
        "refresh_token_expires_at": refresh_expires_at,
        "user": asdict(_public_user(user)),
    }


def register_password(email: str, password: str, display_name: str | None) -> dict:
    normalized_email = _normalize_email(email)
    normalized_display_name = display_name.strip() if display_name else None
    password_hash = hash_password(password)
    try:
        with get_conn() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cursor:
                user = auth_db.create_user(
                    cursor,
                    normalized_email,
                    normalized_display_name,
                    password_hash,
                )
                response = _issue_token_pair(cursor, user)
                conn.commit()
                return response
    except psycopg2.errors.UniqueViolation as exc:
        if exc.diag.constraint_name == "users_email_key":
            raise HTTPException(
                status_code=409, detail="Email is already registered"
            ) from exc
        raise


def login_password(email: str, password: str) -> dict:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            user = auth_db.get_user_by_email(cursor, _normalize_email(email))
            if (
                not user
                or not user["password_hash"]
                or not verify_password(password, user["password_hash"])
                or not user["is_active"]
            ):
                raise _authentication_error("Invalid email or password")
            user = auth_db.get_user_by_id(cursor, user["id"], for_update=True)
            if not user or not user["is_active"]:
                raise _authentication_error("Invalid email or password")
            response = _issue_token_pair(cursor, user)
            conn.commit()
            return response


def _login_existing_google_identity(provider_subject: str) -> dict | None:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            user = auth_db.get_auth_identity_with_user(
                cursor, _GOOGLE_PROVIDER, provider_subject, for_update=True
            )
            if user is None:
                return None
            if not user["is_active"]:
                raise _authentication_error("Google authentication failed")
            response = _issue_token_pair(cursor, user)
            conn.commit()
            return response


def google_login(id_token: str) -> dict:
    try:
        identity = verify_google_id_token(id_token)
    except GoogleAuthUnavailable as exc:
        raise HTTPException(
            status_code=503, detail="Google authentication is not configured"
        ) from exc
    except GoogleTokenVerificationError as exc:
        raise _authentication_error("Invalid Google ID token") from exc

    normalized_email = _normalize_email(identity.email)
    try:
        with get_conn() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cursor:
                user = auth_db.get_auth_identity_with_user(
                    cursor,
                    _GOOGLE_PROVIDER,
                    identity.subject,
                    for_update=True,
                )
                if user is not None:
                    if not user["is_active"]:
                        raise _authentication_error(
                            "Google authentication failed"
                        )
                    response = _issue_token_pair(cursor, user)
                    conn.commit()
                    return response

                if auth_db.get_user_by_email(
                    cursor, normalized_email, for_update=True
                ) is not None:
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            "Email is already associated with another sign-in method"
                        ),
                    )

                user = auth_db.create_user(
                    cursor,
                    normalized_email,
                    identity.display_name,
                    None,
                )
                auth_db.create_auth_identity(
                    cursor,
                    user["id"],
                    _GOOGLE_PROVIDER,
                    identity.subject,
                    normalized_email,
                )
                response = _issue_token_pair(cursor, user)
                conn.commit()
                return response
    except psycopg2.errors.UniqueViolation as exc:
        if exc.diag.constraint_name not in _GOOGLE_UNIQUE_CONSTRAINTS:
            raise
        response = _login_existing_google_identity(identity.subject)
        if response is not None:
            return response
        raise HTTPException(
            status_code=409,
            detail="Email is already associated with another sign-in method",
        ) from exc


def refresh_tokens(refresh_token: str) -> dict:
    identity = decode_refresh_token(refresh_token)
    if identity is None or identity.session_id is None:
        raise _authentication_error("Invalid refresh token")
    presented_hash = _hash_refresh_token(refresh_token)
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            session = auth_db.get_refresh_session_with_user_for_update(
                cursor, identity.session_id
            )
            now = datetime.now(timezone.utc)
            if (
                not session
                or session["user_id"] != identity.user_id
                or not compare_digest(session["token_hash"], presented_hash)
                or session["session_revoked_at"] is not None
                or session["session_expires_at"] <= now
                or not session["is_active"]
            ):
                raise _authentication_error("Invalid refresh token")
            auth_db.revoke_refresh_session(cursor, identity.session_id, now)
            response = _issue_token_pair(cursor, session, now)
            conn.commit()
            return response


def logout(refresh_token: str) -> dict:
    identity = decode_refresh_token(refresh_token)
    if identity is None or identity.session_id is None:
        raise _authentication_error("Invalid refresh token")
    presented_hash = _hash_refresh_token(refresh_token)
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            session = auth_db.get_refresh_session_with_user_for_update(
                cursor, identity.session_id
            )
            if (
                not session
                or session["user_id"] != identity.user_id
                or not compare_digest(session["token_hash"], presented_hash)
            ):
                raise _authentication_error("Invalid refresh token")
            auth_db.revoke_refresh_session(
                cursor, identity.session_id, datetime.now(timezone.utc)
            )
            conn.commit()
            return {"ok": True}


def get_active_user(user_id: int) -> AuthenticatedUser:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            user = auth_db.get_user_by_id(cursor, user_id)
            if not user or not user["is_active"]:
                raise _authentication_error("Not authenticated")
            return _public_user(user)
