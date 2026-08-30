import hashlib
import uuid
from datetime import datetime

import pytest

from core.security import (
    create_refresh_token,
    decode_access_token,
    decode_refresh_token,
    verify_password,
)


pytestmark = [pytest.mark.integration, pytest.mark.api]

_PASSWORD = "correct horse battery staple"
_PUBLIC_USER_FIELDS = {
    "id",
    "email",
    "display_name",
    "is_active",
    "is_system_admin",
    "created_at",
    "updated_at",
}


def _register(client, email="person@example.com", display_name="Test Person"):
    response = client.post(
        "/auth/register/password",
        json={
            "email": email,
            "password": _PASSWORD,
            "display_name": display_name,
        },
    )
    assert response.status_code == 201
    return response.json()


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


def test_password_registration_hashes_password_and_persists_refresh_session(
    test_client, db_connection
):
    body = _register(test_client, " Person@Example.com ", " Test Person ")

    assert body["token_type"] == "bearer"
    assert body["user"]["email"] == "person@example.com"
    assert body["user"]["display_name"] == "Test Person"
    assert set(body["user"]) == _PUBLIC_USER_FIELDS
    assert "password" not in str(body["user"]).lower()

    refresh_identity = decode_refresh_token(body["refresh_token"])
    assert refresh_identity is not None
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT email::text, password_hash FROM users WHERE id = %s;",
            (body["user"]["id"],),
        )
        email, password_hash = cursor.fetchone()
        cursor.execute(
            """
            SELECT id::text, token_hash, expires_at, revoked_at
            FROM refresh_sessions WHERE user_id = %s;
            """,
            (body["user"]["id"],),
        )
        session_id, token_hash, expires_at, revoked_at = cursor.fetchone()

    assert email == "person@example.com"
    assert password_hash != _PASSWORD
    assert verify_password(_PASSWORD, password_hash) is True
    assert body["refresh_token"] != token_hash
    assert token_hash == hashlib.sha256(body["refresh_token"].encode()).hexdigest()
    assert session_id == refresh_identity.session_id
    assert expires_at == datetime.fromisoformat(body["refresh_token_expires_at"])
    assert revoked_at is None


