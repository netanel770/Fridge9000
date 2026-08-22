from fastapi import APIRouter

try:
    from services import runtime
except ModuleNotFoundError:
    from backend.services import runtime

router = APIRouter()
router.add_api_route("/scans/{scan_id}/annotation-submissions", runtime.create_annotation_submission, methods=["POST"])
router.add_api_route("/annotation-submissions", runtime.list_annotation_submissions, methods=["GET"])
router.add_api_route("/annotation-submissions/stats", runtime.get_annotation_submission_stats, methods=["GET"])
router.add_api_route("/annotation-submissions/{submission_id}", runtime.get_annotation_submission, methods=["GET"])
router.add_api_route("/annotation-submissions/{submission_id}", runtime.update_annotation_submission, methods=["PATCH"])
router.add_api_route("/annotations/{annotation_id}", runtime.update_annotation, methods=["PATCH"])
