"""Train and validate an isolated YOLO object-detection candidate model."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
import psycopg2
from psycopg2.extras import Json, RealDictCursor
from ultralytics import YOLO

try:
    from class_aware_metrics import normalized_class_names, require_class_preservation
except ModuleNotFoundError:
    from backend.class_aware_metrics import normalized_class_names, require_class_preservation


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, data: dict[str, Any]):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def finite_metric(value: Any) -> float | None:
    number = float(value)
    return number if math.isfinite(number) else None


def active_model_version(database_url: str, starting_weights: Path) -> str | None:
    with psycopg2.connect(database_url) as connection:
        with connection.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT version, model_path FROM model_versions WHERE status = 'active' LIMIT 1;")
            active = cur.fetchone()
    if not active:
        return None
    recorded_path = Path(active["model_path"])
    if not recorded_path.is_absolute():
        recorded_path = Path(__file__).resolve().parent / recorded_path
    return active["version"] if recorded_path.resolve() == starting_weights.resolve() else None


def create_training_run(database_url: str, run_id: str, summary: dict[str, Any], starting_model_version: str | None):
    with psycopg2.connect(database_url) as connection:
        with connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO training_runs(
                    id, dataset_version, starting_weights_path, starting_model_version,
                    starting_weights_sha256, training_parameters, started_at, status
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, 'running');
                """,
                (
                    run_id, summary["dataset_version"], summary["starting_weights"], starting_model_version,
                    summary["starting_weights_sha256"], Json(summary["training_parameters"]), summary["training_started_at"],
                ),
            )


def complete_training_run(database_url: str, run_id: str, model_version: str, summary: dict[str, Any]):
    metrics = summary["validation_metrics"]
    submission_ids = summary.get("included_submission_ids") or []
    if not submission_ids or any(not isinstance(value, int) or isinstance(value, bool) for value in submission_ids):
        raise RuntimeError("Training dataset does not contain valid included submission IDs")
    submission_ids = sorted(set(submission_ids))
    experimental_ids = summary.get("experimental_submission_ids")
    if experimental_ids is not None and any(not isinstance(value, int) or isinstance(value, bool) for value in experimental_ids):
        raise RuntimeError("Training dataset does not contain valid experimental submission IDs")
    experimental_ids = None if experimental_ids is None else sorted(set(experimental_ids))
    if experimental_ids is not None and not set(experimental_ids).issubset(submission_ids):
        raise RuntimeError("Experimental submissions are not a subset of the training dataset")
    with psycopg2.connect(database_url) as connection:
        with connection.cursor() as cur:
            cur.execute(
                "SELECT id, status, training_state FROM annotation_submissions WHERE id = ANY(%s) FOR UPDATE;",
                (submission_ids,),
            )
            submissions = cur.fetchall()
            if {row[0] for row in submissions} != set(submission_ids):
                raise RuntimeError("Training dataset references an unknown annotation submission")
            invalid = [row[0] for row in submissions if row[1] not in ("approved", "used")]
            if invalid:
                raise RuntimeError(f"Training dataset contains non-approved submissions: {invalid}")
            states = {row[0]: row[2] for row in submissions}
            if experimental_ids is None:
                experimental_ids = sorted(value for value in submission_ids if states[value] == "eligible")
            invalid_trusted = [value for value in submission_ids if value not in experimental_ids and states[value] != "trusted"]
            invalid_experimental = [value for value in experimental_ids if states[value] != "eligible"]
            if invalid_trusted or invalid_experimental:
                raise RuntimeError(
                    "Training submission lifecycle changed while training was running: "
                    f"baseline={invalid_trusted}, experimental={invalid_experimental}"
                )
            cur.execute(
                """
                UPDATE training_runs SET
                    ended_at = %s, status = 'completed', candidate_model_path = %s,
                    precision = %s, recall = %s, map50 = %s, map50_95 = %s, error = NULL
                WHERE id = %s AND status = 'running';
                """,
                (
                    summary["training_completed_at"], summary["candidate_model_path"], metrics["precision"],
                    metrics["recall"], metrics["map50"], metrics["map50_95"], run_id,
                ),
            )
            if cur.rowcount != 1:
                raise RuntimeError("Training-run record is missing or no longer running")
            cur.execute(
                """
                INSERT INTO model_versions(
                    version, model_path, model_sha256, status, dataset_version, training_run_id,
                    precision, recall, map50, map50_95
                ) VALUES (%s, %s, %s, 'candidate', %s, %s, %s, %s, %s, %s)
                RETURNING id;
                """,
                (
                    model_version, summary["candidate_model_path"], summary["candidate_model_sha256"],
                    summary["dataset_version"], run_id, metrics["precision"], metrics["recall"],
                    metrics["map50"], metrics["map50_95"],
                ),
            )
            model_version_id = cur.fetchone()[0]
            cur.execute(
                """
                INSERT INTO training_run_submission_usage(
                    training_run_id, submission_id, dataset_version, model_version_id, is_experimental
                )
                SELECT %s, id, %s, %s, id = ANY(%s)
                FROM annotation_submissions
                WHERE id = ANY(%s);
                """,
                (run_id, summary["dataset_version"], model_version_id, experimental_ids, submission_ids),
            )
            cur.execute(
                """
                INSERT INTO training_run_annotation_usage(
                    training_run_id, annotation_id, submission_id, dataset_version, model_version_id, is_experimental
                )
                SELECT %s, a.id, a.submission_id, %s, %s, a.submission_id = ANY(%s)
                FROM annotations a
                WHERE a.submission_id = ANY(%s);
                """,
                (run_id, summary["dataset_version"], model_version_id, experimental_ids, submission_ids),
            )
            used_annotation_count = cur.rowcount
            cur.execute(
                """
                UPDATE annotation_submissions
                SET training_state = 'experimental'
                WHERE id = ANY(%s) AND training_state = 'eligible';
                """,
                (experimental_ids,),
            )
            summary["used_submission_ids"] = submission_ids
            summary["used_annotation_count"] = used_annotation_count


