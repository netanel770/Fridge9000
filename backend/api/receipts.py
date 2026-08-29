from fastapi import APIRouter

try:
    from services import receipts
except ModuleNotFoundError:
    from backend.services import receipts

router = APIRouter()
router.add_api_route("/receipts/upload", receipts.upload_receipt, methods=["POST"])
