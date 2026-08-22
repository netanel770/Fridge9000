from fastapi import APIRouter

try:
    from services import runtime
except ModuleNotFoundError:
    from backend.services import runtime

router = APIRouter()
router.add_api_route("/health", runtime.health, methods=["GET"])
router.add_api_route("/freshness/analyze", runtime.analyze_freshness, methods=["POST"])
