from fastapi import APIRouter

try:
    from services import runtime
except ModuleNotFoundError:
    from backend.services import runtime

router = APIRouter()
router.add_api_route("/items/{item_id}/representative-image", runtime.get_item_representative_image, methods=["GET"])
router.add_api_route("/items/{item_id}/representative-image", runtime.upload_item_representative_image, methods=["POST"])
router.add_api_route("/outlines/prepare", runtime.start_outline_preparation, methods=["POST"])
router.add_api_route("/outlines/jobs/{job_id}", runtime.get_outline_preparation_job, methods=["GET"])
