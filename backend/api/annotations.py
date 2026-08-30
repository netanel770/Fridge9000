from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, UploadFile

try:
    from api.dependencies import get_active_household, get_system_admin
    from services import annotations, households
except ModuleNotFoundError:
    from backend.api.dependencies import get_active_household, get_system_admin
    from backend.services import annotations, households


router = APIRouter()
Household = Annotated[households.HouseholdContext, Depends(get_active_household)]


@router.post("/annotation-images/upload")
async def upload_annotation_image(
    context: Household, file: UploadFile = File(...)
):
    return await annotations.upload_annotation_image(
        file, context.household_id, context.user_id
    )


@router.post("/scans/{scan_id}/annotation-submissions")
def create_submission(scan_id: int, payload: dict[str, Any], context: Household):
    return annotations.create_annotation_submission(
        scan_id, payload, context.household_id, context.user_id
    )


@router.get("/annotation-submissions/mine")
def my_submissions(context: Household, status: str | None = None):
    return annotations.list_my_annotation_submissions(
        context.household_id, context.user_id, status
    )


@router.get("/annotation-submissions/mine/{submission_id}")
def my_submission(submission_id: int, context: Household):
    return annotations.get_my_annotation_submission(
        submission_id, context.household_id, context.user_id
    )


@router.patch("/annotations/{annotation_id}")
def update_own_annotation(
    annotation_id: int, payload: dict[str, Any], context: Household
):
    return annotations.update_annotation(
        annotation_id, payload, context.household_id, context.user_id
    )


_admin_only = [Depends(get_system_admin)]
router.add_api_route("/annotation-submissions", annotations.list_annotation_submissions, methods=["GET"], dependencies=_admin_only)
router.add_api_route("/annotation-submissions/stats", annotations.get_annotation_submission_stats, methods=["GET"], dependencies=_admin_only)
router.add_api_route("/annotation-submissions/{submission_id}", annotations.get_annotation_submission, methods=["GET"], dependencies=_admin_only)
router.add_api_route("/annotation-submissions/{submission_id}/image", annotations.get_annotation_submission_image, methods=["GET"], dependencies=_admin_only)
router.add_api_route("/annotation-submissions/{submission_id}", annotations.update_annotation_submission, methods=["PATCH"], dependencies=_admin_only)
router.add_api_route("/annotation-submissions/{submission_id}/quarantine", annotations.update_quarantined_submission, methods=["POST"], dependencies=_admin_only)
