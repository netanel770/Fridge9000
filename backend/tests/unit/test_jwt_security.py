import pytest

from core import security


pytestmark = pytest.mark.unit


def _tamper(token: str) -> str:
    header, payload, signature = token.split(".")
    replacement = "A" if signature[0] != "A" else "B"
    return f"{header}.{payload}.{replacement}{signature[1:]}"


def test_access_token_round_trip():
    identity = security.decode_access_token(security.create_access_token(42))

    assert identity == security.TokenIdentity(user_id=42, token_type="access")


def test_expired_access_token_is_rejected(monkeypatch):
    monkeypatch.setattr(security, "JWT_ACCESS_TOKEN_LIFETIME_SECONDS", -1)

    assert security.decode_access_token(security.create_access_token(42)) is None


def test_tampered_access_token_is_rejected():
    token = security.create_access_token(42)

    assert security.decode_access_token(_tamper(token)) is None


def test_access_token_with_wrong_issuer_is_rejected(monkeypatch):
    token = security.create_access_token(42)
    monkeypatch.setattr(security, "JWT_ISSUER", "unexpected-issuer")

    assert security.decode_access_token(token) is None


def test_access_token_with_wrong_audience_is_rejected(monkeypatch):
    token = security.create_access_token(42)
    monkeypatch.setattr(security, "JWT_AUDIENCE", "unexpected-audience")

    assert security.decode_access_token(token) is None


def test_refresh_token_is_rejected_by_access_validator():
    token = security.create_refresh_token(42)

    assert security.decode_access_token(token) is None


def test_refresh_token_round_trip_preserves_session_id():
    session_id = "ef488949-8fe0-463f-adb9-f8909189217d"
    token = security.create_refresh_token(42, session_id)

    assert security.decode_refresh_token(token) == security.TokenIdentity(
        user_id=42,
        token_type="refresh",
        session_id=session_id,
    )
    assert security.decode_refresh_token(token).session_id == session_id


def test_refresh_token_requires_uuid_session_id():
    with pytest.raises(ValueError, match="valid UUID"):
        security.create_refresh_token(42, "not-a-session-uuid")


def test_expired_refresh_token_is_rejected(monkeypatch):
    monkeypatch.setattr(security, "JWT_REFRESH_TOKEN_LIFETIME_SECONDS", -1)

    assert security.decode_refresh_token(security.create_refresh_token(42)) is None


def test_tampered_refresh_token_is_rejected():
    token = security.create_refresh_token(42)

    assert security.decode_refresh_token(_tamper(token)) is None


def test_access_token_is_rejected_by_refresh_validator():
    token = security.create_access_token(42)

    assert security.decode_refresh_token(token) is None