def test_duplicate_registration_is_case_insensitive(test_client):
    _register(test_client, "person@example.com")

    response = test_client.post(
        "/auth/register/password",
        json={"email": "PERSON@EXAMPLE.COM", "password": _PASSWORD},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "Email is already registered"


@pytest.mark.parametrize(
    "payload",
    [
        {"email": "not-an-email", "password": _PASSWORD},
        {"email": "person@example.com", "password": "short"},
        {
            "email": "person@example.com",
            "password": _PASSWORD,
            "display_name": "x" * 101,
        },
    ],
)
def test_registration_rejects_invalid_basic_input(test_client, db_connection, payload):
    response = test_client.post("/auth/register/password", json=payload)

    assert response.status_code == 422
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM users;")
        assert cursor.fetchone()[0] == 0


def test_password_login_issues_new_session(test_client):
    registered = _register(test_client)

    response = test_client.post(
        "/auth/login/password",
        json={"email": "PERSON@EXAMPLE.COM", "password": _PASSWORD},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["refresh_token"] != registered["refresh_token"]
    assert decode_access_token(body["access_token"]).user_id == body["user"]["id"]


def test_wrong_password_and_unknown_email_share_credential_error(test_client):
    _register(test_client)

    wrong_password = test_client.post(
        "/auth/login/password",
        json={"email": "person@example.com", "password": "wrong password"},
    )
    unknown_email = test_client.post(
        "/auth/login/password",
        json={"email": "unknown@example.com", "password": "wrong password"},
    )

    assert wrong_password.status_code == unknown_email.status_code == 401
    assert wrong_password.json() == unknown_email.json() == {
        "detail": "Invalid email or password"
    }


def test_disabled_user_cannot_login(test_client, db_connection):
    body = _register(test_client)
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE users SET is_active = FALSE WHERE id = %s;",
            (body["user"]["id"],),
        )
    db_connection.commit()

    response = test_client.post(
        "/auth/login/password",
        json={"email": "person@example.com", "password": _PASSWORD},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid email or password"


def test_refresh_rotates_session_and_old_token_cannot_be_reused(
    test_client, db_connection
):
    registered = _register(test_client)
    old_identity = decode_refresh_token(registered["refresh_token"])

    response = test_client.post(
        "/auth/refresh", json={"refresh_token": registered["refresh_token"]}
    )

    assert response.status_code == 200
    replacement = response.json()
    new_identity = decode_refresh_token(replacement["refresh_token"])
    assert replacement["refresh_token"] != registered["refresh_token"]
    assert replacement["access_token"] != registered["access_token"]
    assert new_identity.session_id != old_identity.session_id

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id::text, revoked_at
            FROM refresh_sessions
            WHERE user_id = %s ORDER BY created_at, id;
            """,
            (registered["user"]["id"],),
        )
        sessions = {session_id: revoked_at for session_id, revoked_at in cursor.fetchall()}
    assert sessions[old_identity.session_id] is not None
    assert sessions[new_identity.session_id] is None

    reused = test_client.post(
        "/auth/refresh", json={"refresh_token": registered["refresh_token"]}
    )
    assert reused.status_code == 401


@pytest.mark.parametrize("session_state", ["expired", "revoked", "unknown"])
def test_refresh_rejects_unavailable_session(
    test_client, db_connection, session_state
):
    registered = _register(test_client)
    refresh_token = registered["refresh_token"]
    identity = decode_refresh_token(refresh_token)

    if session_state == "unknown":
        refresh_token = create_refresh_token(
            registered["user"]["id"], str(uuid.uuid4())
        )
    else:
        with db_connection.cursor() as cursor:
            if session_state == "expired":
                cursor.execute(
                    """
                    UPDATE refresh_sessions
                    SET expires_at = NOW() - INTERVAL '1 second'
                    WHERE id = %s;
                    """,
                    (identity.session_id,),
                )
            else:
                cursor.execute(
                    "UPDATE refresh_sessions SET revoked_at = NOW() WHERE id = %s;",
                    (identity.session_id,),
                )
        db_connection.commit()

    response = test_client.post(
        "/auth/refresh", json={"refresh_token": refresh_token}
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid refresh token"


def test_access_token_cannot_refresh(test_client):
    registered = _register(test_client)

    response = test_client.post(
        "/auth/refresh", json={"refresh_token": registered["access_token"]}
    )

    assert response.status_code == 401


def test_disabled_user_cannot_refresh(test_client, db_connection):
    registered = _register(test_client)
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE users SET is_active = FALSE WHERE id = %s;",
            (registered["user"]["id"],),
        )
    db_connection.commit()

    response = test_client.post(
        "/auth/refresh", json={"refresh_token": registered["refresh_token"]}
    )

    assert response.status_code == 401


def test_logout_revokes_session_and_is_idempotent(test_client, db_connection):
    registered = _register(test_client)
    refresh_token = registered["refresh_token"]
    identity = decode_refresh_token(refresh_token)

    first = test_client.post("/auth/logout", json={"refresh_token": refresh_token})
    second = test_client.post("/auth/logout", json={"refresh_token": refresh_token})

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json() == {"ok": True}
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT revoked_at FROM refresh_sessions WHERE id = %s;",
            (identity.session_id,),
        )
        assert cursor.fetchone()[0] is not None
        cursor.execute("SELECT COUNT(*) FROM refresh_sessions;")
        assert cursor.fetchone()[0] == 1
    assert test_client.post(
        "/auth/refresh", json={"refresh_token": refresh_token}
    ).status_code == 401


def test_me_returns_only_public_database_user(test_client):
    registered = _register(test_client)

    response = test_client.get(
        "/auth/me", headers=_bearer(registered["access_token"])
    )

    assert response.status_code == 200
    assert response.json() == registered["user"]
    assert set(response.json()) == _PUBLIC_USER_FIELDS


def test_me_rejects_missing_invalid_and_refresh_tokens(test_client):
    registered = _register(test_client)

    responses = [
        test_client.get("/auth/me"),
        test_client.get("/auth/me", headers=_bearer("not-a-token")),
        test_client.get(
            "/auth/me", headers=_bearer(registered["refresh_token"])
        ),
    ]

    assert all(response.status_code == 401 for response in responses)
    assert all(response.json()["detail"] == "Not authenticated" for response in responses)


def test_me_rejects_disabled_user(test_client, db_connection):
    registered = _register(test_client)
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE users SET is_active = FALSE WHERE id = %s;",
            (registered["user"]["id"],),
        )
    db_connection.commit()

    response = test_client.get(
        "/auth/me", headers=_bearer(registered["access_token"])
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Not authenticated"
