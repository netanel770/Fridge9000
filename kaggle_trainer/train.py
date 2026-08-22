"""Self-contained Kaggle GPU worker for Fridge9000 YOLO detection training."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import zipfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

REQUIRED_INPUTS = ("active_model.pt", "starting_model.pt", "job.json")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
METRIC_KEYS = ("precision", "recall", "map50", "map50_95")
COMPARISON_RULE = "candidate map50_95 > active map50_95; tie-breaker: candidate map50 > active map50"
ULTRALYTICS_VERSION = "8.4.120"
TORCH_VERSION = "2.7.1"
TORCHVISION_VERSION = "0.22.1"
PYTORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu118"


class WorkerError(RuntimeError):
    """Expected, actionable worker failure."""


def _installed_version(package: str) -> str | None:
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return None


def _pip_install(arguments: list[str], description: str) -> None:
    print(f"Installing {description}...")
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-cache-dir", *arguments],
        check=False,
    )
    if result.returncode != 0:
        raise WorkerError(f"Could not install {description}; pip exited with {result.returncode}")


def ensure_training_dependencies() -> None:
    """Install a deterministic CUDA stack that supports Kaggle's older GPU pool."""
    torch_version = _installed_version("torch") or ""
    torchvision_version = _installed_version("torchvision") or ""
    if not torch_version.startswith(TORCH_VERSION) or not torchvision_version.startswith(TORCHVISION_VERSION) or "cu118" not in torch_version:
        _pip_install(
            ["--index-url", PYTORCH_CUDA_INDEX, f"torch=={TORCH_VERSION}", f"torchvision=={TORCHVISION_VERSION}"],
            f"PyTorch {TORCH_VERSION} / TorchVision {TORCHVISION_VERSION} CUDA 11.8",
        )
    if _installed_version("ultralytics") != ULTRALYTICS_VERSION:
        _pip_install([f"ultralytics=={ULTRALYTICS_VERSION}"], f"Ultralytics {ULTRALYTICS_VERSION}")
    importlib.invalidate_caches()
    if importlib.util.find_spec("ultralytics") is None:
        raise WorkerError(f"Kaggle dependency installation completed but ultralytics=={ULTRALYTICS_VERSION} is still unavailable")


