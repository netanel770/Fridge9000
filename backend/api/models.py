from fastapi import APIRouter

try:
    from services import model_lifecycle
except ModuleNotFoundError:
    from backend.services import model_lifecycle

router = APIRouter()
router.add_api_route("/models/{version}/promote", model_lifecycle.promote_model, methods=["POST"])
router.add_api_route("/models/{version}/reject", model_lifecycle.reject_model, methods=["POST"])
router.add_api_route("/models/{version}/rollback", model_lifecycle.rollback_model, methods=["POST"])
router.add_api_route("/ai-progress", model_lifecycle.get_ai_progress, methods=["GET"])
router.add_api_route("/model-lifecycle/train", model_lifecycle.start_candidate_training, methods=["POST"])
router.add_api_route("/model-lifecycle/candidates/{version}/compare", model_lifecycle.start_candidate_comparison, methods=["POST"])
router.add_api_route(
    "/model-lifecycle/rollback-targets/{version}/compare",
    model_lifecycle.get_rollback_target_comparison,
    methods=["GET", "POST"],
)
router.add_api_route("/model-lifecycle/jobs/{job_id}", model_lifecycle.get_lifecycle_job, methods=["GET"])
