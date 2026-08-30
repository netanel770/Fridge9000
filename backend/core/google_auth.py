from dataclasses import dataclass

from google.auth.exceptions import GoogleAuthError
from google.auth.transport.requests import Request as _GoogleRequest
from google.oauth2.id_token import verify_oauth2_token as _verify_oauth2_token

from .config import GOOGLE_OAUTH_CLIENT_IDS


class GoogleAuthUnavailable(RuntimeError):
    pass


class GoogleTokenVerificationError(ValueError):
    pass


@dataclass(frozen=True)
class GoogleIdentityClaims:
    subject: str
    email: str
    display_name: str | None


def verify_google_id_token(id_token: str) -> GoogleIdentityClaims:
    if not GOOGLE_OAUTH_CLIENT_IDS:
        raise GoogleAuthUnavailable("Google authentication is not configured")

    claims = None
    request = _GoogleRequest()
    for client_id in GOOGLE_OAUTH_CLIENT_IDS:
        try:
            claims = _verify_oauth2_token(id_token, request, audience=client_id)
            break
        except (GoogleAuthError, ValueError):
            continue

    if claims is None:
        raise GoogleTokenVerificationError("Invalid Google ID token")

    subject = claims.get("sub")
    email = claims.get("email")
    if (
        not isinstance(subject, str)
        or not subject.strip()
        or not isinstance(email, str)
        or not email.strip()
        or claims.get("email_verified") is not True
    ):
        raise GoogleTokenVerificationError("Invalid Google ID token claims")

    name = claims.get("name")
    display_name = name.strip() if isinstance(name, str) and name.strip() else None
    return GoogleIdentityClaims(subject.strip(), email.strip(), display_name)
