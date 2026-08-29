import json
import logging
import os
import threading
from datetime import datetime
from typing import Any, Dict, List

import cv2
from psycopg2.extras import RealDictCursor
from ultralytics import YOLO

try:
    from core.config import BACKEND_DIR, RULES_PATH
    from db.connection import get_conn
except ModuleNotFoundError:
    from backend.core.config import BACKEND_DIR, RULES_PATH
    from backend.db.connection import get_conn


MODEL = None
_MODEL_VERSION = None
_MODEL_PATH = None
_MODEL_LOCK = threading.RLock()
LOGGER = logging.getLogger("uvicorn.error")
_RULES_CACHE = None


def load_rules():
    global _RULES_CACHE
    if _RULES_CACHE is None:
        with open(RULES_PATH, "r", encoding="utf-8") as f:
            _RULES_CACHE = json.load(f)
    return _RULES_CACHE

def apply_rules(raw_detections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rules = load_rules()
    deny = set([x.lower() for x in rules.get("deny_labels", [])])
    label_to_item = rules.get("label_to_item", {})
    item_to_category = rules.get("item_to_category", {})
    min_conf_default = float(rules.get("min_conf_default", 0.25))
    min_conf_by_item = rules.get("min_conf_by_item", {})

    normalized = []
    for det in raw_detections:
        label = str(det.get("label", "")).strip().lower()
        conf = float(det.get("confidence", 0))
        if not label:
            continue
        # 1) blacklist
        if label in deny:
            continue
        # 2) mapping label->item
        item_name = label_to_item.get(label, label).strip()
        item_name = item_name[:1].upper() + item_name[1:]  # capitalize ×‘×œ×™ ×œ×”×¨×•×¡ ×ž×™×œ×™×
        # 3) threshold
        min_conf = float(min_conf_by_item.get(item_name, min_conf_default))
        if conf < min_conf:
            continue
        # 4) category
        category = item_to_category.get(item_name, "General")
        normalized.append({
            "item_name": item_name,
            "category": category,
            "confidence": conf,
            "x1": det.get("x1"),
            "y1": det.get("y1"),
            "x2": det.get("x2"),
            "y2": det.get("y2"),
        })
    return normalized


def _resolve_registered_model_path(model_path: str) -> str:
    if os.path.isabs(model_path):
        return os.path.abspath(model_path)
    return os.path.abspath(os.path.join(BACKEND_DIR, model_path))


def _active_model_record():
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, version, model_path, model_sha256, status
                FROM model_versions
                WHERE status = 'active'
                LIMIT 1;
                """
            )
            return cur.fetchone()


def _load_registered_detector(record):
    path = _resolve_registered_model_path(record["model_path"])
    if not os.path.isfile(path):
        raise RuntimeError(f"Registered detector file is missing: {path}")
    expected_hash = record.get("model_sha256")
    if expected_hash:
        import hashlib
        digest = hashlib.sha256()
        with open(path, "rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected_hash:
            raise RuntimeError("Registered detector checksum does not match its model record")
    detector = YOLO(path)
    if getattr(detector, "task", None) != "detect":
        raise RuntimeError("Registered active model is not an object detector")
    return detector, path


def get_detection_model():
    """Return the database-selected detector, refreshing stale worker state safely."""
    global MODEL, _MODEL_VERSION, _MODEL_PATH
    record = _active_model_record()
    if not record:
        raise RuntimeError("No active detector is registered")
    with _MODEL_LOCK:
        if MODEL is None or _MODEL_VERSION != record["version"]:
            detector, path = _load_registered_detector(record)
            MODEL = detector
            _MODEL_VERSION = record["version"]
            _MODEL_PATH = path
            LOGGER.info("Active detector loaded: version=%s path=%s", _MODEL_VERSION, path)
        return MODEL

def health():
    return {
        "status": "ok",
        "time": datetime.utcnow().isoformat(),
        "active_model_version": _MODEL_VERSION,
    }

def infer(payload: Dict[str, Any]):
    """
    payload:
    {
      "image_ref": "C:/Users/Netanel/Desktop/fridge9000/images/test.jpg",
      "conf": 0.25
    }

    returns:
    {
      "ok": true,
      "image_ref": "...",
      "detections": [{"label":"bottle","confidence":0.81}, ...]
    }
    """
    image_ref = payload.get("image_ref")
    conf = float(payload.get("conf", 0.25))

    if not image_ref:
        return {"ok": False, "error": "image_ref required"}

    # OpenCV expects backslashes ok, but normalize slashes is fine
    img = cv2.imread(image_ref)
    if img is None:
        return {"ok": False, "error": f"could not read image at: {image_ref}"}
    image_height, image_width = img.shape[:2]

    try:
        model = get_detection_model()
        with _MODEL_LOCK:
            results = model.predict(img, conf=conf, verbose=False)
            r = results[0]
    except Exception as exc:
        LOGGER.exception("Active detector inference failed")
        return {"ok": False, "error": str(exc)}

    detections = []
    if r.boxes is not None:
        for b in r.boxes:
            cls_id = int(b.cls[0].item())
            label = model.names.get(cls_id, str(cls_id))
            confidence = float(b.conf[0].item())
            xyxy = b.xyxy[0].tolist()
            detections.append({
                "label": label,
                "confidence": confidence,
                "x1": float(xyxy[0]),
                "y1": float(xyxy[1]),
                "x2": float(xyxy[2]),
                "y2": float(xyxy[3]),
            })

    # ×ž×™×•×Ÿ ×œ×¤×™ confidence
    detections.sort(key=lambda x: x["confidence"], reverse=True)

    return {
        "ok": True,
        "image_ref": image_ref,
        "image_width": image_width,
        "image_height": image_height,
        "detections": detections,
    }