def fail_training_run(database_url: str, run_id: str, summary: dict[str, Any]):
    with psycopg2.connect(database_url) as connection:
        with connection.cursor() as cur:
            cur.execute(
                """
                UPDATE training_runs SET ended_at = %s, status = %s, candidate_model_path = NULL,
                    precision = NULL, recall = NULL, map50 = NULL, map50_95 = NULL, error = %s
                WHERE id = %s AND status = 'running';
                """,
                (summary["training_completed_at"], summary["status"], Json(summary["error"]), run_id),
            )


def validate_split(dataset_dir: Path, split: str, expected: dict[str, int], class_count: int):
    images_dir = dataset_dir / "images" / split
    labels_dir = dataset_dir / "labels" / split
    if not images_dir.is_dir() or not labels_dir.is_dir():
        raise ValueError(f"Missing images/{split} or labels/{split} directory")
    images = sorted(path for path in images_dir.rglob("*") if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES)
    labels = sorted(path for path in labels_dir.rglob("*.txt") if path.is_file())
    image_stems = {path.relative_to(images_dir).with_suffix("") for path in images}
    label_stems = {path.relative_to(labels_dir).with_suffix("") for path in labels}
    if image_stems != label_stems:
        raise ValueError(f"Image/label pairing mismatch in {split} split")
    annotation_count = sum(len([line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]) for path in labels)
    if len(images) != int(expected["images"]) or annotation_count != int(expected["annotations"]):
        raise ValueError(f"Manifest counts do not match the {split} files")
    for label_path in labels:
        for line_number, line in enumerate(label_path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            fields = line.split()
            if len(fields) != 5:
                raise ValueError(f"Invalid YOLO row in {label_path.name}:{line_number}")
            class_id = int(fields[0])
            coordinates = [float(value) for value in fields[1:]]
            if class_id < 0 or class_id >= class_count or not all(0 <= value <= 1 for value in coordinates) or coordinates[2] <= 0 or coordinates[3] <= 0:
                raise ValueError(f"Invalid YOLO values in {label_path.name}:{line_number}")
    return images, labels


def validate_dataset(dataset_dir: Path, requested_version: str):
    if not re.fullmatch(r"[A-Za-z0-9._-]+", requested_version):
        raise ValueError("dataset_version contains unsupported characters")
    manifest_path = dataset_dir / "manifest.json"
    data_yaml = dataset_dir / "data.yaml"
    if not manifest_path.is_file() or not data_yaml.is_file():
        raise ValueError("Dataset must contain manifest.json and data.yaml")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("dataset_version") != requested_version or manifest.get("dataset_id") != requested_version:
        raise ValueError("Requested dataset version does not match manifest.json")
    if manifest.get("source_submission_status") != "approved":
        raise ValueError("Training datasets must contain approved submissions only")

    config = yaml.safe_load(data_yaml.read_text(encoding="utf-8")) or {}
    training_classes = normalized_class_names(config.get("names"), "training dataset")
    class_count = int(config.get("nc", 0))
    mapping = manifest.get("class_mapping")
    expected_mapping = [
        (index, name) for index, name in enumerate(training_classes)
    ]
    actual_mapping = [
        (item.get("id"), item.get("name"))
        for item in mapping
        if isinstance(item, dict)
    ] if isinstance(mapping, list) else []
    if class_count != len(training_classes) or actual_mapping != expected_mapping:
        raise ValueError("data.yaml and manifest class mappings are inconsistent or empty")
    yaml_root = (data_yaml.parent / str(config.get("path", "."))).resolve()
    train_path = (yaml_root / str(config.get("train", ""))).resolve()
    val_path = (yaml_root / str(config.get("val", ""))).resolve()
    if train_path != (dataset_dir / "images" / "train").resolve() or val_path != (dataset_dir / "images" / "val").resolve():
        raise ValueError("data.yaml does not reference the exported train/validation directories")
    split_counts = manifest.get("split_counts") or {}
    train_images, _ = validate_split(dataset_dir, "train", split_counts.get("train") or {}, class_count)
    val_images, _ = validate_split(dataset_dir, "val", split_counts.get("val") or {}, class_count)
    if not train_images:
        raise ValueError("Training split contains no images")
    if not val_images:
        raise ValueError("Validation split contains no images; export at least two distinct source images")
    train_sources = {
        sample.get("source_image_sha256", sample.get("scan_id"))
        for sample in manifest.get("samples", [])
        if sample.get("split") == "train"
    }
    val_sources = {
        sample.get("source_image_sha256", sample.get("scan_id"))
        for sample in manifest.get("samples", [])
        if sample.get("split") == "val"
    }
    if None in train_sources | val_sources or train_sources & val_sources:
        raise ValueError("A source image appears in both train and validation")
    return manifest, data_yaml


def train_candidate(args):
    if not re.fullmatch(r"[A-Za-z0-9._-]+", args.dataset_version):
        raise ValueError("dataset_version contains unsupported characters")
    dataset_dir = args.dataset_dir.resolve()
    active_model = args.starting_weights.resolve()
    output_root = args.output_root.resolve()
    run_timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    run_id = f"train-{run_timestamp}-{uuid.uuid4().hex[:8]}"
    run_dir = output_root / args.dataset_version / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    summary_path = run_dir / "training_summary.json"
    active_hash_before = file_sha256(active_model) if active_model.is_file() else None
    parameters = {
        "epochs": args.epochs,
        "imgsz": args.imgsz,
        "batch": args.batch,
        "device": args.device,
        "workers": args.workers,
        "patience": args.patience,
        "seed": args.seed,
        "deterministic": True,
    }
    summary = {
        "status": "running",
        "training_run_id": run_id,
        "model_version": None,
        "dataset_version": args.dataset_version,
        "training_started_at": utc_now(),
        "training_completed_at": None,
        "starting_weights": str(active_model),
        "starting_weights_sha256": active_hash_before,
        "training_parameters": parameters,
        "candidate_model_path": None,
        "candidate_model_sha256": None,
        "validation_metrics": None,
        "active_model_path": str(active_model),
        "active_model_sha256_before": active_hash_before,
        "active_model_sha256_after": None,
        "error": None,
    }
    write_json(summary_path, summary)
    candidate_path = None
    run_registered = False

    try:
        starting_model_version = active_model_version(args.database_url, active_model)
        summary["starting_model_version"] = starting_model_version
        create_training_run(args.database_url, run_id, summary, starting_model_version)
        run_registered = True
        if not active_model.is_file():
            raise FileNotFoundError(f"Starting weights not found: {active_model}")
        manifest, data_yaml = validate_dataset(dataset_dir, args.dataset_version)
        summary["dataset_content_sha256"] = manifest.get("content_sha256")
        summary["included_submission_ids"] = manifest.get("included_submission_ids", [])
        summary["experimental_submission_ids"] = manifest.get("experimental_submission_ids")
        model = YOLO(str(active_model))
        if model.task != "detect":
            raise ValueError(f"Starting weights must be an object-detection model, got task={model.task!r}")
        active_classes = normalized_class_names(model.names, "active model")
        training_config = yaml.safe_load(data_yaml.read_text(encoding="utf-8")) or {}
        training_classes = normalized_class_names(
            training_config.get("names"), "combined training dataset"
        )
        require_class_preservation(
            active_classes, training_classes, "Combined training dataset"
        )
        summary["active_classes"] = active_classes
        summary["training_classes"] = training_classes

        model.train(
            data=str(data_yaml),
            epochs=args.epochs,
            imgsz=args.imgsz,
            batch=args.batch,
            device=args.device,
            workers=args.workers,
            patience=args.patience,
            seed=args.seed,
            deterministic=True,
            project=str(run_dir / "ultralytics"),
            name="train",
            exist_ok=False,
            verbose=args.verbose,
        )
        trained_best = Path(model.trainer.best).resolve()
        if not trained_best.is_file():
            raise RuntimeError("Ultralytics did not produce a best checkpoint")
        candidate_path = (run_dir / "candidate.pt").resolve()
        if candidate_path == active_model:
            raise RuntimeError("Candidate path resolved to the active model path")
        shutil.copy2(trained_best, candidate_path)

        candidate = YOLO(str(candidate_path))
        if candidate.task != "detect":
            raise RuntimeError("Trained candidate is not an object-detection model")
        candidate_classes = normalized_class_names(candidate.names, "candidate model")
        require_class_preservation(
            active_classes, candidate_classes, "Trained candidate"
        )
        summary["candidate_classes"] = candidate_classes
        metrics = candidate.val(
            data=str(data_yaml),
            split="val",
            imgsz=args.imgsz,
            batch=args.batch,
            device=args.device,
            workers=args.workers,
            project=str(run_dir / "ultralytics"),
            name="validation",
            exist_ok=False,
            verbose=args.verbose,
        )
        summary["validation_metrics"] = {
            "precision": finite_metric(metrics.box.mp),
            "recall": finite_metric(metrics.box.mr),
            "map50": finite_metric(metrics.box.map50),
            "map50_95": finite_metric(metrics.box.map),
        }
        summary["candidate_model_path"] = str(candidate_path)
        summary["candidate_model_sha256"] = file_sha256(candidate_path)
        active_hash_after = file_sha256(active_model)
        if active_hash_before != active_hash_after:
            raise RuntimeError("Active starting weights changed during candidate training")
        summary["active_model_sha256_after"] = active_hash_after
        summary["training_completed_at"] = utc_now()
        model_version = f"fridge9000-detector-{run_id}"
        summary["model_version"] = model_version
        try:
            complete_training_run(args.database_url, run_id, model_version, summary)
        except psycopg2.errors.UniqueViolation as exc:
            if exc.diag.constraint_name != "idx_model_versions_single_candidate":
                raise
            raise RuntimeError(
                "Another unresolved candidate already exists; promote or reject it before registering a new candidate"
            ) from exc
        summary["status"] = "completed"
        return summary, summary_path
    except BaseException as exc:
        summary["status"] = "interrupted" if isinstance(exc, KeyboardInterrupt) else "failed"
        summary["error"] = {"type": type(exc).__name__, "message": str(exc)}
        if candidate_path is not None and candidate_path.is_file():
            candidate_path.unlink()
        summary["candidate_model_path"] = None
        summary["candidate_model_sha256"] = None
        summary["training_completed_at"] = utc_now()
        if run_registered:
            try:
                fail_training_run(args.database_url, run_id, summary)
            except Exception as registration_error:
                summary["tracking_error"] = {"type": type(registration_error).__name__, "message": str(registration_error)}
        raise
    finally:
        summary["training_completed_at"] = utc_now()
        summary["active_model_sha256_after"] = file_sha256(active_model) if active_model.is_file() else None
        if active_hash_before != summary["active_model_sha256_after"]:
            summary["status"] = "failed"
            summary["error"] = {"type": "ActiveModelChanged", "message": "Active starting weights changed during candidate training"}
        write_json(summary_path, summary)


def parse_args():
    backend_root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-dir", required=True, type=Path)
    parser.add_argument("--dataset-version", required=True)
    parser.add_argument("--starting-weights", type=Path, default=backend_root / "best.pt")
    parser.add_argument("--output-root", type=Path, default=backend_root / "candidate_models")
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL", "postgresql://fridge:fridgepass@localhost:5432/fridge9000"))
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--patience", type=int, default=10)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    if args.epochs <= 0 or args.imgsz <= 0 or args.batch == 0 or args.workers < 0 or args.patience < 0:
        parser.error("epochs/imgsz must be positive; batch cannot be zero; workers/patience cannot be negative")
    return args


def main():
    args = parse_args()
    try:
        summary, summary_path = train_candidate(args)
    except BaseException:
        raise
    print(json.dumps(summary, indent=2, ensure_ascii=False, allow_nan=False))
    print(f"Training summary: {summary_path}")


if __name__ == "__main__":
    main()
