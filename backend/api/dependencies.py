from typing import Annotated

from fastapi import Depends, Header, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

try:
    from core.security import decode_access_token
    from services import auth, households
except ModuleNotFoundError:
    from backend.core.security import decode_access_token
    from backend.services import auth, households


_bearer = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> auth.AuthenticatedUser:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    identity = decode_access_token(credentials.credentials)
    if identity is None:
        raise HTTPException(
            status_code=401,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return auth.get_active_user(identity.user_id)


def get_active_household(
    current_user: Annotated[auth.AuthenticatedUser, Depends(get_current_user)],
    selected_fridge_id: Annotated[
        int | None, Header(alias="X-Fridge-ID")
    ] = None,
) -> households.HouseholdContext:
    return households.resolve_active_household(current_user.id, selected_fridge_id)


def get_system_admin(
    current_user: Annotated[
        auth.AuthenticatedUser, Depends(get_current_user)
    ],
) -> auth.AuthenticatedUser:
    if not current_user.is_system_admin:
        raise HTTPException(status_code=403, detail="System administrator access required")
    return current_user
