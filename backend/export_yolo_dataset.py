"""Export approved Teach Fridge 9000 annotations as a YOLO detection dataset."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg2
from PIL import Image
from psycopg2.extras import RealDictCursor


ACTIONS = ("CONFIRM", "RELABEL", "ADJUST_BOX", "ADD", "REMOVE")
EXPORT_FORMAT_VERSION = "1.0"
DEFAULT_SPLIT_SEED = "fridge9000-yolo-split-v1"


@dataclass
class FinalObject:
    label: str
    box: tuple[float, float, float, float]


def normalized_label(label: Any) -> str:
    return " ".join(str(label or "").strip().split())


def valid_box(box: tuple[float, float, float, float], width: int, height: int) -> bool:
    x1, y1, x2, y2 = box
    return 0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height


def yolo_box(box: tuple[float, float, float, float], width: int, height: int) -> tuple[float, float, float, float]:
    x1, y1, x2, y2 = box
    return ((x1 + x2) / (2 * width), (y1 + y2) / (2 * height), (x2 - x1) / width, (y2 - y1) / height)


def resolve_image_path(image_ref: str, backend_root: Path, uploads_root: Path) -> Path | None:
    raw = Path(image_ref)
    candidates = [raw] if raw.is_absolute() else [Path.cwd() / raw, backend_root / raw, uploads_root / raw, uploads_root / raw.name]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def fetch_export_rows(connection):
    with connection.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT s.id AS submission_id, s.scan_id, s.image_width, s.image_height,
                   s.created_at AS submission_created_at, sc.image_ref
            FROM annotation_submissions s
            JOIN scans sc ON sc.id = s.scan_id
            WHERE s.status = 'approved'
            ORDER BY s.scan_id, s.created_at, s.id;
            """
        )
        submissions = cur.fetchall()
        if not submissions:
            return [], [], []
        scan_ids = sorted({row["scan_id"] for row in submissions})
        submission_ids = [row["submission_id"] for row in submissions]
        cur.execute(
            """
            SELECT id, scan_id, label, confidence, x1, y1, x2, y2
            FROM scan_detections
            WHERE scan_id = ANY(%s)
            ORDER BY scan_id, id;
            """,
            (scan_ids,),
        )
        detections = cur.fetchall()
        cur.execute(
            """
            SELECT *
            FROM annotations
            WHERE submission_id = ANY(%s)
            ORDER BY submission_id, id;
            """,
            (submission_ids,),
        )
        annotations = cur.fetchall()
        return submissions, detections, annotations


