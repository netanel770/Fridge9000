import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from core.google_auth import (
    GoogleAuthUnavailable,
    GoogleIdentityClaims,
    GoogleTokenVerificationError,
)
from core.security import decode_refresh_token
from services import auth as auth_service


pytestmark = [pytest.mark.integration, pytest.mark.api]


def _claims(
    subject="google-subject-123",
    email="Person@Example.com",
    display_name="Test Person",
):
    return GoogleIdentityClaims(subject, email, display_name)


def _google_login(client, id_token="raw-google-id-token"):
    return client.post("/auth/google", json={"id_token": id_token})


def test_google_login_creates_identity_user_and_hashed_refresh_session(
    test_client, db_connection, monkeypatch
):
    raw_google_token = "raw-google-id-token"
    monkeypatch.setattr(auth_service, "verify_google_id_token", lambda _token: _claims())

    response = _google_login(test_client, raw_google_token)

    assert response.status_code == 200
    body = response.json()
    assert body["user"]["email"] == "person@example.com"
    assert body["user"]["display_name"] == "Test Person"
    refresh_identity = decode_refresh_token(body["refresh_token"])
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT password_hash FROM users WHERE id = %s;",
            (body["user"]["id"],),
        )
        assert cursor.fetchone()[0] is None
        cursor.execute(
            """
            SELECT provider, provider_subject, verified_email::text
            FROM auth_identities WHERE user_id = %s;
            """,
            (body["user"]["id"],),
        )
        assert cursor.fetchone() == (
            "GOOGLE",
            "google-subject-123",
            "person@example.com",
        )
        cursor.execute(
            "SELECT id::text, token_hash FROM refresh_sessions WHERE user_id = %s;",
            (body["user"]["id"],),
        )
        session_id, token_hash = cursor.fetchone()

    assert session_id == refresh_identity.session_id
    assert token_hash == hashlib.sha256(body["refresh_token"].encode()).hexdigest()
    assert raw_google_token not in str(body)
    assert raw_google_token not in token_hash
    assert "password_hash" not in body
    assert "token_hash" not in body


def test_repeated_google_login_reuses_user_and_identity(
    test_client, db_connection, monkeypatch
):
    monkeypatch.setattr(auth_service, "verify_google_id_token", lambda _token: _claims())

    first = _google_login(test_client).json()
    second_response = _google_login(test_client)

    assert second_response.status_code == 200
    second = second_response.json()
    assert second["user"]["id"] == first["user"]["id"]
    assert second["refresh_token"] != first["refresh_token"]
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM users;")
        assert cursor.fetchone()[0] == 1
        cursor.execute("SELECT COUNT(*) FROM auth_identities;")
        assert cursor.fetchone()[0] == 1
        cursor.execute("SELECT COUNT(*) FROM refresh_sessions;")
        assert cursor.fetchone()[0] == 2


def test_concurrent_first_google_logins_converge_on_one_identity(
    db_connection, monkeypatch
):
    monkeypatch.setattr(auth_service, "verify_google_id_token", lambda _token: _claims())
    original_create_user = auth_service.auth_db.create_user
    creation_barrier = threading.Barrier(2)

    def synchronized_create_user(*args, **kwargs):
        creation_barrier.wait(timeout=5)
        return original_create_user(*args, **kwargs)

    monkeypatch.setattr(
        auth_service.auth_db, "create_user", synchronized_create_user
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(auth_service.google_login, ["one", "two"]))

    assert results[0]["user"]["id"] == results[1]["user"]["id"]
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM users;")
        assert cursor.fetchone()[0] == 1
        cursor.execute("SELECT COUNT(*) FROM auth_identities;")
        assert cursor.fetchone()[0] == 1
        cursor.execute("SELECT COUNT(*) FROM refresh_sessions;")
        assert cursor.fetchone()[0] == 2


def test_google_login_does_not_link_existing_email(
    test_client, db_connection, monkeypatch
):
    password_response = test_client.post(
        "/auth/register/password",
        json={"email": "person@example.com", "password": "long enough password"},
    )
    assert password_response.status_code == 201
    monkeypatch.setattr(auth_service, "verify_google_id_token", lambda _token: _claims())

    response = _google_login(test_client)

    assert response.status_code == 409
    assert response.json()["detail"] == (
        "Email is already associated with another sign-in method"
    )
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM auth_identities;")
        assert cursor.fetchone()[0] == 0


def test_disabled_google_user_cannot_login(test_client, db_connection, monkeypatch):
    monkeypatch.setattr(auth_service, "verify_google_id_token", lambda _token: _claims())
    created = _google_login(test_client).json()
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE users SET is_active = FALSE WHERE id = %s;",
            (created["user"]["id"],),
        )
    db_connection.commit()

    response = _google_login(test_client)

    assert response.status_code == 401
    assert response.json()["detail"] == "Google authentication failed"


def test_invalid_google_token_returns_generic_credential_error(
    test_client, monkeypatch
):
    def reject(_token):
        raise GoogleTokenVerificationError("provider implementation detail")

    monkeypatch.setattr(auth_service, "verify_google_id_token", reject)

    response = _google_login(test_client)

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid Google ID token"


def test_unconfigured_google_auth_fails_cleanly(test_client, monkeypatch):
    def unavailable(_token):
        raise GoogleAuthUnavailable("configuration detail")

    monkeypatch.setattr(auth_service, "verify_google_id_token", unavailable)

    response = _google_login(test_client)

    assert response.status_code == 503
    assert response.json()["detail"] == "Google authentication is not configured"
