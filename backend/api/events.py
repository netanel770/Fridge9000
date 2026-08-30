from typing import Annotated, Any

from fastapi import APIRouter, Depends

try:
    from api.dependencies import get_active_household
    from services import events, households
except ModuleNotFoundError:
    from backend.api.dependencies import get_active_household
    from backend.services import events, households


router = APIRouter()
Household = Annotated[households.HouseholdContext, Depends(get_active_household)]


@router.get("/alerts")
def get_alerts(context: Household):
    return events.alerts(context.household_id)


@router.get("/events")
def get_events(context: Household, limit: int = 50):
    return events.events(limit, context.household_id)


@router.post("/events")
def create_event(payload: dict[str, Any], context: Household):
    return events.create_event(payload, context.household_id)
