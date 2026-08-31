from typing import Annotated

from fastapi import APIRouter, Depends

try:
    from api.dependencies import get_active_household, get_system_admin
    from services import households, model_lifecycle, model_transparency
except ModuleNotFoundError:
    from backend.api.dependencies import get_active_household, get_system_admin
    from backend.services import households, model_lifecycle, model_transparency


router = APIRouter()
_admin_only = [Depends(get_system_admin)]


@router.get("/models/user-overview")
def user_model_overview(
    _context: Annotated[
        households.HouseholdContext, Depends(get_active_household)
    ],
):
    return model_transparency.get_user_model_overview()


router.add_api_route(
    "/models/{version}/promote",
    model_lifecycle.promote_model,
    methods=["POST"],
    dependencies=_admin_only,
)
router.add_api_route(
    "/models/{version}/reject",
    model_lifecycle.reject_model,
    methods=["POST"],
    dependencies=_admin_only,
)
router.add_api_route(
    "/models/{version}/rollback",
    model_lifecycle.rollback_model,
    methods=["POST"],
    dependencies=_admin_only,
)


@router.get(
    "/ai-progress",
    dependencies=_admin_only,
)
def get_ai_progress():
    progress = model_lifecycle.get_ai_progress()

    # The service's persisted-data checks alone are not enough to decide
    # whether a new training run can start. While this API process is already
    # tracking candidate training/comparison, keep the UI action disabled.
    if model_lifecycle._active_candidate_job() is not None:
        actions = progress.get("actions")
        if isinstance(actions, dict):
            actions["can_train"] = False

    return progress


router.add_api_route(
    "/model-lifecycle/train",
    model_lifecycle.start_candidate_training,
    methods=["POST"],
    dependencies=_admin_only,
)
router.add_api_route(
    "/model-lifecycle/candidates/{version}/compare",
    model_lifecycle.start_candidate_comparison,
    methods=["POST"],
    dependencies=_admin_only,
)


@router.get(
    "/model-lifecycle/rollback-targets/{version}/compare",
    dependencies=_admin_only,
)
def get_rollback_target_comparison(version: str):
    return model_lifecycle.get_rollback_target_comparison(version)


@router.post(
    "/model-lifecycle/rollback-targets/{version}/compare",
    dependencies=_admin_only,
)
def request_rollback_target_comparison(version: str):
    return model_lifecycle.get_rollback_target_comparison(version)


@router.get(
    "/model-lifecycle/active",
    dependencies=_admin_only,
)
def get_active_lifecycle_job():
    return model_lifecycle._active_candidate_job()


router.add_api_route(
    "/model-lifecycle/jobs/{job_id}",
    model_lifecycle.get_lifecycle_job,
    methods=["GET"],
    dependencies=_admin_only,
)
