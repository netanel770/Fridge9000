from fastapi import APIRouter

try:
    from services import detection, freshness_analysis
except ModuleNotFoundError:
    from backend.services import detection, freshness_analysis

router = APIRouter()
router.add_api_route("/health", detection.health, methods=["GET"])
router.add_api_route("/freshness/analyze", freshness_analysis.analyze_freshness, methods=["POST"])