def reconstruct_scan(submissions, detections, annotations):
    width = int(submissions[0]["image_width"])
    height = int(submissions[0]["image_height"])
    if any(int(row["image_width"]) != width or int(row["image_height"]) != height for row in submissions):
        raise ValueError("approved submissions disagree about image dimensions")

    objects: dict[str, FinalObject] = {}
    source_ids = set()
    warnings = []
    for detection in detections:
        label = normalized_label(detection["label"])
        values = (detection["x1"], detection["y1"], detection["x2"], detection["y2"])
        if not label or any(value is None for value in values):
            warnings.append(f"original detection {detection['id']} has no valid label/box and was omitted")
            continue
        box = tuple(float(value) for value in values)
        if not valid_box(box, width, height):
            warnings.append(f"original detection {detection['id']} has an invalid box and was omitted")
            continue
        key = f"source:{detection['id']}"
        objects[key] = FinalObject(label, box)
        source_ids.add(int(detection["id"]))

    actions_by_source: dict[int, dict[str, tuple[Any, ...]]] = defaultdict(dict)
    action_counts = Counter()
    for annotation in annotations:
        action = annotation["action"]
        action_counts[action] += 1
        source_id = annotation["source_detection_id"]
        if action == "ADD":
            if source_id is not None:
                raise ValueError(f"ADD annotation {annotation['id']} unexpectedly has a source detection")
            label = normalized_label(annotation["final_label"])
            values = (annotation["final_x1"], annotation["final_y1"], annotation["final_x2"], annotation["final_y2"])
            if not label or any(value is None for value in values):
                raise ValueError(f"ADD annotation {annotation['id']} has no valid final label/box")
            box = tuple(float(value) for value in values)
            if not valid_box(box, width, height):
                raise ValueError(f"ADD annotation {annotation['id']} has an out-of-bounds box")
            objects[f"add:{annotation['id']}"] = FinalObject(label, box)
            continue

        if source_id is None or int(source_id) not in source_ids:
            raise ValueError(f"{action} annotation {annotation['id']} references an unavailable source detection")
        source_id = int(source_id)
        signature = (
            normalized_label(annotation["final_label"]),
            annotation["final_x1"], annotation["final_y1"], annotation["final_x2"], annotation["final_y2"],
        )
        previous = actions_by_source[source_id].get(action)
        if previous is not None and previous != signature:
            raise ValueError(f"conflicting {action} annotations for source detection {source_id}")
        actions_by_source[source_id][action] = signature

    for source_id, actions in actions_by_source.items():
        action_names = set(actions)
        if "REMOVE" in action_names and len(action_names) > 1:
            raise ValueError(f"REMOVE conflicts with another approved action for source detection {source_id}")
        if "CONFIRM" in action_names and len(action_names) > 1:
            raise ValueError(f"CONFIRM conflicts with a correction for source detection {source_id}")
        key = f"source:{source_id}"
        if "REMOVE" in actions:
            objects.pop(key, None)
            continue
        current = objects[key]
        if "RELABEL" in actions:
            label = actions["RELABEL"][0]
            if not label:
                raise ValueError(f"RELABEL for source detection {source_id} has no final label")
            current = FinalObject(label, current.box)
        if "ADJUST_BOX" in actions:
            values = actions["ADJUST_BOX"][1:]
            if any(value is None for value in values):
                raise ValueError(f"ADJUST_BOX for source detection {source_id} has no final box")
            box = tuple(float(value) for value in values)
            if not valid_box(box, width, height):
                raise ValueError(f"ADJUST_BOX for source detection {source_id} is out of bounds")
            current = FinalObject(current.label, box)
        objects[key] = current

    return list(objects.values()), action_counts, warnings


def build_class_mapping(samples):
    variants: dict[str, set[str]] = defaultdict(set)
    for sample in samples:
        for item in sample["objects"]:
            variants[item.label.casefold()].add(item.label)
    classes = []
    for class_id, canonical_key in enumerate(sorted(variants)):
        aliases = sorted(variants[canonical_key], key=lambda value: (value.casefold(), value))
        classes.append({"id": class_id, "name": aliases[0], "canonical_key": canonical_key, "aliases": aliases})
    id_by_key = {item["canonical_key"]: item["id"] for item in classes}
    return classes, id_by_key


def assign_splits(samples, val_fraction: float, split_seed: str):
    if not 0 < val_fraction < 1:
        raise ValueError("val_fraction must be greater than 0 and less than 1")
    samples_by_image_hash = defaultdict(list)
    for sample in samples:
        samples_by_image_hash[sample["source_image_sha256"]].append(sample)
    ranked = sorted(
        samples_by_image_hash,
        key=lambda image_hash: (hashlib.sha256(f"{split_seed}:{image_hash}".encode()).hexdigest(), image_hash),
    )
    val_count = 0 if len(ranked) < 2 else max(1, min(len(ranked) - 1, int(len(ranked) * val_fraction + 0.5)))
    val_image_hashes = set(ranked[:val_count])
    for image_hash, grouped_samples in samples_by_image_hash.items():
        split = "val" if image_hash in val_image_hashes else "train"
        for sample in grouped_samples:
            sample["split"] = split


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def dataset_identity(samples, classes, val_fraction: float, split_seed: str):
    content = {
        "export_format_version": EXPORT_FORMAT_VERSION,
        "split_strategy": {"name": "stable_source_image_hash_group_rank", "seed": split_seed, "validation_fraction": val_fraction},
        "classes": classes,
        "samples": [
            {
                "scan_id": sample["scan_id"],
                "submission_ids": sample["submission_ids"],
                "source_image_sha256": sample["source_image_sha256"],
                "split": sample["split"],
                "objects": [
                    {"label": item.label, "box": list(item.box)}
                    for item in sorted(sample["objects"], key=lambda obj: (obj.label.casefold(), obj.box))
                ],
            }
            for sample in sorted(samples, key=lambda item: item["scan_id"])
        ],
    }
    encoded = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    return f"fridge9000-yolo-v1-{digest[:16]}", digest, content


