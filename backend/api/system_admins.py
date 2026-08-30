from typing import Annotated

from fastapi import APIRouter, Depends

try:
    from api.dependencies import get_system_admin
    from services import auth, system_admins
except ModuleNotFoundError:
    from backend.api.dependencies import get_system_admin
    from backend.services import auth, system_admins


router = APIRouter(prefix="/system-admins", tags=["system-admins"])
SystemAdmin = Annotated[auth.AuthenticatedUser, Depends(get_system_admin)]


@router.get("")
def list_admins(_admin: SystemAdmin):
    return system_admins.list_system_admins()


@router.post("/{user_id}")
def grant_admin(user_id: int, _admin: SystemAdmin):
    return system_admins.grant_system_admin(user_id)
