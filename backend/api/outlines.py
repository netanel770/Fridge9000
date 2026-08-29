from fastapi import APIRouter

try:
    from services import outlines
except ModuleNotFoundError:
    from backend.services import outlines

router = APIRouter()
router.add_api_route("/items/{item_id}/representative-image", outlines.get_item_representative_image, methods=["GET"])
router.add_api_route("/items/{item_id}/representative-image", outlines.upload_item_representative_image, methods=["POST"])
router.add_api_route("/outlines/prepare", outlines.start_outline_preparation, methods=["POST"])
router.add_api_route("/outlines/jobs/{job_id}", outlines.get_outline_preparation_job, methods=["GET"])
