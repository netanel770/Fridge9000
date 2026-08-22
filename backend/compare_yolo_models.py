"""Evaluate the active and a candidate detector on one identical validation split."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import Json, RealDictCursor
from ultralytics import YOLO

from train_yolo_candidate import file_sha256, finite_metric, validate_dataset, write_json


RULE = "candidate map50_95 > active map50_95; if equal, candidate map50 > active map50"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def resolve_model_path(raw_path: str) -> Path:
    path = Path(raw_path)
    return path.resolve() if path.is_absolute() else (Path(__file__).resolve().parent / path).resolve()


def validation_split_sha256(dataset_dir: Path, data_yaml: Path) -> str:
    """Fingerprint the exact config, validation images, and labels used by both evaluations."""
    digest = hashlib.sha256()
    paths = [data_yaml]
    for folder in (dataset_dir / "images" / "val", dataset_dir / "labels" / "val"):
        paths.extend(sorted(path for path in folder.rglob("*") if path.is_file()))
    for path in paths:
        relative = path.relative_to(dataset_dir).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def load_models(database_url: str, candidate_version: str):
    with psycopg2.connect(database_url) as connection:
        with connection.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM model_versions WHERE status = 'active' LIMIT 1;")
            active = cur.fetchone()
            cur.execute("SELECT * FROM model_versions WHERE version = %s AND status = 'candidate';", (candidate_version,))
            candidate = cur.fetchone()
    if not active:
        raise ValueError("No active model is registered")
    if not candidate:
        raise ValueError(f"Candidate model not found: {candidate_version}")
    if active["id"] == candidate["id"]:
        raise ValueError("Active and candidate models must be different")
    return active, candidate


def evaluate(model_path: Path, data_yaml: Path, args, output_dir: Path, name: str) -> dict[str, float | None]:
    if not model_path.is_file():
        raise FileNotFoundError(f"Model weights not found: {model_path}")
    model = YOLO(str(model_path))
    if model.task != "detect":
        raise ValueError(f"Model {model_path} is not an object detector")
    result = model.val(
        data=str(data_yaml), split="val", imgsz=args.imgsz, batch=args.batch,
        device=args.device, workers=args.workers, seed=args.seed, deterministic=True,
        project=str(output_dir / "ultralytics"), name=name, exist_ok=False, verbose=args.verbose,
    )
    return {
        "precision": finite_metric(result.box.mp),
        "recall": finite_metric(result.box.mr),
        "map50": finite_metric(result.box.map50),
        "map50_95": finite_metric(result.box.map),
    }


def differences(candidate: dict[str, float | None], active: dict[str, float | None]):
    if any(value is None for value in (*candidate.values(), *active.values())):
        raise RuntimeError("Comparison metrics must all be finite")
    return {key: candidate[key] - active[key] for key in active}


def candidate_is_better(delta: dict[str, float], tolerance: float = 1e-12) -> bool:
    if delta["map50_95"] > tolerance:
        return True
    return abs(delta["map50_95"]) <= tolerance and delta["map50"] > tolerance


def persist(database_url: str, summary: dict[str, Any], active_id: int, candidate_id: int):
    with psycopg2.connect(database_url) as connection:
        with connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO model_comparisons(
                    id, dataset_version, dataset_content_sha256, validation_split_sha256,
                    active_model_id, candidate_model_id,
                    created_at, evaluation_parameters, active_metrics, candidate_metrics,
                    metric_differences, comparison_rule, candidate_outperforms_active, summary_path
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s);
                """,
                (
                    summary["comparison_id"], summary["dataset_version"], summary["dataset_content_sha256"],
                    summary["validation_split_sha256"], active_id, candidate_id, summary["created_at"],
                    Json(summary["evaluation_parameters"]),
                    Json(summary["active"]["metrics"]), Json(summary["candidate"]["metrics"]),
                    Json(summary["metric_differences"]), RULE, summary["candidate_outperforms_active"],
                    summary["summary_path"],
                ),
            )


def compare(args):
    dataset_dir = args.dataset_dir.resolve()
    manifest, data_yaml = validate_dataset(dataset_dir, args.dataset_version)
    active, candidate = load_models(args.database_url, args.candidate_version)
    if candidate["dataset_version"] != args.dataset_version:
        raise ValueError("Candidate was not trained from the selected dataset version")
    active_path = resolve_model_path(active["model_path"])
    candidate_path = resolve_model_path(candidate["model_path"])
    active_hash_before = file_sha256(active_path)
    validation_hash_before = validation_split_sha256(dataset_dir, data_yaml)
    comparison_id = f"compare-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')}-{uuid.uuid4().hex[:8]}"
    output_dir = args.output_root.resolve() / args.dataset_version / comparison_id
    output_dir.mkdir(parents=True, exist_ok=False)
    parameters = {"split": "val", "imgsz": args.imgsz, "batch": args.batch, "device": args.device, "workers": args.workers, "seed": args.seed, "deterministic": True}
    active_metrics = evaluate(active_path, data_yaml, args, output_dir, "active")
    candidate_metrics = evaluate(candidate_path, data_yaml, args, output_dir, "candidate")
    if validation_split_sha256(dataset_dir, data_yaml) != validation_hash_before:
        raise RuntimeError("Validation data changed during comparison")
    if file_sha256(active_path) != active_hash_before:
        raise RuntimeError("Active model changed during comparison")
    delta = differences(candidate_metrics, active_metrics)
    summary_path = output_dir / "comparison_summary.json"
    summary = {
        "comparison_id": comparison_id, "created_at": utc_now(),
        "dataset_version": args.dataset_version, "dataset_content_sha256": manifest.get("content_sha256"),
        "validation_data": str(data_yaml), "validation_split_sha256": validation_hash_before,
        "evaluation_parameters": parameters,
        "active": {"id": active["id"], "version": active["version"], "path": str(active_path), "sha256": active_hash_before, "metrics": active_metrics},
        "candidate": {"id": candidate["id"], "version": candidate["version"], "path": str(candidate_path), "sha256": file_sha256(candidate_path), "metrics": candidate_metrics},
        "metric_differences": delta, "comparison_rule": RULE,
        "candidate_outperforms_active": candidate_is_better(delta), "summary_path": str(summary_path),
    }
    write_json(summary_path, summary)
    persist(args.database_url, summary, active["id"], candidate["id"])
    return summary


def parse_args():
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-dir", required=True, type=Path)
    parser.add_argument("--dataset-version", required=True)
    parser.add_argument("--candidate-version", required=True)
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL", "postgresql://fridge:fridgepass@localhost:5432/fridge9000"))
    parser.add_argument("--output-root", type=Path, default=root / "model_comparisons")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    if args.imgsz <= 0 or args.batch == 0 or args.workers < 0:
        parser.error("imgsz must be positive; batch cannot be zero; workers cannot be negative")
    return args


if __name__ == "__main__":
    print(json.dumps(compare(parse_args()), indent=2, ensure_ascii=False, allow_nan=False))
