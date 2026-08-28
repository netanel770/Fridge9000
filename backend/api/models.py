from fastapi import APIRouter

try:
    from services import runtime
except ModuleNotFoundError:
    from backend.services import runtime

router = APIRouter()
router.add_api_route("/models/{version}/promote", runtime.promote_model, methods=["POST"])
router.add_api_route("/models/{version}/reject", runtime.reject_model, methods=["POST"])
router.add_api_route("/models/{version}/rollback", runtime.rollback_model, methods=["POST"])
router.add_api_route("/ai-progress", runtime.get_ai_progress, methods=["GET"])
router.add_api_route("/model-lifecycle/train", runtime.start_candidate_training, methods=["POST"])
router.add_api_route("/model-lifecycle/candidates/{version}/compare", runtime.start_candidate_comparison, methods=["POST"])
router.add_api_route(
    "/model-lifecycle/rollback-targets/{version}/compare",
    runtime.get_rollback_target_comparison,
    methods=["GET", "POST"],
)
router.add_api_route("/model-lifecycle/jobs/{job_id}", runtime.get_lifecycle_job, methods=["GET"])
