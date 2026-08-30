from fastapi import APIRouter, Depends

try:
    from api.dependencies import get_active_household, get_system_admin
    from services import outlines
except ModuleNotFoundError:
    from backend.api.dependencies import get_active_household, get_system_admin
    from backend.services import outlines


router = APIRouter()
router.add_api_route(
    "/items/{item_id}/representative-image",
    outlines.get_item_representative_image,
    methods=["GET"],
    dependencies=[Depends(get_active_household)],
)
router.add_api_route(
    "/items/{item_id}/representative-image",
    outlines.upload_item_representative_image,
    methods=["POST"],
    dependencies=[Depends(get_system_admin)],
)
router.add_api_route(
    "/outlines/prepare",
    outlines.start_outline_preparation,
    methods=["POST"],
    dependencies=[Depends(get_system_admin)],
)
router.add_api_route(
    "/outlines/jobs/{job_id}",
    outlines.get_outline_preparation_job,
    methods=["GET"],
    dependencies=[Depends(get_system_admin)],
)