@dataclass(frozen=True)
class Job:
    training_run_id: str
    dataset_version: str
    base_dataset_slug: str
    active_model_version: str
    candidate_model_version: str
    starting_model_version: str
    epochs: int = 30
    imgsz: int = 640
    batch: int = 8
    seed: int = 0
    patience: int = 10
    workers: int = 2
    train_fraction: float = 0.70
    val_fraction: float = 0.15
    test_fraction: float = 0.15
    require_cuda: bool = True

    @classmethod
    def load(cls, path: Path) -> "Job":
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise WorkerError(f"Invalid job.json: {exc}") from exc
        if not isinstance(raw, dict):
            raise WorkerError("job.json must contain a JSON object")
        allowed = set(cls.__dataclass_fields__)
        unknown = sorted(set(raw) - allowed)
        if unknown:
            raise WorkerError(f"job.json contains unsupported fields: {', '.join(unknown)}")
        try:
            job = cls(**raw)
        except TypeError as exc:
            raise WorkerError(f"job.json fields are missing or invalid: {exc}") from exc
        for field in ("training_run_id", "dataset_version", "active_model_version", "candidate_model_version", "starting_model_version"):
            value = getattr(job, field)
            if not isinstance(value, str) or not value.strip() or any(char in value for char in "\\/\0"):
                raise WorkerError(f"{field} must be a non-empty path-safe string")
        if not isinstance(job.base_dataset_slug, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", job.base_dataset_slug):
            raise WorkerError("base_dataset_slug must use owner/dataset-slug format")
        for field in ("epochs", "imgsz", "batch"):
            value = getattr(job, field)
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                raise WorkerError(f"{field} must be a positive integer")
        for field in ("seed", "patience", "workers"):
            value = getattr(job, field)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise WorkerError(f"{field} must be a non-negative integer")
        if not isinstance(job.require_cuda, bool):
            raise WorkerError("require_cuda must be a boolean")
        fractions = (job.train_fraction, job.val_fraction, job.test_fraction)
        if not all(isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value < 1 for value in fractions) or not math.isclose(sum(fractions), 1.0, abs_tol=1e-9):
            raise WorkerError("train_fraction, val_fraction, and test_fraction must be positive and sum to 1")
        return job


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def split_sha256(split: dict[str, Any], dataset_root: Path) -> str:
    digest = hashlib.sha256()
    paths: list[Path] = []
    for key in ("images_dir", "labels_dir"):
        paths.extend(sorted(path for path in Path(split[key]).rglob("*") if path.is_file()))
    for path in paths:
        relative = path.relative_to(dataset_root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def directory_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(path for path in root.rglob("*") if path.is_file()):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def discover_inputs(root: Path) -> dict[str, Path]:
    if not root.is_dir():
        raise WorkerError(f"Kaggle input root does not exist: {root}")
    selected: dict[str, Path] = {}
    for name in REQUIRED_INPUTS:
        matches = sorted(path.resolve() for path in root.rglob(name) if path.is_file())
        if not matches:
            raise WorkerError(f"Missing required input {name} under {root}")
        if len(matches) > 1:
            raise WorkerError(f"Ambiguous {name}; found: {', '.join(map(str, matches))}")
        selected[name] = matches[0]
        print(f"Selected {name}: {matches[0]}")
    return selected


def discover_correction_dataset(root: Path, job: Job) -> tuple[str, Path]:
    """Accept both local ZIP packages and Kaggle's automatically expanded ZIPs."""
    archives = sorted(path.resolve() for path in root.rglob("dataset.zip") if path.is_file())
    if len(archives) > 1:
        raise WorkerError(f"Ambiguous dataset.zip; found: {', '.join(map(str, archives))}")
    if archives:
        return "zip", archives[0]

    matches: list[Path] = []
    for manifest_path in sorted(root.rglob("manifest.json")):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        candidate = manifest_path.parent.resolve()
        if (
            isinstance(manifest, dict)
            and manifest.get("dataset_version") == job.dataset_version
            and manifest.get("source_submission_status") == "approved"
            and (candidate / "data.yaml").is_file()
        ):
            matches.append(candidate)
    if not matches:
        raise WorkerError(f"Missing correction dataset for {job.dataset_version} under {root}")
    if len(matches) > 1:
        raise WorkerError(f"Ambiguous correction dataset; found: {', '.join(map(str, matches))}")
    return "directory", matches[0]


def safe_extract_zip(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    try:
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                pure = PurePosixPath(member.filename)
                if pure.is_absolute() or ".." in pure.parts or not pure.parts:
                    raise WorkerError(f"Unsafe ZIP member: {member.filename!r}")
                unix_mode = member.external_attr >> 16
                if unix_mode & 0o170000 == 0o120000:
                    raise WorkerError(f"ZIP symlinks are not allowed: {member.filename!r}")
                target = (root / Path(*pure.parts)).resolve()
                if root not in target.parents and target != root:
                    raise WorkerError(f"ZIP member escapes extraction root: {member.filename!r}")
            bundle.extractall(root)
    except zipfile.BadZipFile as exc:
        raise WorkerError(f"dataset.zip is corrupt: {exc}") from exc


def find_dataset_root(extracted_root: Path) -> Path:
    matches = sorted(path.resolve() for path in extracted_root.rglob("data.yaml") if path.is_file())
    if len(matches) != 1:
        raise WorkerError(f"Expected exactly one data.yaml in dataset.zip, found {len(matches)}")
    return matches[0].parent


def _class_names(config: dict[str, Any]) -> list[str]:
    names = config.get("names")
    if isinstance(names, list) and all(isinstance(name, str) and name.strip() for name in names):
        result = names
    elif isinstance(names, dict):
        try:
            indexed = {int(key): value for key, value in names.items()}
        except (TypeError, ValueError) as exc:
            raise WorkerError("data.yaml class IDs must be integers") from exc
        if set(indexed) != set(range(len(indexed))) or not all(isinstance(value, str) and value.strip() for value in indexed.values()):
            raise WorkerError("data.yaml class mapping must use contiguous IDs with non-empty names")
        result = [indexed[index] for index in range(len(indexed))]
    else:
        raise WorkerError("data.yaml must contain class names")
    if not result or int(config.get("nc", len(result))) != len(result):
        raise WorkerError("data.yaml nc and names are inconsistent or empty")
    return result


def _resolve_split(dataset_root: Path, yaml_path: Path, config: dict[str, Any], split: str) -> Path | None:
    value = config.get(split)
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise WorkerError(f"data.yaml {split} must be a path string")
    configured_root = Path(str(config.get("path", ".")))
    base = configured_root if configured_root.is_absolute() else yaml_path.parent / configured_root
    path = Path(value)
    resolved = path.resolve() if path.is_absolute() else (base / path).resolve()
    dataset_resolved = dataset_root.resolve()
    if dataset_resolved not in resolved.parents and resolved != dataset_resolved:
        raise WorkerError(f"data.yaml {split} escapes the extracted dataset")
    return resolved


def _validate_split(dataset_root: Path, images_dir: Path, split: str, class_count: int) -> dict[str, Any]:
    if not images_dir.is_dir():
        raise WorkerError(f"Missing image directory for {split}: {images_dir}")
    relative = images_dir.relative_to(dataset_root)
    parts = list(relative.parts)
    if "images" not in parts:
        raise WorkerError(f"{split} image path must be inside an images directory")
    parts[parts.index("images")] = "labels"
    labels_dir = dataset_root.joinpath(*parts)
    if not labels_dir.is_dir():
        raise WorkerError(f"Missing matching label directory for {split}: {labels_dir}")
    images = sorted(path for path in images_dir.rglob("*") if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES)
    labels = sorted(path for path in labels_dir.rglob("*.txt") if path.is_file())
    image_keys = {path.relative_to(images_dir).with_suffix("") for path in images}
    label_keys = {path.relative_to(labels_dir).with_suffix("") for path in labels}
    if image_keys != label_keys:
        raise WorkerError(f"Image/label pairing mismatch in {split}")
    annotations = 0
    for label_path in labels:
        for line_number, raw_line in enumerate(label_path.read_text(encoding="utf-8").splitlines(), 1):
            if not raw_line.strip():
                continue
            fields = raw_line.split()
            if len(fields) != 5:
                raise WorkerError(f"Invalid YOLO detection row in {label_path}:{line_number}")
            try:
                class_id = int(fields[0])
                cx, cy, width, height = map(float, fields[1:])
            except ValueError as exc:
                raise WorkerError(f"Non-numeric YOLO row in {label_path}:{line_number}") from exc
            values = (cx, cy, width, height)
            if class_id not in range(class_count) or not all(math.isfinite(value) for value in values):
                raise WorkerError(f"Invalid class or non-finite YOLO value in {label_path}:{line_number}")
            if width <= 0 or height <= 0 or cx - width / 2 < -1e-7 or cy - height / 2 < -1e-7 or cx + width / 2 > 1 + 1e-7 or cy + height / 2 > 1 + 1e-7:
                raise WorkerError(f"YOLO box is invalid or outside [0,1] in {label_path}:{line_number}")
            annotations += 1
    return {"images": len(images), "annotations": annotations, "images_dir": str(images_dir), "labels_dir": str(labels_dir)}


def validate_dataset(dataset_root: Path, job: Job, require_evaluation: bool = True) -> dict[str, Any]:
    yaml_path = dataset_root / "data.yaml"
    manifest_path = dataset_root / "manifest.json"
    if not yaml_path.is_file() or not manifest_path.is_file():
        raise WorkerError("Dataset must contain data.yaml and manifest.json")
    try:
        config = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (yaml.YAMLError, json.JSONDecodeError, OSError) as exc:
        raise WorkerError(f"Invalid dataset metadata: {exc}") from exc
    if not isinstance(config, dict) or not isinstance(manifest, dict):
        raise WorkerError("Dataset metadata must contain objects/mappings")
    if manifest.get("dataset_version") != job.dataset_version:
        raise WorkerError("job dataset_version does not match manifest.json")
    if manifest.get("source_submission_status") != "approved":
        raise WorkerError("Only approved annotation submissions may be trained")
    names = _class_names(config)
    mapping = manifest.get("class_mapping")
    if not isinstance(mapping, list) or [(item.get("id"), item.get("name")) for item in mapping if isinstance(item, dict)] != list(enumerate(names)):
        raise WorkerError("manifest class_mapping does not match data.yaml")
    splits: dict[str, Any] = {}
    for split in ("train", "val", "test"):
        path = _resolve_split(dataset_root, yaml_path, config, split)
        if path is not None:
            splits[split] = _validate_split(dataset_root, path, split, len(names))
    if not splits.get("train", {}).get("images"):
        raise WorkerError("Training split contains no images")
    evaluation_split = "test" if splits.get("test", {}).get("images") else "val" if splits.get("val", {}).get("images") else None
    if require_evaluation and not evaluation_split:
        raise WorkerError("Dataset has neither a non-empty test split nor a non-empty validation split")
    return {
        "dataset_root": str(dataset_root.resolve()), "data_yaml": str(yaml_path.resolve()),
        "manifest": manifest, "classes": names, "splits": splits,
        "evaluation_split": evaluation_split,
        "evaluation_limitation": None if evaluation_split == "test" else "No independent test split exists; active and candidate are compared on the shared validation split." if evaluation_split else "Incremental corrections have no evaluation split; the combined base dataset supplies train/val/test.",
    }


def find_base_dataset(input_root: Path) -> Path:
    matches = []
    for classes_file in input_root.rglob("classes.txt"):
        parent = classes_file.parent
        if (parent / "images").is_dir() and (parent / "labels").is_dir():
            matches.append(parent.resolve())
    if len(matches) != 1:
        raise WorkerError(f"Expected exactly one Kaggle base dataset with classes.txt/images/labels, found {len(matches)}")
    print(f"Selected base dataset: {matches[0]}")
    return matches[0]


def _bounded_detection_box(
    box: tuple[float, float, float, float], path: Path, line_number: int, *, clip_to_image: bool,
) -> tuple[float, float, float, float]:
    cx, cy, width, height = box
    if not all(math.isfinite(value) for value in box) or width <= 0 or height <= 0:
        raise WorkerError(f"Invalid normalized box in {path}:{line_number}")
    x1, y1, x2, y2 = cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2
    if not clip_to_image:
        if x1 < -1e-7 or y1 < -1e-7 or x2 > 1 + 1e-7 or y2 > 1 + 1e-7:
            raise WorkerError(f"Invalid normalized box in {path}:{line_number}")
        return box
    clipped_x1, clipped_y1 = max(0.0, x1), max(0.0, y1)
    clipped_x2, clipped_y2 = min(1.0, x2), min(1.0, y2)
    if clipped_x2 <= clipped_x1 or clipped_y2 <= clipped_y1:
        raise WorkerError(f"Base annotation does not overlap the image in {path}:{line_number}")
    clipped = (
        (clipped_x1 + clipped_x2) / 2,
        (clipped_y1 + clipped_y2) / 2,
        clipped_x2 - clipped_x1,
        clipped_y2 - clipped_y1,
    )
    if any(abs(before - after) > 1e-7 for before, after in zip(box, clipped)):
        print(f"Clipped base annotation to image bounds: {path}:{line_number}")
    return clipped


def _parse_detection_label(path: Path, class_names: list[str], *, clip_to_image: bool = False) -> list[tuple[str, tuple[float, float, float, float]]]:
    objects = []
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not raw_line.strip():
            continue
        fields = raw_line.split()
        if len(fields) != 5:
            raise WorkerError(f"Invalid YOLO row in {path}:{line_number}")
        try:
            class_id = int(fields[0])
            box = tuple(float(value) for value in fields[1:])
        except ValueError as exc:
            raise WorkerError(f"Non-numeric YOLO row in {path}:{line_number}") from exc
        if class_id not in range(len(class_names)):
            raise WorkerError(f"Class ID outside mapping in {path}:{line_number}")
        objects.append((class_names[class_id], _bounded_detection_box(box, path, line_number, clip_to_image=clip_to_image)))
    return objects


def _paired_samples(images_dir: Path, labels_dir: Path, class_names: list[str], source: str, *, clip_to_image: bool = False) -> list[dict[str, Any]]:
    images = sorted(path for path in images_dir.rglob("*") if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES)
    labels = sorted(path for path in labels_dir.rglob("*.txt") if path.is_file())
    image_map = {path.relative_to(images_dir).with_suffix(""): path for path in images}
    label_map = {path.relative_to(labels_dir).with_suffix(""): path for path in labels}
    if set(image_map) != set(label_map):
        raise WorkerError(f"Image/label pairing mismatch in {source} dataset")
    return [{"source": source, "image": image_map[key], "label_path": label_map[key], "image_sha256": sha256(image_map[key]), "objects": _parse_detection_label(label_map[key], class_names, clip_to_image=clip_to_image)} for key in sorted(image_map)]


def build_combined_dataset(base_root: Path, corrections_root: Path, correction_info: dict[str, Any], output_root: Path, job: Job) -> dict[str, Any]:
    base_classes = [line.strip() for line in (base_root / "classes.txt").read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    if not base_classes or len({name.casefold() for name in base_classes}) != len(base_classes):
        raise WorkerError("Base classes.txt is empty or contains duplicate class names")
    correction_classes = correction_info["classes"]
    classes = list(base_classes)
    known = {name.casefold() for name in classes}
    for name in sorted(correction_classes, key=str.casefold):
        if name.casefold() not in known:
            classes.append(name)
            known.add(name.casefold())
    class_ids = {name.casefold(): index for index, name in enumerate(classes)}

    base_samples = _paired_samples(base_root / "images", base_root / "labels", base_classes, "base", clip_to_image=True)
    correction_samples = []
    for split in ("train", "val", "test"):
        images_dir = corrections_root / "images" / split
        labels_dir = corrections_root / "labels" / split
        if images_dir.is_dir() or labels_dir.is_dir():
            correction_samples.extend(_paired_samples(images_dir, labels_dir, correction_classes, "correction"))

    # Identical source images are one sample. Human-reviewed corrections replace
    # base labels for the same pixels. Ambiguous base duplicates are safer to omit
    # than to guess which annotation is correct; conflicting human corrections fail.
    samples: dict[str, dict[str, Any]] = {}
    conflicting_base_duplicates: dict[str, set[str]] = {}
    for sample in [*base_samples, *correction_samples]:
        existing = samples.get(sample["image_sha256"])
        if existing and existing["source"] == sample["source"] and existing["objects"] != sample["objects"]:
            if sample["source"] == "correction":
                raise WorkerError(
                    f"Duplicate correction image has conflicting labels: {sample['image_sha256']} "
                    f"({existing['label_path']}, {sample['label_path']})"
                )
            paths = conflicting_base_duplicates.setdefault(sample["image_sha256"], set())
            paths.update((str(existing["label_path"]), str(sample["label_path"])))
            samples.pop(sample["image_sha256"], None)
            continue
        if sample["source"] == "base" and sample["image_sha256"] in conflicting_base_duplicates:
            conflicting_base_duplicates[sample["image_sha256"]].add(str(sample["label_path"]))
            continue
        if sample["source"] == "correction":
            # An approved human correction resolves an ambiguous base duplicate.
            conflicting_base_duplicates.pop(sample["image_sha256"], None)
            samples[sample["image_sha256"]] = sample
        elif not existing:
            samples[sample["image_sha256"]] = sample

    skipped_conflicts = [
        {"source_image_sha256": image_hash, "label_paths": sorted(paths), "reason": "identical base image has conflicting labels"}
        for image_hash, paths in sorted(conflicting_base_duplicates.items())
    ]
    for conflict in skipped_conflicts:
        print(f"Skipped ambiguous base duplicate: {conflict['source_image_sha256']} ({', '.join(conflict['label_paths'])})")

    if len(samples) < 3:
        raise WorkerError("Combined dataset needs at least three distinct images for train/val/test")
    output_root.mkdir(parents=True, exist_ok=False)
    for split in ("train", "val", "test"):
        (output_root / "images" / split).mkdir(parents=True)
        (output_root / "labels" / split).mkdir(parents=True)
    counts = {split: {"images": 0, "annotations": 0} for split in ("train", "val", "test")}
    source_counts = {"base": 0, "correction": 0}
    manifest_samples = []
    train_boundary = job.train_fraction
    val_boundary = job.train_fraction + job.val_fraction
    for image_hash, sample in sorted(samples.items()):
        rank = int(hashlib.sha256(f"fridge9000-combined-split-v1:{image_hash}".encode()).hexdigest(), 16) / (2**256)
        split = "train" if rank < train_boundary else "val" if rank < val_boundary else "test"
        filename = f"{sample['source']}_{image_hash[:16]}{sample['image'].suffix.lower()}"
        shutil.copy2(sample["image"], output_root / "images" / split / filename)
        label_path = output_root / "labels" / split / Path(filename).with_suffix(".txt").name
        lines = []
        for label, box in sample["objects"]:
            lines.append(f"{class_ids[label.casefold()]} " + " ".join(f"{value:.8f}" for value in box))
        label_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
        counts[split]["images"] += 1
        counts[split]["annotations"] += len(lines)
        source_counts[sample["source"]] += 1
        manifest_samples.append({"source": sample["source"], "source_image_sha256": image_hash, "split": split, "image": f"images/{split}/{filename}", "label": f"labels/{split}/{label_path.name}", "annotations": len(lines)})
    if any(counts[split]["images"] == 0 for split in counts):
        raise WorkerError(f"Deterministic combined split produced an empty split: {counts}")
    names_yaml = "\n".join(f"  {index}: {json.dumps(name, ensure_ascii=False)}" for index, name in enumerate(classes))
    (output_root / "data.yaml").write_text(f"path: {output_root.as_posix()}\ntrain: images/train\nval: images/val\ntest: images/test\nnc: {len(classes)}\nnames:\n{names_yaml}\n", encoding="utf-8")
    manifest = {
        "format_version": "fridge9000-combined-v1", "created_at": utc_now(),
        "correction_dataset_version": job.dataset_version, "base_dataset_slug": job.base_dataset_slug,
        "base_dataset_content_sha256": directory_sha256(base_root),
        "skipped_conflicting_base_duplicates": skipped_conflicts,
        "included_submission_ids": correction_info["manifest"].get("included_submission_ids", []),
        "class_mapping": [{"id": index, "name": name} for index, name in enumerate(classes)],
        "split_strategy": {"name": "stable_image_sha256", "seed": "fridge9000-combined-split-v1", "fractions": {"train": job.train_fraction, "val": job.val_fraction, "test": job.test_fraction}},
        "split_counts": counts, "source_counts": source_counts, "samples": manifest_samples,
    }
    write_json(output_root / "manifest.json", manifest)
    return {"dataset_root": str(output_root), "data_yaml": str(output_root / "data.yaml"), "manifest": manifest, "classes": classes, "splits": {split: {**counts[split], "images_dir": str(output_root / "images" / split), "labels_dir": str(output_root / "labels" / split)} for split in counts}, "evaluation_split": "test", "evaluation_limitation": None}


def finite(value: Any) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise WorkerError("Ultralytics returned a non-finite metric")
    return number


def metrics_from_result(result: Any, names: list[str]) -> dict[str, Any]:
    overall = {"precision": finite(result.box.mp), "recall": finite(result.box.mr), "map50": finite(result.box.map50), "map50_95": finite(result.box.map)}
    per_class = []
    maps = list(getattr(result.box, "maps", []))
    precision = list(getattr(result.box, "p", []))
    recall = list(getattr(result.box, "r", []))
    ap50 = getattr(result.box, "ap50", [])
    measured_ids = list(getattr(result.box, "ap_class_index", range(len(maps))))
    measured_positions = {int(class_id): position for position, class_id in enumerate(measured_ids)}
    for index, name in enumerate(names):
        row: dict[str, Any] = {"class_id": index, "name": name}
        position = measured_positions.get(index)
        for key, values in (("precision", precision), ("recall", recall), ("map50", ap50), ("map50_95", maps)):
            if position is not None and position < len(values):
                row[key] = finite(values[position])
        per_class.append(row)
    return {**overall, "per_class": per_class}


def align_model_names_for_evaluation(model: Any, dataset_names: list[str]) -> list[str]:
    """Expose the full dataset mapping while preserving the detector's real output head."""
    core = getattr(model, "model", None)
    layers = getattr(core, "model", None)
    if core is None or layers is None or not len(layers):
        raise WorkerError("Could not inspect detector class head before evaluation")
    output_classes = int(getattr(layers[-1], "nc", 0))
    if output_classes <= 0 or output_classes > len(dataset_names):
        raise WorkerError(
            f"Detector output class count {output_classes} is incompatible with dataset class count {len(dataset_names)}"
        )
    raw_names = getattr(core, "names", {})
    existing = {int(key): str(value) for key, value in raw_names.items()} if isinstance(raw_names, dict) else {index: str(value) for index, value in enumerate(raw_names)}
    for index in range(output_classes):
        current = existing.get(index)
        if current is not None and current.casefold() != dataset_names[index].casefold():
            raise WorkerError(
                f"Detector class {index} is {current!r}, but the evaluation dataset maps it to {dataset_names[index]!r}"
            )
    # This changes display/evaluation metadata only. The detection head and
    # weights remain untouched, so unseen classes correctly receive no predictions.
    core.names = dict(enumerate(dataset_names))
    return dataset_names[output_classes:]


def metric_differences(candidate: dict[str, Any], active: dict[str, Any]) -> dict[str, float]:
    return {key: finite(candidate[key]) - finite(active[key]) for key in METRIC_KEYS}


def candidate_is_better(delta: dict[str, float], tolerance: float = 1e-12) -> bool:
    return delta["map50_95"] > tolerance or (abs(delta["map50_95"]) <= tolerance and delta["map50"] > tolerance)


def per_class_differences(candidate: dict[str, Any], active: dict[str, Any]) -> list[dict[str, Any]]:
    active_rows = {row["class_id"]: row for row in active.get("per_class", [])}
    candidate_rows = {row["class_id"]: row for row in candidate.get("per_class", [])}
    rows = []
    for class_id in sorted(set(active_rows) & set(candidate_rows)):
        old, new = active_rows[class_id], candidate_rows[class_id]
        common_metrics = [key for key in METRIC_KEYS if key in old and key in new]
        rows.append({"class_id": class_id, "name": new.get("name") or old.get("name"), "delta": {key: finite(new[key]) - finite(old[key]) for key in common_metrics}})
    return rows


def shared_class_comparison(
    candidate: dict[str, Any],
    active: dict[str, Any],
    names: list[str],
    candidate_output_classes: int,
    active_output_classes: int,
) -> dict[str, Any]:
    """Compare only classes both detector heads can predict on this evaluation split."""
    shared_ids = set(range(min(candidate_output_classes, active_output_classes, len(names))))
    active_rows = {row["class_id"]: row for row in active.get("per_class", [])}
    candidate_rows = {row["class_id"]: row for row in candidate.get("per_class", [])}
    evaluated_ids = [
        class_id for class_id in sorted(shared_ids)
        if all(key in active_rows.get(class_id, {}) and key in candidate_rows.get(class_id, {}) for key in METRIC_KEYS)
    ]
    if not evaluated_ids:
        return {
            "available": False,
            "class_count": 0,
            "class_ids": [],
            "class_names": [],
            "note": "No shared classes had labeled instances in the evaluation split.",
        }

    def aggregate(rows: dict[int, dict[str, Any]]) -> dict[str, float]:
        return {
            key: sum(finite(rows[class_id][key]) for class_id in evaluated_ids) / len(evaluated_ids)
            for key in METRIC_KEYS
        }

    active_metrics = aggregate(active_rows)
    candidate_metrics = aggregate(candidate_rows)
    delta = metric_differences(candidate_metrics, active_metrics)
    return {
        "available": True,
        "class_count": len(evaluated_ids),
        "class_ids": evaluated_ids,
        "class_names": [names[class_id] for class_id in evaluated_ids],
        "active_metrics": active_metrics,
        "candidate_metrics": candidate_metrics,
        "metric_differences": delta,
        "candidate_outperforms_active": candidate_is_better(delta),
        "note": "Macro-average over shared classes with labeled instances in the same evaluation split.",
    }


def run_worker(input_root: Path, working_root: Path, validate_only: bool = False) -> dict[str, Any]:
    stage = "input_discovery"
    working_root.mkdir(parents=True, exist_ok=True)
    failure_path = working_root / "failure.json"
    if failure_path.exists():
        failure_path.unlink()
    manifest_path = working_root / "run_manifest.json"
    started = time.monotonic()
    try:
        inputs = discover_inputs(input_root)
        stage = "job_validation"
        job = Job.load(inputs["job.json"])
        stage = "correction_dataset_discovery"
        correction_format, correction_source = discover_correction_dataset(input_root, job)
        stage = "input_copy"
        active_copy = (working_root / "starting_active_model.pt").resolve()
        pretrained_copy = (working_root / "pretrained_starting_model.pt").resolve()
        candidate_path = (working_root / "candidate_best.pt").resolve()
        if candidate_path == active_copy or candidate_path.name == "active_model.pt":
            raise WorkerError("Candidate output must remain separate from active model weights")
        shutil.copy2(inputs["active_model.pt"], active_copy)
        shutil.copy2(inputs["starting_model.pt"], pretrained_copy)
        active_hash = sha256(active_copy)
        pretrained_hash = sha256(pretrained_copy)
        stage = "dataset_extraction"
        extracted = working_root / "dataset"
        if extracted.exists():
            shutil.rmtree(extracted)
        if correction_format == "zip":
            safe_extract_zip(correction_source, extracted)
        else:
            shutil.copytree(correction_source, extracted)
        dataset_root = find_dataset_root(extracted)
        stage = "dataset_validation"
        corrections = validate_dataset(dataset_root, job, require_evaluation=False)
        stage = "base_dataset_validation"
        base_root = find_base_dataset(input_root)
        stage = "combined_dataset_build"
        dataset = build_combined_dataset(base_root, dataset_root, corrections, working_root / "combined_dataset", job)
        run_manifest = {
            "status": "validated" if validate_only else "running", "created_at": utc_now(), "job": asdict(job),
            "inputs": {
                **{name: {"source_path": str(path), "filename": path.name, "sha256": sha256(path)} for name, path in inputs.items()},
                "correction_dataset": {
                    "source_path": str(correction_source), "format": correction_format,
                    "sha256": sha256(correction_source) if correction_format == "zip" else directory_sha256(correction_source),
                },
            },
            "dataset_version": job.dataset_version, "active_model_version": job.active_model_version,
            "candidate_model_version": job.candidate_model_version, "starting_model_version": job.starting_model_version,
            "base_dataset_slug": job.base_dataset_slug, "evaluation_split": dataset["evaluation_split"],
            "evaluation_limitation": dataset["evaluation_limitation"], "training_parameters": {key: getattr(job, key) for key in ("epochs", "imgsz", "batch", "seed", "patience", "workers")},
            "combined_dataset": {
                "base_dataset_content_sha256": dataset["manifest"]["base_dataset_content_sha256"],
                "source_counts": dataset["manifest"]["source_counts"],
                "split_counts": dataset["manifest"]["split_counts"],
                "class_mapping": dataset["manifest"]["class_mapping"],
                "included_submission_ids": dataset["manifest"]["included_submission_ids"],
            },
            "outputs": {"candidate": "candidate_best.pt", "candidate_last": "candidate_last.pt", "comparison": "comparison.json", "training_metrics": "training_metrics.json"},
        }
        write_json(manifest_path, run_manifest)
        if validate_only:
            report = {"status": "validated", "job": asdict(job), "dataset": dataset, "active_model_sha256": active_hash, "pretrained_starting_model_sha256": pretrained_hash, "candidate_output": str(candidate_path)}
            write_json(working_root / "validation_report.json", report)
            return report

        stage = "dependency_installation"
        ensure_training_dependencies()
        stage = "runtime_validation"
        import torch
        import ultralytics
        from ultralytics import YOLO
        cuda_available = bool(torch.cuda.is_available())
        if job.require_cuda and not cuda_available:
            raise WorkerError("CUDA GPU is required by job.json but torch.cuda.is_available() is false")
        device: int | str = 0 if cuda_available else "cpu"
        gpu_name = torch.cuda.get_device_name(0) if cuda_available else None
        capability = torch.cuda.get_device_capability(0) if cuda_available else None
        architectures = torch.cuda.get_arch_list() if cuda_available else []
        print(
            f"Training device: {device}; CUDA available: {cuda_available}; GPU: {gpu_name}; "
            f"capability: {capability}; PyTorch: {torch.__version__}; CUDA runtime: {torch.version.cuda}; "
            f"compiled architectures: {architectures}"
        )
        active_model = YOLO(str(active_copy))
        if active_model.task != "detect":
            raise WorkerError(f"active_model.pt must be YOLO object-detection weights, got task={active_model.task!r}")
        training_model = YOLO(str(pretrained_copy))
        if training_model.task != "detect":
            raise WorkerError(f"starting_model.pt must be YOLO object-detection weights, got task={training_model.task!r}")
        stage = "candidate_training"
        training_started = utc_now()
        training_model.train(
            data=dataset["data_yaml"], epochs=job.epochs, imgsz=job.imgsz, batch=job.batch, seed=job.seed,
            patience=job.patience, workers=job.workers, device=device, deterministic=True,
            project=str(working_root / "yolo_runs"), name="train", exist_ok=False, verbose=True,
        )
        trained_best = Path(training_model.trainer.best).resolve()
        trained_last = Path(training_model.trainer.last).resolve()
        if not trained_best.is_file():
            raise WorkerError("Ultralytics did not produce best detector weights")
        shutil.copy2(trained_best, candidate_path)
        if trained_last.is_file():
            shutil.copy2(trained_last, working_root / "candidate_last.pt")
        if sha256(active_copy) != active_hash:
            raise WorkerError("The copied active starting weights changed during training")
        candidate_model = YOLO(str(candidate_path))
        if candidate_model.task != "detect":
            raise WorkerError("Trained candidate is not an object-detection model")
        stage = "candidate_evaluation"
        candidate_missing_classes = align_model_names_for_evaluation(candidate_model, dataset["classes"])
        candidate_output_classes = len(dataset["classes"]) - len(candidate_missing_classes)
        evaluation_kwargs = dict(
            data=dataset["data_yaml"], split=dataset["evaluation_split"], imgsz=job.imgsz, batch=job.batch,
            workers=job.workers, device=device, seed=job.seed, deterministic=True,
            project=str(working_root / "yolo_runs"), exist_ok=False, verbose=True,
        )
        candidate_result = candidate_model.val(name="candidate_evaluation", **evaluation_kwargs)
        candidate_metrics = metrics_from_result(candidate_result, dataset["classes"])
        stage = "active_evaluation"
        # model.train() mutates/reloads the training object with trained weights.
        # Reload the unchanged starting checkpoint so this is a genuinely
        # independent active-vs-candidate evaluation.
        active_evaluator = YOLO(str(active_copy))
        if active_evaluator.task != "detect":
            raise WorkerError("Starting active checkpoint is no longer an object detector")
        active_missing_classes = align_model_names_for_evaluation(active_evaluator, dataset["classes"])
        active_output_classes = len(dataset["classes"]) - len(active_missing_classes)
        active_result = active_evaluator.val(name="active_evaluation", **evaluation_kwargs)
        active_metrics = metrics_from_result(active_result, dataset["classes"])
        delta = metric_differences(candidate_metrics, active_metrics)
        shared_comparison = shared_class_comparison(
            candidate_metrics, active_metrics, dataset["classes"],
            candidate_output_classes, active_output_classes,
        )
        comparison = {
            "training_run_id": job.training_run_id, "dataset_version": job.dataset_version,
            "evaluation_split": dataset["evaluation_split"], "evaluation_limitation": dataset["evaluation_limitation"],
            "model_class_coverage": {
                "active_missing_classes": active_missing_classes,
                "candidate_missing_classes": candidate_missing_classes,
                "note": "Missing classes receive no predictions and therefore count as false negatives; model weights are unchanged.",
            },
            "evaluation_split_sha256": split_sha256(dataset["splits"][dataset["evaluation_split"]], Path(dataset["dataset_root"])),
            "active_model": {"version": job.active_model_version, **active_metrics},
            "candidate_model": {"version": job.candidate_model_version, **candidate_metrics},
            "delta": delta, "per_class_delta": per_class_differences(candidate_metrics, active_metrics),
            "shared_class_comparison": shared_comparison,
            "comparison_rule": COMPARISON_RULE, "candidate_outperforms_active": candidate_is_better(delta),
        }
        write_json(working_root / "comparison.json", comparison)
        training_metrics = {
            "training_run_id": job.training_run_id, "dataset_version": job.dataset_version,
            "training_started_at": training_started, "training_completed_at": utc_now(),
            "training_duration_seconds": time.monotonic() - started, "epochs_requested": job.epochs,
            "epochs_completed": getattr(getattr(training_model, "trainer", None), "epoch", None),
            "imgsz": job.imgsz, "batch": job.batch, "seed": job.seed,
            "starting_model": {"version": job.starting_model_version, "filename": "starting_model.pt", "sha256": pretrained_hash},
            "active_model_for_comparison": {"version": job.active_model_version, "filename": "active_model.pt", "sha256": active_hash},
            "candidate_model": {"version": job.candidate_model_version, "filename": candidate_path.name, "sha256": sha256(candidate_path)},
            "combined_dataset": run_manifest["combined_dataset"],
            "candidate_metrics": candidate_metrics, "ultralytics_version": ultralytics.__version__, "pytorch_version": torch.__version__,
            "python_version": platform.python_version(), "cuda_available": cuda_available,
            "cuda_version": getattr(torch.version, "cuda", None), "gpu_name": torch.cuda.get_device_name(0) if cuda_available else None,
        }
        write_json(working_root / "training_metrics.json", training_metrics)
        run_manifest.update({"status": "success", "completed_at": utc_now(), "candidate_sha256": sha256(candidate_path)})
        write_json(manifest_path, run_manifest)
        # Kaggle publishes every file left under /kaggle/working as kernel output.
        # These directories are reproducible scratch data and can be hundreds of
        # megabytes; keeping them makes the backend download the whole dataset
        # before it can register the ~20 MB candidate model.
        for scratch_name in ("combined_dataset", "dataset", "yolo_runs"):
            scratch_path = (working_root / scratch_name).resolve()
            if scratch_path.parent == working_root.resolve() and scratch_path.exists():
                shutil.rmtree(scratch_path)
        return {"status": "success", "comparison": comparison, "training_metrics": training_metrics}
    except BaseException as exc:
        failure = {"status": "failed", "stage": stage, "error_type": type(exc).__name__, "message": str(exc), "created_at": utc_now()}
        write_json(failure_path, failure)
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                manifest.update({"status": "failed", "failed_at": failure["created_at"], "failure": failure})
                write_json(manifest_path, manifest)
            except Exception:
                pass
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-root", type=Path, default=Path(os.getenv("KAGGLE_INPUT_ROOT", "/kaggle/input")))
    parser.add_argument("--working-root", type=Path, default=Path(os.getenv("KAGGLE_WORKING_ROOT", "/kaggle/working")))
    parser.add_argument("--validate-only", action="store_true", help="Validate/package inputs without importing YOLO or training")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        result = run_worker(args.input_root.resolve(), args.working_root.resolve(), args.validate_only)
    except BaseException as exc:
        print(f"Fridge9000 Kaggle worker failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
