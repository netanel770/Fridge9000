from fastapi import APIRouter

try:
    from services import inventory
except ModuleNotFoundError:
    from backend.services import inventory

router = APIRouter()
router.add_api_route("/inventory", inventory.inventory, methods=["GET"])
router.add_api_route("/inventory/batches", inventory.inventory_batches, methods=["GET"])
router.add_api_route("/inventory/batches/{batch_id}/remaining", inventory.update_inventory_batch_remaining, methods=["PATCH"])
router.add_api_route("/inventory/batches/{batch_id}/expiry", inventory.update_inventory_batch_expiry, methods=["PATCH"])
router.add_api_route("/inventory/batches/{batch_id}/remove", inventory.remove_inventory_batch, methods=["POST"])
router.add_api_route("/inventory/batches/{batch_id}/remove-quantity", inventory.remove_inventory_batch_quantity, methods=["POST"])
router.add_api_route("/inventory/all", inventory.inventory_all, methods=["GET"])
router.add_api_route("/inventory/reset", inventory.reset_inventory, methods=["POST"])
router.add_api_route("/inventory/image/update", inventory.update_inventory_by_image, methods=["POST"])
router.add_api_route("/inventory/manual", inventory.manual_inventory, methods=["POST"])
