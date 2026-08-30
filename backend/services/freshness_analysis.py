import logging
import os
import threading
import uuid

import cv2
import numpy as np
from fastapi import File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from ultralytics import YOLO

try:
    from ..core.config import (
        FRESHNESS_MAX_UPLOAD_BYTES,
        FRESHNESS_MODEL_PATH,
        FRESHNESS_UPLOAD_DIR,
    )
    from ..freshness import classification_probabilities, parse_freshness_class
    from ..db.connection import get_conn
except ImportError:
    from core.config import (
        FRESHNESS_MAX_UPLOAD_BYTES,
        FRESHNESS_MODEL_PATH,
        FRESHNESS_UPLOAD_DIR,
    )
    from freshness import classification_probabilities, parse_freshness_class
    from db.connection import get_conn


LOGGER = logging.getLogger("uvicorn.error")
_FRESHNESS_MODEL = None
_FRESHNESS_MODEL_LOCK = threading.Lock()


def get_freshness_model():
    global _FRESHNESS_MODEL
    if _FRESHNESS_MODEL is not None:
        return _FRESHNESS_MODEL
    with _FRESHNESS_MODEL_LOCK:
        if _FRESHNESS_MODEL is None:
            if not os.path.isfile(FRESHNESS_MODEL_PATH):
                LOGGER.error("Freshness classifier model is missing: %s", FRESHNESS_MODEL_PATH)
                raise RuntimeError("Freshness classifier model is not available.")
            try:
                _FRESHNESS_MODEL = YOLO(FRESHNESS_MODEL_PATH)
            except Exception as exc:
                LOGGER.exception("Freshness classifier model could not be loaded")
                raise RuntimeError("Freshness classifier model could not be loaded.") from exc
            if getattr(_FRESHNESS_MODEL, "task", None) != "classify":
                LOGGER.error("Freshness model has unexpected task: %s", _FRESHNESS_MODEL.task)
                _FRESHNESS_MODEL = None
                raise RuntimeError("Freshness model is not a classification model.")
            LOGGER.info(
                "Freshness classifier loaded from %s with classes: %s",
                FRESHNESS_MODEL_PATH,
                _FRESHNESS_MODEL.names,
            )
    return _FRESHNESS_MODEL


async def analyze_freshness(
    file: UploadFile = File(...), household_id: int = 1, user_id: int | None = None
):
    allowed_types = {"image/jpeg", "image/png", "image/webp"}
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=415, detail="Upload a JPEG, PNG, or WebP image.")

    contents = await file.read(FRESHNESS_MAX_UPLOAD_BYTES + 1)
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded image is empty.")
    if len(contents) > FRESHNESS_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image is too large (maximum 12 MB).")

    image = cv2.imdecode(np.frombuffer(contents, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Uploaded image could not be decoded.")

    analysis_id = uuid.uuid4().hex
    input_filename = f"{analysis_id}_input.jpg"
    os.makedirs(FRESHNESS_UPLOAD_DIR, exist_ok=True)
    input_path = os.path.join(FRESHNESS_UPLOAD_DIR, input_filename)
    if not cv2.imwrite(input_path, image):
        raise HTTPException(status_code=500, detail="Could not save the uploaded image.")

    try:
        freshness_model = get_freshness_model()
        with _FRESHNESS_MODEL_LOCK:
            results = freshness_model.predict(
                image,
                verbose=False,
            )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        LOGGER.exception("Freshness inference failed")
        raise HTTPException(status_code=500, detail="Freshness analysis failed.") from exc

    if not results or results[0].probs is None:
        LOGGER.error("Freshness classifier returned no probabilities")
        raise HTTPException(status_code=500, detail="Freshness classifier returned no result.")

    result = results[0]
    class_id = int(result.probs.top1)
    confidence = float(result.probs.top1conf.item())
    label = str(freshness_model.names.get(class_id, class_id))
    classification = parse_freshness_class(label)
    if classification is None:
        LOGGER.error("Freshness classifier returned an unexpected class: %s", label)
        raise HTTPException(status_code=422, detail="The model returned an unsupported freshness class.")
    classification.update({"class_id": class_id, "confidence": confidence})

    with get_conn() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO freshness_analyses(
                    id, household_id, created_by_user_id, image_path
                ) VALUES (%s, %s, %s, %s);
                """,
                (analysis_id, household_id, user_id, input_path),
            )
        conn.commit()

    return {
        "ok": True,
        "classification": classification,
        "candidates": classification_probabilities(
            freshness_model.names, result.probs.data, limit=3
        ),
        "image_url": f"/uploads/freshness/{input_filename}",
        "message": (
            f"The image was classified as {classification['condition'].lower()} "
            f"{classification['item'].lower()}."
        ),
    }


def get_freshness_image(
    filename: str, household_id: int = 1, user_id: int | None = None
):
    analysis_id, separator, extension = filename.partition("_input.")
    if not separator or extension != "jpg":
        raise HTTPException(status_code=404, detail="Freshness image not found")
    with get_conn() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT image_path FROM freshness_analyses
                WHERE id = %s AND household_id = %s
                  AND (created_by_user_id = %s OR
                       (household_id = 1 AND created_by_user_id IS NULL));
                """,
                (analysis_id, household_id, user_id),
            )
            row = cursor.fetchone()
    if row is None or not os.path.isfile(row[0]):
        raise HTTPException(status_code=404, detail="Freshness image not found")
    return FileResponse(row[0], media_type="image/jpeg")
