from fastapi import APIRouter

try:
    from services import runtime
except ModuleNotFoundError:
    from backend.services import runtime

router = APIRouter()
router.add_api_route("/alerts", runtime.alerts, methods=["GET"])
router.add_api_route("/events", runtime.events, methods=["GET"])
router.add_api_route("/events", runtime.create_event, methods=["POST"])
