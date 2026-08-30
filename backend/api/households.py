from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

try:
    from api.dependencies import get_active_household, get_current_user
    from services import auth, households
except ModuleNotFoundError:
    from backend.api.dependencies import get_active_household, get_current_user
    from backend.services import auth, households


router = APIRouter(prefix="/fridges", tags=["fridges"])


class CreateFridgeRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class JoinFridgeRequest(BaseModel):
    join_code: str = Field(min_length=1, max_length=64)


@router.post("", status_code=201)
def create_fridge(
    payload: CreateFridgeRequest,
    user: Annotated[auth.AuthenticatedUser, Depends(get_current_user)],
):
    return households.create_household(user.id, payload.name)


@router.post("/join")
def join_fridge(
    payload: JoinFridgeRequest,
    user: Annotated[auth.AuthenticatedUser, Depends(get_current_user)],
):
    return households.join_household(user.id, payload.join_code)


@router.get("/mine")
def mine(user: Annotated[auth.AuthenticatedUser, Depends(get_current_user)]):
    return households.list_my_households(user.id)


@router.get("/{fridge_id}/members")
def members(
    fridge_id: int,
    context: Annotated[households.HouseholdContext, Depends(get_active_household)],
):
    if context.household_id != fridge_id:
        from fastapi import HTTPException

        raise HTTPException(status_code=403, detail="Selected fridge does not match route")
    return households.list_members(context)


@router.post("/{fridge_id}/members/{user_id}/{action}")
def manage_member(
    fridge_id: int,
    user_id: int,
    action: Literal["approve", "reject", "remove"],
    context: Annotated[households.HouseholdContext, Depends(get_active_household)],
):
    if context.household_id != fridge_id:
        from fastapi import HTTPException

        raise HTTPException(status_code=403, detail="Selected fridge does not match route")
    return households.manage_membership(context, user_id, action)
