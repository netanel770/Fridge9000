"""Local/Kaggle candidate-training providers for the existing model lifecycle."""

from __future__ import annotations

import json
import importlib.util
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

import psycopg2
from psycopg2.extras import Json, RealDictCursor

from class_aware_metrics import build_class_aware_comparison, require_class_preservation

try:
    from core.config import (
        BACKEND_DIR, DATABASE_URL, KAGGLE_API_TOKEN, KAGGLE_CLI_PATH, KAGGLE_COMMAND_TIMEOUT_SECONDS, LOCAL_BASE_DATASET_PATH,
        KAGGLE_DATASET_SLUG_PREFIX, KAGGLE_KERNEL_SLUG, KAGGLE_KEY, KAGGLE_MACHINE_SHAPE,
        KAGGLE_POLL_INTERVAL_SECONDS, KAGGLE_STARTING_MODEL_VERSION, KAGGLE_STARTING_WEIGHTS_PATH,
        KAGGLE_TIMEOUT_SECONDS, KAGGLE_USERNAME,
    )
except ModuleNotFoundError:
    from backend.core.config import (
        BACKEND_DIR, DATABASE_URL, KAGGLE_API_TOKEN, KAGGLE_CLI_PATH, KAGGLE_COMMAND_TIMEOUT_SECONDS, LOCAL_BASE_DATASET_PATH,
        KAGGLE_DATASET_SLUG_PREFIX, KAGGLE_KERNEL_SLUG, KAGGLE_KEY, KAGGLE_MACHINE_SHAPE,
        KAGGLE_POLL_INTERVAL_SECONDS, KAGGLE_STARTING_MODEL_VERSION, KAGGLE_STARTING_WEIGHTS_PATH,
        KAGGLE_TIMEOUT_SECONDS, KAGGLE_USERNAME,
    )

Progress = Callable[..., None]
METRICS = ("precision", "recall", "map50", "map50_95")
KAGGLE_RESOURCE_SLUG_MAX_LENGTH = 50


class ProviderError(RuntimeError):
    pass


class KaggleForbiddenError(ProviderError):
    """Kaggle denied a request; newly-created private resources may do this briefly."""

    pass


def _kernel_metadata(
    template: dict[str, Any], kernel_slug: str, dataset_slug: str
) -> dict[str, Any]:
    if not KAGGLE_MACHINE_SHAPE:
        raise ProviderError("KAGGLE_MACHINE_SHAPE cannot be empty")
    metadata = dict(template)
    metadata.update(
        {
            "id": kernel_slug,
            "title": kernel_slug.split("/", 1)[1],
            "dataset_sources": [
                f"{KAGGLE_USERNAME}/{KAGGLE_DATASET_SLUG_PREFIX}",
                dataset_slug,
            ],
            "is_private": True,
            "enable_gpu": True,
            "machine_shape": KAGGLE_MACHINE_SHAPE,
            "enable_internet": True,
        }
    )
    return metadata


def _kernel_push_command(kernel_dir: Path) -> list[str]:
    if not KAGGLE_MACHINE_SHAPE:
        raise ProviderError("KAGGLE_MACHINE_SHAPE cannot be empty")
    return [
        "kernels",
        "push",
        "-p",
        str(kernel_dir),
        "--accelerator",
        KAGGLE_MACHINE_SHAPE,
    ]


def _kaggle_resource_slug(owner: str, base: str, unique_suffix: str) -> str:
    """Build an owner/slug identifier that always satisfies Kaggle's 6-50 rule."""
    clean_base = re.sub(r"[^a-z0-9-]", "-", base.casefold()).strip("-") or "fridge9000"
    clean_suffix = re.sub(r"[^a-z0-9-]", "-", unique_suffix.casefold()).strip("-")
    if not clean_suffix:
        raise ProviderError("Cannot create a Kaggle resource slug without a unique run suffix")
    suffix = clean_suffix[-24:]
    base_limit = KAGGLE_RESOURCE_SLUG_MAX_LENGTH - len(suffix) - 1
    slug = f"{clean_base[:base_limit].rstrip('-')}-{suffix}" if base_limit > 0 else suffix[-KAGGLE_RESOURCE_SLUG_MAX_LENGTH:]
    slug = slug.strip("-")
    if len(slug) < 6 or len(slug) > KAGGLE_RESOURCE_SLUG_MAX_LENGTH:
        raise ProviderError(f"Generated Kaggle resource slug has invalid length: {len(slug)}")
    return f"{owner}/{slug}"


