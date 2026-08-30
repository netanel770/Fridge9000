import re
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator

try:
    from api.dependencies import get_current_user
    from services import auth as auth_service
except ModuleNotFoundError:
    from backend.api.dependencies import get_current_user
    from backend.services import auth as auth_service


router = APIRouter(prefix="/auth", tags=["auth"])
_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _normalize_email(value: str) -> str:
    normalized = value.strip().lower()
    if not _EMAIL_PATTERN.fullmatch(normalized):
        raise ValueError("Enter a valid email address")
    return normalized


class PublicUser(BaseModel):
    id: int
    email: str
    display_name: str | None
    is_active: bool
    is_system_admin: bool
    created_at: datetime
    updated_at: datetime


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"]
    access_token_expires_at: datetime
    refresh_token_expires_at: datetime
    user: PublicUser


class PasswordRegistrationRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=1024)
    display_name: str | None = Field(default=None, max_length=100)

    _validate_email = field_validator("email")(_normalize_email)

    @field_validator("display_name")
    @classmethod
    def normalize_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class PasswordLoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)

    _validate_email = field_validator("email")(_normalize_email)


class RefreshTokenRequest(BaseModel):
    refresh_token: str = Field(min_length=1)


class GoogleAuthRequest(BaseModel):
    id_token: str = Field(min_length=1)


class LogoutResponse(BaseModel):
    ok: Literal[True]


@router.post(
    "/register/password", response_model=TokenResponse, status_code=201
)
def register_password(payload: PasswordRegistrationRequest):
    return auth_service.register_password(
        payload.email, payload.password, payload.display_name
    )


@router.post("/login/password", response_model=TokenResponse)
def login_password(payload: PasswordLoginRequest):
    return auth_service.login_password(payload.email, payload.password)


@router.post("/google", response_model=TokenResponse)
def google(payload: GoogleAuthRequest):
    return auth_service.google_login(payload.id_token)


@router.post("/refresh", response_model=TokenResponse)
def refresh(payload: RefreshTokenRequest):
    return auth_service.refresh_tokens(payload.refresh_token)


@router.post("/logout", response_model=LogoutResponse)
def logout(payload: RefreshTokenRequest):
    return auth_service.logout(payload.refresh_token)


@router.get("/me", response_model=PublicUser)
def me(
    current_user: Annotated[
        auth_service.AuthenticatedUser, Depends(get_current_user)
    ],
):
    return current_user
