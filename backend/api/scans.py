from fastapi import APIRouter

try:
    from services import runtime
except ModuleNotFoundError:
    from backend.services import runtime

router = APIRouter()
router.add_api_route("/door/closed/upload", runtime.door_closed_upload, methods=["POST"])
router.add_api_route("/door/closed", runtime.door_closed, methods=["POST"])
router.add_api_route("/infer", runtime.infer, methods=["POST"])
router.add_api_route("/scans/latest", runtime.latest_scan, methods=["GET"])
router.add_api_route("/scans/recent", runtime.recent_scans, methods=["GET"])
router.add_api_route("/scans", runtime.create_scan, methods=["POST"])
router.add_api_route("/scans/{scan_id}/review", runtime.review_scan, methods=["POST"])
router.add_api_route("/scans/{scan_id}/detections", runtime.get_scan_detections, methods=["GET"])
router.add_api_route("/scans/{scan_id}/image", runtime.get_scan_image, methods=["GET"])
router.add_api_route("/scans/{scan_id}/detections/{detection_id}/boxed", runtime.get_detection_boxed_image, methods=["GET"])