def _json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProviderError(f"Invalid remote artifact {path.name}: {exc}") from exc
    if not isinstance(value, dict):
        raise ProviderError(f"Remote artifact {path.name} must contain a JSON object")
    return value


def _metric(value: Any, name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ProviderError(f"Remote metric {name} is missing or invalid") from exc
    if not math.isfinite(number):
        raise ProviderError(f"Remote metric {name} is not finite")
    return number

def _remote_value_matches(remote: Any, expected: Any) -> bool:
    """Compare remote derived data strictly, except for harmless float rounding."""

    # Booleans must remain booleans and match exactly.
    if isinstance(expected, bool):
        return isinstance(remote, bool) and remote == expected

    # Only expected floating-point metric values receive tolerance.
    # Integers such as class_count remain strict.
    if isinstance(expected, float):
        if isinstance(remote, bool) or not isinstance(remote, (int, float)):
            return False

        remote_number = float(remote)
        expected_number = float(expected)

        if not math.isfinite(remote_number) or not math.isfinite(expected_number):
            return False

        return math.isclose(
            remote_number,
            expected_number,
            rel_tol=1e-9,
            abs_tol=1e-12,
        )

    # Dictionary structure and keys must match exactly.
    if isinstance(expected, dict):
        if not isinstance(remote, dict):
            return False

        if remote.keys() != expected.keys():
            return False

        return all(
            _remote_value_matches(remote[key], expected[key])
            for key in expected
        )

    # Lists must have the same length/order and recursively matching values.
    if isinstance(expected, list):
        if not isinstance(remote, list) or len(remote) != len(expected):
            return False

        return all(
            _remote_value_matches(remote_item, expected_item)
            for remote_item, expected_item in zip(remote, expected)
        )

    # Everything else remains strict, including strings, ints and None.
    return type(remote) is type(expected) and remote == expected


def _remote_class_aware_comparison(comparison: dict[str, Any]) -> dict[str, Any]:
    active = comparison.get("active_model")
    candidate = comparison.get("candidate_model")

    if not isinstance(active, dict) or not isinstance(candidate, dict):
        raise ProviderError("Remote comparison is missing model metadata")

    try:
        expected = build_class_aware_comparison(
            {
                "classes": active.get("classes"),
                "per_class": active.get("per_class"),
            },
            {
                "classes": candidate.get("classes"),
                "per_class": candidate.get("per_class"),
            },
        )

        require_class_preservation(
            active.get("classes"),
            candidate.get("classes"),
            "Remote candidate",
        )
    except ValueError as exc:
        raise ProviderError(
            f"Remote class-aware metrics are invalid: {exc}"
        ) from exc

    for field, expected_value in expected.items():
        if field not in comparison or not _remote_value_matches(
            comparison[field],
            expected_value,
        ):
            raise ProviderError(
                f"Remote {field} disagrees with model class metadata or metrics"
            )

    # Always return the backend-recomputed canonical values.
    return expected


def _resolve_model_path(raw: str) -> Path:
    path = Path(raw)
    return path.resolve() if path.is_absolute() else (BACKEND_DIR / path).resolve()


def _active_model() -> dict[str, Any]:
    with psycopg2.connect(DATABASE_URL) as connection:
        with connection.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute("SELECT * FROM model_versions WHERE status = 'active' LIMIT 1;")
            active = cursor.fetchone()
    if not active:
        raise ProviderError("No active detector is registered")
    path = _resolve_model_path(active["model_path"])
    if not path.is_file() or path.stat().st_size == 0:
        raise ProviderError(f"Registered active model weights are unavailable: {path}")
    active["resolved_path"] = path
    return active


def _export(
    job_id: str, selected_submission_ids: list[int] | None = None
) -> tuple[Path, dict[str, Any]]:
    from export_yolo_dataset import DEFAULT_SPLIT_SEED, export_dataset
    target = BACKEND_DIR / "dataset_exports" / job_id
    summary = export_dataset(
        DATABASE_URL,
        target,
        BACKEND_DIR / "uploads",
        0.2,
        DEFAULT_SPLIT_SEED,
        selected_submission_ids,
    )
    manifest = _json(target / "manifest.json")
    if manifest.get("source_submission_status") != "approved":
        raise ProviderError("Export is not restricted to approved submissions")
    if manifest.get("dataset_version") != summary.get("dataset_version"):
        raise ProviderError("Export summary and manifest versions differ")
    if not manifest.get("image_count"):
        raise ProviderError("Correction export contains no images")
    return target, summary


def _load_kaggle_dataset_builder():
    trainer_path = BACKEND_DIR.parent / "kaggle_trainer" / "train.py"
    if not trainer_path.is_file():
        raise ProviderError(f"Combined-dataset builder is unavailable: {trainer_path}")
    spec = importlib.util.spec_from_file_location("fridge9000_kaggle_dataset_builder", trainer_path)
    if spec is None or spec.loader is None:
        raise ProviderError("Could not load the combined-dataset builder")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _prepare_local_combined_dataset(
    correction_dir: Path, dataset_version: str
) -> Path:
    base_root = LOCAL_BASE_DATASET_PATH.resolve()
    required = (base_root / "classes.txt", base_root / "images", base_root / "labels")
    if not required[0].is_file() or not all(path.is_dir() for path in required[1:]):
        raise ProviderError(
            "Local incremental training requires a real base dataset at "
            f"{base_root} containing classes.txt, images/, and labels/. "
            "Configure LOCAL_BASE_DATASET_PATH or use TRAINING_PROVIDER=kaggle."
        )

    builder = _load_kaggle_dataset_builder()
    correction_archive = correction_dir.with_name(f"{correction_dir.name}-corrections")
    if correction_archive.exists():
        raise ProviderError(f"Correction dataset archive already exists: {correction_archive}")
    job = SimpleNamespace(
        dataset_version=dataset_version,
        base_dataset_slug=f"local/{base_root.name}",
        train_fraction=0.70,
        val_fraction=0.15,
        test_fraction=0.15,
    )
    correction_dir.rename(correction_archive)
    try:
        corrections = builder.validate_dataset(
            correction_archive, job, require_evaluation=False
        )
        builder.build_combined_dataset(
            base_root, correction_archive, corrections, correction_dir, job
        )
    except BaseException as exc:
        if correction_dir.exists():
            shutil.rmtree(correction_dir, ignore_errors=True)
        correction_archive.rename(correction_dir)
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        raise ProviderError(f"Could not build the local combined dataset: {exc}") from exc
    return correction_dir


def local_training(
    job_id: str,
    progress: Progress,
    selected_submission_ids: list[int] | None = None,
) -> dict[str, Any]:
    from train_yolo_candidate import train_candidate
    dataset_dir, export_summary = _export(job_id, selected_submission_ids)
    active = _active_model()
    progress(phase="combining_local_dataset", dataset_version=export_summary["dataset_version"])
    dataset_dir = _prepare_local_combined_dataset(
        dataset_dir, export_summary["dataset_version"]
    )
    progress(phase="training_local", dataset_version=export_summary["dataset_version"])
    args = SimpleNamespace(
        dataset_dir=dataset_dir, dataset_version=export_summary["dataset_version"], starting_weights=active["resolved_path"],
        output_root=BACKEND_DIR / "candidate_models", database_url=DATABASE_URL,
        epochs=int(os.getenv("MODEL_TRAIN_EPOCHS", "30")), imgsz=int(os.getenv("MODEL_TRAIN_IMGSZ", "640")),
        batch=int(os.getenv("MODEL_TRAIN_BATCH", "8")), device=os.getenv("MODEL_TRAIN_DEVICE", "cpu"),
        workers=int(os.getenv("MODEL_TRAIN_WORKERS", "0")), patience=int(os.getenv("MODEL_TRAIN_PATIENCE", "10")), seed=0, verbose=False,
    )
    summary, _ = train_candidate(args)
    return {"provider": "local", "dataset_version": export_summary["dataset_version"], "model_version": summary["model_version"], "training_run_id": summary["training_run_id"]}


class KaggleCommandRunner:
    def __init__(self):
        if not KAGGLE_API_TOKEN and (not KAGGLE_USERNAME or not KAGGLE_KEY):
            raise ProviderError("Kaggle credentials are missing; set KAGGLE_API_TOKEN or the legacy KAGGLE_USERNAME/KAGGLE_KEY pair")
        if not KAGGLE_USERNAME:
            raise ProviderError("KAGGLE_USERNAME is required to create private per-run dataset slugs")
        if not KAGGLE_KERNEL_SLUG or "/" not in KAGGLE_KERNEL_SLUG:
            raise ProviderError("KAGGLE_KERNEL_SLUG must be configured as owner/kernel-slug")
        self.environment = os.environ.copy()
        if KAGGLE_API_TOKEN:
            self.environment["KAGGLE_API_TOKEN"] = KAGGLE_API_TOKEN
            self.environment.pop("KAGGLE_KEY", None)
        else:
            self.environment.update({"KAGGLE_USERNAME": KAGGLE_USERNAME, "KAGGLE_KEY": KAGGLE_KEY})

    def run(self, arguments: list[str], *, retry=False) -> str:
        attempts = 3 if retry else 1
        for attempt in range(attempts):
            try:
                result = subprocess.run(
                    [KAGGLE_CLI_PATH, *arguments], shell=False, check=False, capture_output=True, text=True,
                    timeout=KAGGLE_COMMAND_TIMEOUT_SECONDS, env=self.environment,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                if attempt + 1 == attempts:
                    raise ProviderError(f"Kaggle command failed: {type(exc).__name__}: {exc}") from exc
                time.sleep(2 ** attempt)
                continue
            output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
            if result.returncode == 0:
                return output
            if "403" in output and "forbidden" in output.casefold():
                raise KaggleForbiddenError(
                    f"Kaggle denied access to {arguments[0]}. Check the account, API token, and private notebook permissions."
                )
            if attempt + 1 == attempts:
                raise ProviderError(
                    f"Kaggle {arguments[0]} command failed. Check Kaggle availability and the remote job logs."
                )
            time.sleep(2 ** attempt)
        raise AssertionError("unreachable")


def parse_kernel_status(output: str) -> str:
    lowered = output.casefold()
    if any(value in lowered for value in ("error", "failed", "cancelled", "canceled")):
        return "failed"
    if any(value in lowered for value in ("complete", "completed")):
        return "completed"
    if any(value in lowered for value in ("running",)):
        return "running"
    if any(value in lowered for value in ("queued", "pending")):
        return "queued"
    raise ProviderError(f"Unrecognized Kaggle kernel status: {output[-500:]}")


def _wait_for_remote_dataset_files(
    runner: KaggleCommandRunner,
    dataset_slug: str,
    required_files: tuple[str, ...],
    *,
    timeout_seconds: float = 180.0,
    poll_seconds: float = 3.0,
    settle_seconds: float = 20.0,
    max_forbidden_checks: int = 3,
) -> None:
    """Wait for Kaggle's file listing and notebook mounts to become consistent."""
    deadline = time.monotonic() + timeout_seconds
    complete_checks = 0
    last_found: set[str] = set()
    forbidden_checks = 0
    while True:
        try:
            found: set[str] = set()
            page_token = None
            seen_tokens: set[str] = set()
            while True:
                arguments = [
                    "datasets", "files", dataset_slug, "--page-size", "200"
                ]
                if page_token is not None:
                    arguments.extend(["--page-token", page_token])
                listing = runner.run(arguments, retry=True)
                found.update(
                    name
                    for name in required_files
                    if re.search(rf"(?m)^\s*{re.escape(name)}(?:\s|$)", listing)
                )
                if found == set(required_files):
                    break
                token_match = re.search(
                    r"(?m)^Next Page Token\s*=\s*(\S+)\s*$", listing
                )
                if token_match is None:
                    break
                page_token = token_match.group(1)
                if page_token in seen_tokens:
                    raise ProviderError(
                        f"Kaggle repeated dataset page token {page_token!r}"
                    )
                seen_tokens.add(page_token)
            last_found = found
            forbidden_checks = 0
        except KaggleForbiddenError:
            # A freshly-created private dataset can return 403 until its ACL has
            # propagated. Treat it as not-ready here, but nowhere else.
            forbidden_checks += 1
            if forbidden_checks >= max_forbidden_checks:
                raise KaggleForbiddenError(
                    "Kaggle repeatedly denied access to the uploaded dataset. Check account and private dataset permissions."
                )
            found = set()
        complete_checks = complete_checks + 1 if found == set(required_files) else 0
        if complete_checks >= 2:
            # File listing can become consistent shortly before notebook mounts do.
            time.sleep(settle_seconds)
            return
        if time.monotonic() >= deadline:
            missing = [name for name in required_files if name not in last_found]
            raise ProviderError(f"Timed out waiting for Kaggle dataset files: {', '.join(missing)}")
        time.sleep(poll_seconds)


def _zip_dataset(dataset_dir: Path, destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for source in sorted(path for path in dataset_dir.rglob("*") if path.is_file()):
            archive.write(source, source.relative_to(dataset_dir).as_posix())


def _acquire_remote_training_lock():
    connection = psycopg2.connect(DATABASE_URL)
    connection.autocommit = True
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(9000, 2);")
        acquired = cursor.fetchone()[0]
    if not acquired:
        connection.close()
        raise ProviderError("Another remote training submission is already in progress")
    return connection


def _release_remote_training_lock(connection) -> None:
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_unlock(9000, 2);")
    finally:
        connection.close()


def _write_training_record(run_id: str, dataset_version: str, starting_weights: Path, starting_model_version: str, parameters: dict[str, Any]):
    with psycopg2.connect(DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """INSERT INTO training_runs(id,dataset_version,starting_weights_path,starting_model_version,training_parameters,status)
                   VALUES (%s,%s,%s,%s,%s,'running');""",
                (run_id, dataset_version, str(starting_weights), starting_model_version, Json(parameters)),
            )


def _fail_training_record(run_id: str, exc: BaseException):
    message = " ".join(str(exc).split())
    if len(message) > 500:
        message = f"{message[:497]}..."
    with psycopg2.connect(DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE training_runs SET status='failed', ended_at=NOW(), error=%s WHERE id=%s AND status='running';",
                (Json({"type": type(exc).__name__, "message": message or "Remote training failed"}), run_id),
            )


def _remote_phase(run_id: str, phase: str, **metadata: Any):
    payload = {"remote_phase": phase, **metadata}
    with psycopg2.connect(DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE training_runs SET training_parameters=training_parameters || %s WHERE id=%s AND status='running';",
                (Json(payload), run_id),
            )


def _unique_file(root: Path, name: str) -> Path:
    matches = [path for path in root.rglob(name) if path.is_file()]
    if len(matches) != 1:
        raise ProviderError(f"Expected exactly one downloaded {name}, found {len(matches)}")
    return matches[0]


def _register_remote(
    run_id: str,
    dataset_version: str,
    dataset_dir: Path,
    active: dict[str, Any],
    candidate_version: str,
    output: Path,
) -> dict[str, Any]:
    weights = _unique_file(output, "candidate_best.pt")
    comparison = _json(_unique_file(output, "comparison.json"))
    training = _json(_unique_file(output, "training_metrics.json"))
    manifest = _json(_unique_file(output, "run_manifest.json"))
    for document in (comparison, training, manifest):
        if document.get("training_run_id", document.get("job", {}).get("training_run_id")) != run_id:
            raise ProviderError("Downloaded artifacts refer to another training run")
        if document.get("dataset_version", document.get("job", {}).get("dataset_version")) != dataset_version:
            raise ProviderError("Downloaded artifacts refer to another dataset version")
    if comparison.get("active_model", {}).get("version") != active["version"]:
        raise ProviderError("Remote comparison used a different active model")
    if comparison.get("candidate_model", {}).get("version") != candidate_version:
        raise ProviderError("Remote comparison candidate version mismatch")
    if training.get("starting_model", {}).get("version") != KAGGLE_STARTING_MODEL_VERSION:
        raise ProviderError("Remote candidate used unexpected starting weights")
    if manifest.get("base_dataset_slug") != f"{KAGGLE_USERNAME}/{KAGGLE_DATASET_SLUG_PREFIX}":
        raise ProviderError("Remote run used an unexpected base dataset")
    combined = manifest.get("combined_dataset") or {}
    if not combined.get("source_counts", {}).get("base") or not combined.get("source_counts", {}).get("correction"):
        raise ProviderError("Remote run did not include both base and approved correction images")
    combined_mapping = combined.get("class_mapping")
    combined_classes = [
        item.get("name") for item in combined_mapping if isinstance(item, dict)
    ] if isinstance(combined_mapping, list) else []
    try:
        require_class_preservation(
            comparison.get("active_model", {}).get("classes"),
            combined_classes,
            "Remote combined training dataset",
        )
    except ValueError as exc:
        raise ProviderError(str(exc)) from exc
    candidate_metrics = {key: _metric(comparison["candidate_model"].get(key), key) for key in METRICS}
    active_metrics = {key: _metric(comparison["active_model"].get(key), key) for key in METRICS}
    delta = {key: _metric(comparison.get("delta", {}).get(key), f"delta.{key}") for key in METRICS}
    class_aware = _remote_class_aware_comparison(comparison)
    shared_comparison = class_aware["shared_class_comparison"]
    split_hash = comparison.get("evaluation_split_sha256")
    if not isinstance(split_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", split_hash):
        raise ProviderError("Remote comparison is missing its evaluation split fingerprint")
    if weights.stat().st_size == 0:
        raise ProviderError("Downloaded candidate weights are empty")
    with weights.open("rb") as source:
        if not source.read(16):
            raise ProviderError("Downloaded candidate weights are unreadable")
    dataset_manifest = _json(dataset_dir / "manifest.json")
    if dataset_manifest.get("dataset_version") != dataset_version:
        raise ProviderError("Local dataset manifest version does not match the remote training run")
    model_dir = BACKEND_DIR / "candidate_models" / dataset_version / run_id
    model_dir.mkdir(parents=True, exist_ok=False)
    model_path = model_dir / "candidate.pt"
    shutil.copy2(weights, model_path)
    submission_ids = dataset_manifest.get("included_submission_ids") or []
    experimental_ids = dataset_manifest.get("experimental_submission_ids")
    if experimental_ids is not None and any(not isinstance(value, int) or isinstance(value, bool) for value in experimental_ids):
        raise ProviderError("Remote dataset contains invalid experimental submission IDs")
    experimental_ids = None if experimental_ids is None else sorted(set(experimental_ids))
    if experimental_ids is not None and not set(experimental_ids).issubset(submission_ids):
        raise ProviderError("Remote experimental submissions are not part of its dataset")
    comparison_id = f"remote-{run_id}"
    try:
        with psycopg2.connect(DATABASE_URL) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT id FROM model_versions WHERE status='active' FOR UPDATE;")
                current_active = cursor.fetchone()
                if not current_active or current_active[0] != active["id"]:
                    raise ProviderError("Active model changed while remote training was running; refusing stale registration")
                cursor.execute("SELECT id,status,training_state FROM annotation_submissions WHERE id=ANY(%s) FOR UPDATE;", (submission_ids,))
                rows = cursor.fetchall()
                if {row[0] for row in rows} != set(submission_ids) or any(row[1] not in ("approved", "used") for row in rows):
                    raise ProviderError("Remote dataset contains missing or non-approved submissions")
                states = {row[0]: row[2] for row in rows}
                if experimental_ids is None:
                    experimental_ids = sorted(value for value in submission_ids if states[value] == "eligible")
                invalid_trusted = [value for value in submission_ids if value not in experimental_ids and states[value] != "trusted"]
                invalid_experimental = [value for value in experimental_ids if states[value] != "eligible"]
                if invalid_trusted or invalid_experimental:
                    raise ProviderError(
                        "Remote training submission lifecycle changed while training was running: "
                        f"baseline={invalid_trusted}, experimental={invalid_experimental}"
                    )
                cursor.execute(
                    """UPDATE training_runs SET status='completed',ended_at=NOW(),candidate_model_path=%s,
                       precision=%s,recall=%s,map50=%s,map50_95=%s,error=NULL WHERE id=%s AND status='running';""",
                    (str(model_path), candidate_metrics["precision"], candidate_metrics["recall"], candidate_metrics["map50"], candidate_metrics["map50_95"], run_id),
                )
                if cursor.rowcount != 1:
                    raise ProviderError("Remote training record is missing or no longer running")
                cursor.execute(
                    """INSERT INTO model_versions(version,model_path,status,dataset_version,training_run_id,precision,recall,map50,map50_95)
                       VALUES (%s,%s,'candidate',%s,%s,%s,%s,%s,%s) RETURNING id;""",
                    (candidate_version, str(model_path), dataset_version, run_id, candidate_metrics["precision"], candidate_metrics["recall"], candidate_metrics["map50"], candidate_metrics["map50_95"]),
                )
                model_id = cursor.fetchone()[0]
                cursor.execute(
                    """INSERT INTO training_run_submission_usage(training_run_id,submission_id,dataset_version,model_version_id,is_experimental)
                       SELECT %s,id,%s,%s,id=ANY(%s) FROM annotation_submissions WHERE id=ANY(%s);""",
                    (run_id, dataset_version, model_id, experimental_ids, submission_ids),
                )
                cursor.execute(
                    """INSERT INTO training_run_annotation_usage(training_run_id,annotation_id,submission_id,dataset_version,model_version_id,is_experimental)
                       SELECT %s,a.id,a.submission_id,%s,%s,a.submission_id=ANY(%s) FROM annotations a WHERE a.submission_id=ANY(%s);""",
                    (run_id, dataset_version, model_id, experimental_ids, submission_ids),
                )
                cursor.execute(
                    "UPDATE annotation_submissions SET training_state='experimental' WHERE id=ANY(%s) AND training_state='eligible';",
                    (experimental_ids,),
                )
                cursor.execute(
                    """INSERT INTO model_comparisons(id,dataset_version,dataset_content_sha256,validation_split_sha256,
                       active_model_id,candidate_model_id,evaluation_parameters,active_metrics,candidate_metrics,
                       metric_differences,class_comparison,shared_class_comparison,added_class_metrics,
                       comparison_rule,candidate_outperforms_active,summary_path)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s);""",
                    (comparison_id, dataset_version, dataset_manifest.get("content_sha256", "remote"),
                     split_hash, active["id"], model_id, Json({"provider": "kaggle", "split": comparison.get("evaluation_split"), "shared_class_comparison": shared_comparison}),
                     Json(active_metrics), Json(candidate_metrics), Json(delta),
                     Json(class_aware["class_comparison"]), Json(shared_comparison),
                     Json(class_aware["added_class_metrics"]), comparison.get("comparison_rule", "remote comparison"),
                     bool(comparison.get("candidate_outperforms_active")), str(_unique_file(output, "comparison.json"))),
                )
    except BaseException:
        shutil.rmtree(model_dir, ignore_errors=True)
        raise
    return {"provider": "kaggle", "training_run_id": run_id, "dataset_version": dataset_version, "model_version": candidate_version, "comparison_id": comparison_id}


def kaggle_training(
    job_id: str,
    progress: Progress,
    runner: KaggleCommandRunner | None = None,
    selected_submission_ids: list[int] | None = None,
) -> dict[str, Any]:
    runner = runner or KaggleCommandRunner()
    remote_lock = _acquire_remote_training_lock()
    run_id = f"remote-{job_id}"
    record_created = False
    try:
        progress(phase="preparing")
        trainer_dir = BACKEND_DIR.parent / "kaggle_trainer"
        trainer_script = trainer_dir / "train.py"
        kernel_metadata = trainer_dir / "kernel-metadata.json"
        missing_artifacts = [path.name for path in (trainer_script, kernel_metadata) if not path.is_file()]
        if missing_artifacts:
            raise ProviderError(f"Kaggle trainer artifacts are missing from the backend image: {', '.join(missing_artifacts)}")
        dataset_dir, export_summary = _export(job_id, selected_submission_ids)
        dataset_version = export_summary["dataset_version"]
        active = _active_model()
        starting_weights = KAGGLE_STARTING_WEIGHTS_PATH.resolve()
        if not starting_weights.is_file() or starting_weights.stat().st_size == 0:
            raise ProviderError(f"Configured pretrained detector weights are unavailable: {starting_weights}")
        if starting_weights == active["resolved_path"]:
            raise ProviderError("Kaggle starting weights must be pretrained detector weights, not the active application model")
        candidate_version = f"fridge9000-detector-{run_id}"
        parameters = {
            "provider": "kaggle", "epochs": int(os.getenv("MODEL_TRAIN_EPOCHS", "30")),
            "imgsz": int(os.getenv("MODEL_TRAIN_IMGSZ", "640")), "batch": int(os.getenv("MODEL_TRAIN_BATCH", "8")),
            "seed": 0, "patience": int(os.getenv("MODEL_TRAIN_PATIENCE", "10")), "workers": int(os.getenv("MODEL_TRAIN_WORKERS", "2")),
            "train_fraction": 0.70, "val_fraction": 0.15, "test_fraction": 0.15,
            "base_dataset_slug": f"{KAGGLE_USERNAME}/{KAGGLE_DATASET_SLUG_PREFIX}",
            "comparison_active_model_version": active["version"],
        }
        _write_training_record(run_id, dataset_version, starting_weights, KAGGLE_STARTING_MODEL_VERSION, parameters)
        record_created = True
        slug_suffix = re.sub(r"[^a-z0-9-]", "-", run_id.casefold()).strip("-")
        dataset_slug = _kaggle_resource_slug(KAGGLE_USERNAME, KAGGLE_DATASET_SLUG_PREFIX, slug_suffix)
        kernel_owner, kernel_base = KAGGLE_KERNEL_SLUG.split("/", 1)
        kernel_slug = _kaggle_resource_slug(kernel_owner, kernel_base, slug_suffix)
        staging_root = BACKEND_DIR / "remote_training_jobs"
        staging_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="fridge9000-kaggle-", dir=staging_root) as temporary:
            root = Path(temporary)
            package = root / "dataset_stage"
            package.mkdir()
            _zip_dataset(dataset_dir, package / "dataset.zip")
            shutil.copy2(active["resolved_path"], package / "active_model.pt")
            shutil.copy2(starting_weights, package / "starting_model.pt")
            job = {
                "training_run_id": run_id, "dataset_version": dataset_version,
                "base_dataset_slug": f"{KAGGLE_USERNAME}/{KAGGLE_DATASET_SLUG_PREFIX}",
                "active_model_version": active["version"], "candidate_model_version": candidate_version,
                "starting_model_version": KAGGLE_STARTING_MODEL_VERSION,
                **{key: parameters[key] for key in ("epochs", "imgsz", "batch", "seed", "patience", "workers", "train_fraction", "val_fraction", "test_fraction")},
                "require_cuda": True,
            }
            (package / "job.json").write_text(json.dumps(job, indent=2) + "\n", encoding="utf-8")
            # Kaggle 2.x requires the title to slugify back to the exact resource id.
            # Using the already-valid slug component avoids a SaveKernel conflict.
            dataset_title = dataset_slug.split("/", 1)[1]
            (package / "dataset-metadata.json").write_text(json.dumps({"id": dataset_slug, "title": dataset_title, "isPrivate": True, "licenses": [{"name": "other"}]}, indent=2), encoding="utf-8")
            progress(phase="uploading", training_run_id=run_id, dataset_version=dataset_version, remote_dataset=dataset_slug)
            _remote_phase(run_id, "uploading", remote_dataset=dataset_slug, remote_kernel=kernel_slug)
            # Resource creation is intentionally single-shot: an ambiguous retry
            # must not create or submit duplicate remote work.
            runner.run(["datasets", "create", "-p", str(package), "--dir-mode", "zip"], retry=False)
            progress(phase="waiting_for_dataset")
            _remote_phase(run_id, "waiting_for_dataset", remote_dataset=dataset_slug, remote_kernel=kernel_slug)
            _wait_for_remote_dataset_files(
                runner,
                dataset_slug,
                ("active_model.pt", "starting_model.pt", "job.json", "dataset/manifest.json"),
                timeout_seconds=float(os.getenv("KAGGLE_DATASET_READY_TIMEOUT_SECONDS", "180")),
                settle_seconds=float(os.getenv("KAGGLE_DATASET_SETTLE_SECONDS", "20")),
            )
            kernel = root / "kernel_stage"
            kernel.mkdir()
            shutil.copy2(trainer_script, kernel / "train.py")
            metadata = _kernel_metadata(
                _json(kernel_metadata), kernel_slug, dataset_slug
            )
            (kernel / "kernel-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
            progress(phase="queued", remote_kernel=kernel_slug)
            _remote_phase(run_id, "queued", remote_dataset=dataset_slug, remote_kernel=kernel_slug)
            # Never retry submission: an ambiguous timeout must not launch a duplicate run.
            runner.run(_kernel_push_command(kernel), retry=False)
            output = root / "outputs"
            output.mkdir()
            deadline = time.monotonic() + KAGGLE_TIMEOUT_SECONDS
            while True:
                if time.monotonic() >= deadline:
                    raise ProviderError("Timed out waiting for Kaggle kernel completion")
                state = parse_kernel_status(runner.run(["kernels", "status", kernel_slug], retry=True))
                progress(phase=state, remote_kernel=kernel_slug)
                _remote_phase(run_id, state, remote_dataset=dataset_slug, remote_kernel=kernel_slug)
                if state == "completed":
                    break
                if state == "failed":
                    progress(phase="downloading")
                    _remote_phase(run_id, "downloading", remote_dataset=dataset_slug, remote_kernel=kernel_slug)
                    try:
                        runner.run(["kernels", "output", kernel_slug, "-p", str(output), "--force"], retry=True)
                        failure = _json(_unique_file(output, "failure.json"))
                        stage = failure.get("stage", "unknown stage")
                        message = failure.get("message", "No failure details were returned")
                        raise ProviderError(f"Kaggle training failed during {stage}: {message}")
                    except ProviderError as exc:
                        if str(exc).startswith("Kaggle training failed during"):
                            raise
                        raise ProviderError(f"Kaggle kernel failed and its failure report could not be downloaded: {exc}") from exc
                time.sleep(KAGGLE_POLL_INTERVAL_SECONDS)
            progress(phase="downloading")
            _remote_phase(run_id, "downloading", remote_dataset=dataset_slug, remote_kernel=kernel_slug)
            runner.run(["kernels", "output", kernel_slug, "-p", str(output), "--force"], retry=True)
            progress(phase="registering")
            _remote_phase(run_id, "registering", remote_dataset=dataset_slug, remote_kernel=kernel_slug)
            return _register_remote(run_id, dataset_version, dataset_dir, active, candidate_version, output)
    except BaseException as exc:
        if record_created:
            _fail_training_record(run_id, exc)
        raise
    finally:
        _release_remote_training_lock(remote_lock)


def training_provider(name: str):
    normalized = name.strip().lower()
    if normalized == "local":
        return local_training
    if normalized == "kaggle":
        return kaggle_training
    raise ProviderError("TRAINING_PROVIDER must be 'local' or 'kaggle'")
