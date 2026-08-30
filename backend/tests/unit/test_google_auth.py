import pytest

from core import google_auth


def _valid_claims(**overrides):
    claims = {
        "sub": "google-subject-123",
        "email": "Person@Example.com",
        "email_verified": True,
        "name": " Test Person ",
    }
    claims.update(overrides)
    return claims


def test_valid_google_token_returns_required_identity(monkeypatch):
    monkeypatch.setattr(google_auth, "GOOGLE_OAUTH_CLIENT_IDS", ("client-id",))
    monkeypatch.setattr(
        google_auth, "_verify_oauth2_token", lambda *_args, **_kwargs: _valid_claims()
    )

    identity = google_auth.verify_google_id_token("signed-token")

    assert identity == google_auth.GoogleIdentityClaims(
        subject="google-subject-123",
        email="Person@Example.com",
        display_name="Test Person",
    )


def test_google_token_is_checked_against_each_configured_audience(monkeypatch):
    attempted = []

    def verify(_token, _request, *, audience):
        attempted.append(audience)
        if audience == "mobile-client":
            return _valid_claims()
        raise ValueError("wrong audience")

    monkeypatch.setattr(
        google_auth,
        "GOOGLE_OAUTH_CLIENT_IDS",
        ("web-client", "mobile-client"),
    )
    monkeypatch.setattr(google_auth, "_verify_oauth2_token", verify)

    assert google_auth.verify_google_id_token("signed-token").subject == (
        "google-subject-123"
    )
    assert attempted == ["web-client", "mobile-client"]


def test_invalid_google_token_fails_safely(monkeypatch):
    monkeypatch.setattr(google_auth, "GOOGLE_OAUTH_CLIENT_IDS", ("client-id",))

    def reject(*_args, **_kwargs):
        raise ValueError("invalid token details must not escape")

    monkeypatch.setattr(google_auth, "_verify_oauth2_token", reject)

    with pytest.raises(google_auth.GoogleTokenVerificationError):
        google_auth.verify_google_id_token("bad-token")


def test_wrong_audience_is_rejected(monkeypatch):
    attempted = []

    def reject(_token, _request, *, audience):
        attempted.append(audience)
        raise ValueError("Token has wrong audience")

    monkeypatch.setattr(
        google_auth, "GOOGLE_OAUTH_CLIENT_IDS", ("web-client", "mobile-client")
    )
    monkeypatch.setattr(google_auth, "_verify_oauth2_token", reject)

    with pytest.raises(google_auth.GoogleTokenVerificationError):
        google_auth.verify_google_id_token("wrong-audience-token")
    assert attempted == ["web-client", "mobile-client"]


@pytest.mark.parametrize(
    "claims",
    [
        _valid_claims(sub=""),
        _valid_claims(email=""),
        _valid_claims(email_verified=False),
        _valid_claims(email_verified="true"),
    ],
)
def test_google_token_requires_subject_and_verified_email(monkeypatch, claims):
    monkeypatch.setattr(google_auth, "GOOGLE_OAUTH_CLIENT_IDS", ("client-id",))
    monkeypatch.setattr(
        google_auth, "_verify_oauth2_token", lambda *_args, **_kwargs: claims
    )

    with pytest.raises(google_auth.GoogleTokenVerificationError):
        google_auth.verify_google_id_token("signed-token")


def test_google_verification_requires_configured_client_id(monkeypatch):
    monkeypatch.setattr(google_auth, "GOOGLE_OAUTH_CLIENT_IDS", ())

    with pytest.raises(google_auth.GoogleAuthUnavailable):
        google_auth.verify_google_id_token("signed-token")
