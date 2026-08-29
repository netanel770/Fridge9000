"""Compatibility facade for application startup dependencies."""

try:
    from db.schema import ensure_schema
    from services.detection import get_detection_model
except ModuleNotFoundError:
    from backend.db.schema import ensure_schema
    from backend.services.detection import get_detection_model
