from fastapi import APIRouter

try:
    from services import runtime
except ModuleNotFoundError:
    from backend.services import runtime

router = APIRouter()
router.add_api_route("/inventory", runtime.inventory, methods=["GET"])
router.add_api_route("/inventory/batches", runtime.inventory_batches, methods=["GET"])
router.add_api_route("/inventory/batches/{batch_id}/remaining", runtime.update_inventory_batch_remaining, methods=["PATCH"])
router.add_api_route("/inventory/batches/{batch_id}/expiry", runtime.update_inventory_batch_expiry, methods=["PATCH"])
router.add_api_route("/inventory/batches/{batch_id}/remove", runtime.remove_inventory_batch, methods=["POST"])
router.add_api_route("/inventory/batches/{batch_id}/remove-quantity", runtime.remove_inventory_batch_quantity, methods=["POST"])
router.add_api_route("/inventory/all", runtime.inventory_all, methods=["GET"])
router.add_api_route("/inventory/reset", runtime.reset_inventory, methods=["POST"])
router.add_api_route("/inventory/image/update", runtime.update_inventory_by_image, methods=["POST"])
router.add_api_route("/inventory/manual", runtime.manual_inventory, methods=["POST"])
