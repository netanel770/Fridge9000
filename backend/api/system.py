from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile

try:
    from api.dependencies import get_active_household
    from services import detection, freshness_analysis, households
except ModuleNotFoundError:
    from backend.api.dependencies import get_active_household
    from backend.services import detection, freshness_analysis, households


router = APIRouter()
Household = Annotated[households.HouseholdContext, Depends(get_active_household)]

router.add_api_route("/health", detection.health, methods=["GET"])


@router.post("/freshness/analyze")
async def analyze_freshness(context: Household, file: UploadFile = File(...)):
    return await freshness_analysis.analyze_freshness(
        file, context.household_id, context.user_id
    )


@router.get("/uploads/freshness/{filename}")
def freshness_image(filename: str, context: Household):
    return freshness_analysis.get_freshness_image(
        filename, context.household_id, context.user_id
    )
