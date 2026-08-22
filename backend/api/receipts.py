from fastapi import APIRouter

try:
    from services import runtime
except ModuleNotFoundError:
    from backend.services import runtime

router = APIRouter()
router.add_api_route("/receipts/upload", runtime.upload_receipt, methods=["POST"])
