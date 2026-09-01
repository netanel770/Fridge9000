from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, UploadFile

try:
    from api.dependencies import get_active_household
    from services import detection, households, scans
except ModuleNotFoundError:
    from backend.api.dependencies import get_active_household
    from backend.services import detection, households, scans


router = APIRouter()
Household = Annotated[households.HouseholdContext, Depends(get_active_household)]


@router.post("/door/closed/upload")
async def door_closed_upload(context: Household, file: UploadFile = File(...)):
    return await scans.door_closed_upload(file, context.household_id, context.user_id)


@router.post("/door/closed")
def door_closed(payload: dict[str, Any], context: Household):
    return scans.door_closed(payload, context.household_id, context.user_id)


@router.post("/infer")
def infer(payload: dict[str, Any], _context: Household):
    return detection.infer(payload)


@router.get("/scans/latest")
def latest_scan(context: Household):
    return scans.latest_scan(context.household_id, context.user_id)


@router.get("/scans/recent")
def recent_scans(context: Household, limit: int = 10):
    return scans.recent_scans(limit, context.household_id, context.user_id)


@router.post("/scans")
def create_scan(payload: dict[str, Any], context: Household):
    return scans.create_scan(payload, context.household_id, context.user_id)


@router.get("/scans/{scan_id}")
def get_scan(scan_id: int, context: Household):
    return scans.get_scan(scan_id, context.household_id, context.user_id)


@router.post("/scans/{scan_id}/review")
def review_scan(scan_id: int, payload: dict[str, Any], context: Household):
    return scans.review_scan(scan_id, payload, context.household_id, context.user_id)


@router.get("/scans/{scan_id}/detections")
def detections(scan_id: int, context: Household):
    return scans.get_scan_detections(scan_id, context.household_id, context.user_id)


@router.get("/scans/{scan_id}/image")
def scan_image(scan_id: int, context: Household):
    return scans.get_scan_image(scan_id, context.household_id, context.user_id)


@router.get("/scans/{scan_id}/detections/{detection_id}/boxed")
def boxed_detection(scan_id: int, detection_id: int, context: Household):
    return scans.get_detection_boxed_image(
        scan_id, detection_id, context.household_id, context.user_id
    )


@router.post("/scans/{scan_id}/detections/{detection_id}/freshness")
def detection_freshness(scan_id: int, detection_id: int, context: Household):
    return scans.analyze_detection_freshness(
        scan_id, detection_id, context.household_id, context.user_id
    )
