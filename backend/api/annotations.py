from fastapi import APIRouter

try:
    from services import annotations
except ModuleNotFoundError:
    from backend.services import annotations

router = APIRouter()
router.add_api_route("/annotation-images/upload", annotations.upload_annotation_image, methods=["POST"])
router.add_api_route("/scans/{scan_id}/annotation-submissions", annotations.create_annotation_submission, methods=["POST"])
router.add_api_route("/annotation-submissions", annotations.list_annotation_submissions, methods=["GET"])
router.add_api_route("/annotation-submissions/stats", annotations.get_annotation_submission_stats, methods=["GET"])
router.add_api_route("/annotation-submissions/{submission_id}", annotations.get_annotation_submission, methods=["GET"])
router.add_api_route("/annotation-submissions/{submission_id}", annotations.update_annotation_submission, methods=["PATCH"])
router.add_api_route("/annotation-submissions/{submission_id}/quarantine", annotations.update_quarantined_submission, methods=["POST"])
router.add_api_route("/annotations/{annotation_id}", annotations.update_annotation, methods=["PATCH"])
