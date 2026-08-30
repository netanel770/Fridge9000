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


def _training_setting(name: str, legacy_name: str, default: str) -> str:
    return os.getenv(name, os.getenv(legacy_name, default))


def _non_empty_setting(name: str, default: str) -> str:
    value = os.getenv(name, default).strip()
    if not value:
        raise ValueError(f"{name} must not be empty")
    return value


def _positive_int_setting(name: str, default: str) -> int:
    try:
        value = int(os.getenv(name, default))
    except ValueError as exc:
        raise ValueError(f"{name} must be a positive integer") from exc
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _comma_separated_setting(name: str) -> tuple[str, ...]:
    return tuple(
        value.strip()
        for value in os.getenv(name, "").split(",")
        if value.strip()
    )

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

JWT_SECRET = _non_empty_setting(
    "JWT_SECRET", "development-only-change-me-before-enabling-auth"
)
JWT_ISSUER = _non_empty_setting("JWT_ISSUER", "fridge9000")
JWT_AUDIENCE = _non_empty_setting("JWT_AUDIENCE", "fridge9000-api")
JWT_ACCESS_TOKEN_LIFETIME_SECONDS = _positive_int_setting(
    "JWT_ACCESS_TOKEN_LIFETIME_SECONDS", "900"
)
JWT_REFRESH_TOKEN_LIFETIME_SECONDS = _positive_int_setting(
    "JWT_REFRESH_TOKEN_LIFETIME_SECONDS", "2592000"
)
GOOGLE_OAUTH_CLIENT_IDS = _comma_separated_setting("GOOGLE_OAUTH_CLIENT_IDS")

TRAINING_PROVIDER = os.getenv("TRAINING_PROVIDER", "local").strip().lower()
DEFAULT_KAGGLE_MACHINE_SHAPE = "NvidiaTeslaT4"
KAGGLE_USERNAME = os.getenv("KAGGLE_USERNAME", "").strip()
KAGGLE_KEY = os.getenv("KAGGLE_KEY", "").strip()
KAGGLE_API_TOKEN = os.getenv("KAGGLE_API_TOKEN", "").strip()
KAGGLE_DATASET_SLUG_PREFIX = os.getenv("KAGGLE_DATASET_SLUG_PREFIX", "fridge9000-training-data").strip()
KAGGLE_KERNEL_SLUG = os.getenv("KAGGLE_KERNEL_SLUG", "").strip()
KAGGLE_MACHINE_SHAPE = os.getenv(
    "KAGGLE_MACHINE_SHAPE", DEFAULT_KAGGLE_MACHINE_SHAPE
).strip()
TRAINING_STARTING_WEIGHTS_PATH = Path(
    _training_setting(
        "TRAINING_STARTING_WEIGHTS_PATH",
        "KAGGLE_STARTING_WEIGHTS_PATH",
        str(BACKEND_DIR / "yolo11s.pt"),
    )
)
TRAINING_STARTING_MODEL_VERSION = _training_setting(
    "TRAINING_STARTING_MODEL_VERSION",
    "KAGGLE_STARTING_MODEL_VERSION",
    "yolo11s-pretrained",
).strip()
# Compatibility aliases for deployments that still import the old Kaggle-specific names.
KAGGLE_STARTING_WEIGHTS_PATH = TRAINING_STARTING_WEIGHTS_PATH
KAGGLE_STARTING_MODEL_VERSION = TRAINING_STARTING_MODEL_VERSION
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
