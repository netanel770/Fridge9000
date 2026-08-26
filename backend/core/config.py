import os
import math
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _probability_setting(name: str, default: str) -> float:
    try:
        value = float(os.getenv(name, default))
    except ValueError as exc:
        raise ValueError(f"{name} must be a number between 0 and 1") from exc
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError(f"{name} must be finite and between 0 and 1")
    return value

BACKEND_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "uploads"))
DATABASE_URL = os.getenv("DATABASE_URL")
RULES_PATH = BACKEND_DIR / "rules.json"
FRESHNESS_MODEL_PATH = Path(os.getenv("FRESHNESS_MODEL_PATH", str(BACKEND_DIR / "fridge9000_freshness_classifier_sanity.pt")))
FRESHNESS_MAX_UPLOAD_BYTES = int(os.getenv("FRESHNESS_MAX_UPLOAD_BYTES", str(12 * 1024 * 1024)))
FRESHNESS_UPLOAD_DIR = UPLOAD_DIR / "freshness"
SEGMENTATION_MODEL_PATH = Path(os.getenv("SEGMENTATION_MODEL_PATH", str(BACKEND_DIR / "sam2_t.pt")))
OUTLINE_DIR = UPLOAD_DIR / "outlines"
CORS_ORIGINS = [
    "http://localhost:8081",
    "http://127.0.0.1:8081",
]

TRAINING_PROVIDER = os.getenv("TRAINING_PROVIDER", "local").strip().lower()
KAGGLE_USERNAME = os.getenv("KAGGLE_USERNAME", "").strip()
KAGGLE_KEY = os.getenv("KAGGLE_KEY", "").strip()
KAGGLE_API_TOKEN = os.getenv("KAGGLE_API_TOKEN", "").strip()
KAGGLE_DATASET_SLUG_PREFIX = os.getenv("KAGGLE_DATASET_SLUG_PREFIX", "fridge9000-training-data").strip()
KAGGLE_KERNEL_SLUG = os.getenv("KAGGLE_KERNEL_SLUG", "").strip()
KAGGLE_STARTING_WEIGHTS_PATH = Path(os.getenv("KAGGLE_STARTING_WEIGHTS_PATH", str(BACKEND_DIR / "yolo11s.pt")))
KAGGLE_STARTING_MODEL_VERSION = os.getenv("KAGGLE_STARTING_MODEL_VERSION", "yolo11s-pretrained").strip()
KAGGLE_CLI_PATH = os.getenv("KAGGLE_CLI_PATH", "kaggle").strip()
KAGGLE_POLL_INTERVAL_SECONDS = int(os.getenv("KAGGLE_POLL_INTERVAL_SECONDS", "30"))
KAGGLE_TIMEOUT_SECONDS = int(os.getenv("KAGGLE_TIMEOUT_SECONDS", "14400"))
KAGGLE_COMMAND_TIMEOUT_SECONDS = int(os.getenv("KAGGLE_COMMAND_TIMEOUT_SECONDS", "300"))
LOCAL_BASE_DATASET_PATH = Path(os.getenv("LOCAL_BASE_DATASET_PATH", str(BACKEND_DIR / "base_dataset")))
MAX_SHARED_MAP50_95_REGRESSION = _probability_setting("MAX_SHARED_MAP50_95_REGRESSION", "0.02")
MIN_ADDED_CLASS_MAP50_95 = _probability_setting("MIN_ADDED_CLASS_MAP50_95", "0.50")
MIN_ADDED_CLASS_PER_CLASS_MAP50_95 = _probability_setting("MIN_ADDED_CLASS_PER_CLASS_MAP50_95", "0.30")

for directory in (UPLOAD_DIR, FRESHNESS_UPLOAD_DIR, OUTLINE_DIR):
    directory.mkdir(parents=True, exist_ok=True)
