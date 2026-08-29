from fastapi import APIRouter

try:
    from services import events
except ModuleNotFoundError:
    from backend.services import events

router = APIRouter()
router.add_api_route("/alerts", events.alerts, methods=["GET"])
router.add_api_route("/events", events.events, methods=["GET"])
router.add_api_route("/events", events.create_event, methods=["POST"])
