from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, UploadFile

try:
    from api.dependencies import get_active_household
    from services import households, inventory
except ModuleNotFoundError:
    from backend.api.dependencies import get_active_household
    from backend.services import households, inventory


router = APIRouter()
Household = Annotated[households.HouseholdContext, Depends(get_active_household)]


@router.get("/inventory")
def get_inventory(context: Household):
    return inventory.inventory(context.household_id)


@router.get("/inventory/batches")
def get_batches(context: Household):
    return inventory.inventory_batches(context.household_id)


@router.patch("/inventory/batches/{batch_id}/remaining")
def update_remaining(batch_id: int, payload: dict[str, Any], context: Household):
    return inventory.update_inventory_batch_remaining(batch_id, payload, context.household_id)


@router.patch("/inventory/batches/{batch_id}/expiry")
def update_expiry(batch_id: int, payload: dict[str, Any], context: Household):
    return inventory.update_inventory_batch_expiry(batch_id, payload, context.household_id)


@router.post("/inventory/batches/{batch_id}/remove")
def remove_batch(batch_id: int, context: Household):
    return inventory.remove_inventory_batch(batch_id, context.household_id)


@router.post("/inventory/batches/{batch_id}/remove-quantity")
def remove_quantity(batch_id: int, payload: dict[str, Any], context: Household):
    return inventory.remove_inventory_batch_quantity(batch_id, payload, context.household_id)


@router.get("/inventory/all")
def get_all_inventory(context: Household):
    return inventory.inventory_all(context.household_id)


@router.post("/inventory/reset")
def reset(context: Household):
    return inventory.reset_inventory(context.household_id)


@router.post("/inventory/image/update")
async def update_by_image(action: str, context: Household, file: UploadFile = File(...)):
    return await inventory.update_inventory_by_image(action, file, context.household_id)


@router.post("/inventory/manual")
def update_manually(payload: dict[str, Any], context: Household):
    return inventory.manual_inventory(payload, context.household_id)