def export_dataset(database_url: str, output_dir: Path, uploads_root: Path, val_fraction: float = 0.2, split_seed: str = DEFAULT_SPLIT_SEED):
    if output_dir.exists():
        raise FileExistsError(f"Output path already exists: {output_dir}")
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    backend_root = Path(__file__).resolve().parent

    connection = psycopg2.connect(database_url)
    try:
        connection.set_session(readonly=True, autocommit=False)
        submissions, detections, annotations = fetch_export_rows(connection)
    finally:
        connection.close()

    submissions_by_scan = defaultdict(list)
    detections_by_scan = defaultdict(list)
    annotations_by_submission = defaultdict(list)
    for row in submissions:
        submissions_by_scan[row["scan_id"]].append(row)
    for row in detections:
        detections_by_scan[row["scan_id"]].append(row)
    for row in annotations:
        annotations_by_submission[row["submission_id"]].append(row)

    samples = []
    skipped = []
    export_warnings = []
    counts_by_action = Counter({action: 0 for action in ACTIONS})
    for scan_id in sorted(submissions_by_scan):
        scan_submissions = submissions_by_scan[scan_id]
        scan_annotations = [annotation for submission in scan_submissions for annotation in annotations_by_submission[submission["submission_id"]]]
        submission_ids = [row["submission_id"] for row in scan_submissions]
        try:
            if not scan_annotations:
                raise ValueError("approved submission contains no annotations")
            objects, action_counts, warnings = reconstruct_scan(scan_submissions, detections_by_scan[scan_id], scan_annotations)
            image_path = resolve_image_path(scan_submissions[0]["image_ref"] or "", backend_root, uploads_root)
            if image_path is None:
                raise ValueError("source image is missing")
            with Image.open(image_path) as image:
                actual_size = image.size
            expected_size = (int(scan_submissions[0]["image_width"]), int(scan_submissions[0]["image_height"]))
            if actual_size != expected_size:
                raise ValueError(f"source image dimensions {actual_size} do not match stored dimensions {expected_size}")
            if not objects:
                warnings.append("final reviewed object set is empty")
            samples.append({"scan_id": scan_id, "submission_ids": submission_ids, "image_path": image_path, "source_image_sha256": file_sha256(image_path), "objects": objects})
            counts_by_action.update(action_counts)
            export_warnings.extend({"scan_id": scan_id, "reason": warning} for warning in warnings)
        except (ValueError, OSError) as exc:
            skipped.extend({"submission_id": submission_id, "scan_id": scan_id, "reason": str(exc)} for submission_id in submission_ids)

    assign_splits(samples, val_fraction, split_seed)
    dataset_warnings = []
    if samples and len({sample["source_image_sha256"] for sample in samples}) < 2:
        dataset_warnings.append("Validation split is empty because fewer than two distinct source images were exportable")
    classes, class_ids = build_class_mapping(samples)
    dataset_id, content_sha256, identity_content = dataset_identity(samples, classes, val_fraction, split_seed)
    created_at = datetime.now(timezone.utc).isoformat()
    class_counts = Counter({item["name"]: 0 for item in classes})
    temp_dir = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}-", dir=output_dir.parent))
    try:
        images_dir = temp_dir / "images"
        labels_dir = temp_dir / "labels"
        for split in ("train", "val"):
            (images_dir / split).mkdir(parents=True)
            (labels_dir / split).mkdir(parents=True)
        annotation_total = 0
        exported_samples = []
        split_counts = {split: {"images": 0, "annotations": 0} for split in ("train", "val")}
        for sample in samples:
            suffix = sample["image_path"].suffix.lower()
            image_name = f"scan_{sample['scan_id']}{suffix}"
            label_name = f"scan_{sample['scan_id']}.txt"
            split = sample["split"]
            shutil.copy2(sample["image_path"], images_dir / split / image_name)
            lines = []
            for item in sorted(sample["objects"], key=lambda obj: (obj.label.casefold(), obj.box)):
                class_id = class_ids[item.label.casefold()]
                center_x, center_y, box_width, box_height = yolo_box(item.box, int(submissions_by_scan[sample["scan_id"]][0]["image_width"]), int(submissions_by_scan[sample["scan_id"]][0]["image_height"]))
                values = (center_x, center_y, box_width, box_height)
                if not all(0 <= value <= 1 for value in values):
                    raise ValueError(f"normalized box escaped [0,1] for scan {sample['scan_id']}")
                lines.append(f"{class_id} " + " ".join(f"{value:.8f}" for value in values))
                class_counts[classes[class_id]["name"]] += 1
                annotation_total += 1
            (labels_dir / split / label_name).write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
            split_counts[split]["images"] += 1
            split_counts[split]["annotations"] += len(lines)
            exported_samples.append({"scan_id": sample["scan_id"], "submission_ids": sample["submission_ids"], "split": split, "source_image_sha256": sample["source_image_sha256"], "image": f"images/{split}/{image_name}", "label": f"labels/{split}/{label_name}", "annotations": len(lines)})

        names_yaml = "\n".join(f"  {item['id']}: {json.dumps(item['name'], ensure_ascii=False)}" for item in classes)
        names_section = f"names:\n{names_yaml}\n" if classes else "names: {}\n"
        (temp_dir / "data.yaml").write_text(f"train: images/train\nval: images/val\nnc: {len(classes)}\n{names_section}", encoding="utf-8")
        (temp_dir / "classes.json").write_text(json.dumps({"classes": classes}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        included_submission_ids = sorted(submission_id for sample in samples for submission_id in sample["submission_ids"])
        manifest = {
            "dataset_id": dataset_id,
            "dataset_version": dataset_id,
            "export_format_version": EXPORT_FORMAT_VERSION,
            "created_at": created_at,
            "content_sha256": content_sha256,
            "source_submission_status": "approved",
            "included_submission_ids": included_submission_ids,
            "image_count": len(samples),
            "annotation_count": annotation_total,
            "class_mapping": classes,
            "split_strategy": identity_content["split_strategy"],
            "split_counts": split_counts,
            "samples": exported_samples,
            "warnings": dataset_warnings,
        }
        (temp_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        summary = {
            "dataset_id": dataset_id,
            "dataset_version": dataset_id,
            "created_at": created_at,
            "images_exported": len(samples),
            "annotations_exported": annotation_total,
            "approved_submissions_seen": len(submissions),
            "approved_submissions_exported": sum(len(sample["submission_ids"]) for sample in samples),
            "counts_by_action": dict(counts_by_action),
            "counts_by_class": dict(sorted(class_counts.items(), key=lambda item: item[0].casefold())),
            "split_counts": split_counts,
            "samples": exported_samples,
            "skipped_submissions": skipped,
            "warnings": export_warnings,
            "dataset_warnings": dataset_warnings,
        }
        (temp_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        temp_dir.rename(output_dir)
        return summary
    except Exception:
        shutil.rmtree(temp_dir)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="New export directory; must not already exist")
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL", "postgresql://fridge:fridgepass@localhost:5432/fridge9000"))
    parser.add_argument("--uploads-root", type=Path, default=Path(__file__).resolve().parent / "uploads")
    parser.add_argument("--val-fraction", type=float, default=0.2, help="Deterministic validation fraction (default: 0.2)")
    parser.add_argument("--split-seed", default=DEFAULT_SPLIT_SEED, help="Stable split-assignment seed")
    args = parser.parse_args()
    summary = export_dataset(args.database_url, args.output.resolve(), args.uploads_root.resolve(), args.val_fraction, args.split_seed)
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
