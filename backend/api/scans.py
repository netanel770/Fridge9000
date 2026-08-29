from fastapi import APIRouter

try:
    from services import detection, scans
except ModuleNotFoundError:
    from backend.services import detection, scans

router = APIRouter()
router.add_api_route("/door/closed/upload", scans.door_closed_upload, methods=["POST"])
router.add_api_route("/door/closed", scans.door_closed, methods=["POST"])
router.add_api_route("/infer", detection.infer, methods=["POST"])
router.add_api_route("/scans/latest", scans.latest_scan, methods=["GET"])
router.add_api_route("/scans/recent", scans.recent_scans, methods=["GET"])
router.add_api_route("/scans", scans.create_scan, methods=["POST"])
router.add_api_route("/scans/{scan_id}", scans.get_scan, methods=["GET"])
router.add_api_route("/scans/{scan_id}/review", scans.review_scan, methods=["POST"])
router.add_api_route("/scans/{scan_id}/detections", scans.get_scan_detections, methods=["GET"])
router.add_api_route("/scans/{scan_id}/image", scans.get_scan_image, methods=["GET"])
router.add_api_route("/scans/{scan_id}/detections/{detection_id}/boxed", scans.get_detection_boxed_image, methods=["GET"])
