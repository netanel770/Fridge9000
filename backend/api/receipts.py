from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile

try:
    from api.dependencies import get_active_household
    from services import households, receipts
except ModuleNotFoundError:
    from backend.api.dependencies import get_active_household
    from backend.services import households, receipts


router = APIRouter()


@router.post("/receipts/upload")
async def upload_receipt(
    context: Annotated[households.HouseholdContext, Depends(get_active_household)],
    file: UploadFile = File(...),
):
    return await receipts.upload_receipt(file, context.household_id, context.user_id)
