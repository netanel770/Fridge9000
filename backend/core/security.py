from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import UUID, uuid4

import jwt as _jwt
from argon2 import PasswordHasher as _PasswordHasher
from argon2.exceptions import InvalidHashError as _InvalidHashError
from argon2.exceptions import VerificationError as _VerificationError
from jwt.exceptions import InvalidTokenError as _InvalidTokenError

from .config import (
    JWT_ACCESS_TOKEN_LIFETIME_SECONDS,
    JWT_AUDIENCE,
    JWT_ISSUER,
    JWT_REFRESH_TOKEN_LIFETIME_SECONDS,
    JWT_SECRET,
)


_password_hasher = _PasswordHasher()
_JWT_ALGORITHM = "HS256"

__all__ = [
    "TokenIdentity",
    "create_access_token",
    "create_refresh_token",
    "decode_access_token",
    "decode_refresh_token",
    "hash_password",
    "verify_password",
]


@dataclass(frozen=True)
class TokenIdentity:
    user_id: int
    token_type: Literal["access", "refresh"]
    session_id: str | None = None


def hash_password(plaintext_password: str) -> str:
    return _password_hasher.hash(plaintext_password)


def verify_password(plaintext_password: str, stored_hash: str) -> bool:
    try:
        return _password_hasher.verify(stored_hash, plaintext_password)
    except (_InvalidHashError, _VerificationError):
        return False


def _create_token(
    user_id: int,
    token_type: Literal["access", "refresh"],
    lifetime_seconds: int,
    session_id: str | None = None,
) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": now,
        "exp": now + timedelta(seconds=lifetime_seconds),
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "token_type": token_type,
    }
    payload["jti"] = session_id or str(uuid4())
    return _jwt.encode(payload, JWT_SECRET, algorithm=_JWT_ALGORITHM)


def create_access_token(user_id: int) -> str:
    return _create_token(user_id, "access", JWT_ACCESS_TOKEN_LIFETIME_SECONDS)


def create_refresh_token(user_id: int, session_id: str | None = None) -> str:
    try:
        stable_session_id = str(UUID(session_id)) if session_id else str(uuid4())
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("session_id must be a valid UUID") from exc
    return _create_token(
        user_id,
        "refresh",
        JWT_REFRESH_TOKEN_LIFETIME_SECONDS,
        stable_session_id,
    )


def _decode_token(
    token: str, expected_type: Literal["access", "refresh"]
) -> TokenIdentity | None:
    required_claims = ["sub", "iat", "exp", "iss", "aud", "token_type", "jti"]
    try:
        payload = _jwt.decode(
            token,
            JWT_SECRET,
            algorithms=[_JWT_ALGORITHM],
            audience=JWT_AUDIENCE,
            issuer=JWT_ISSUER,
            options={"require": required_claims},
        )
        if payload["token_type"] != expected_type:
            return None
        user_id = int(payload["sub"])
        if user_id <= 0:
            return None
        session_id = payload.get("jti") if expected_type == "refresh" else None
        if expected_type == "refresh" and (
            not isinstance(session_id, str) or not session_id.strip()
        ):
            return None
        if session_id is not None:
            session_id = str(UUID(session_id))
        return TokenIdentity(user_id, expected_type, session_id)
    except (_InvalidTokenError, KeyError, TypeError, ValueError):
        return None


def decode_access_token(token: str) -> TokenIdentity | None:
    return _decode_token(token, "access")


def decode_refresh_token(token: str) -> TokenIdentity | None:
    return _decode_token(token, "refresh")
