import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from train import Job, WorkerError, _parse_detection_label, align_model_names_for_evaluation, candidate_is_better, class_aware_comparison, discover_inputs, ensure_training_dependencies, metric_differences, run_worker, safe_extract_zip


class TrainerValidationTests(unittest.TestCase):
    def make_package(self, root: Path, *, malformed_job=False):
        source = root / "source"
        (source / "images" / "train").mkdir(parents=True)
        (source / "images" / "val").mkdir(parents=True)
        (source / "labels" / "train").mkdir(parents=True)
        (source / "labels" / "val").mkdir(parents=True)
        for split in ("train", "val"):
            (source / "images" / split / f"{split}.jpg").write_bytes(b"mock-image")
            (source / "labels" / split / f"{split}.txt").write_text("0 0.5 0.5 0.4 0.4\n", encoding="utf-8")
        (source / "data.yaml").write_text("train: images/train\nval: images/val\nnc: 1\nnames:\n  0: Apple\n", encoding="utf-8")
        manifest = {"dataset_version": "dataset-v1", "source_submission_status": "approved", "class_mapping": [{"id": 0, "name": "Apple"}]}
        (source / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        input_root = root / "input" / "attached-dataset"
        input_root.mkdir(parents=True)
        with zipfile.ZipFile(input_root / "dataset.zip", "w") as archive:
            for path in source.rglob("*"):
                if path.is_file():
                    archive.write(path, path.relative_to(source))
        (input_root / "active_model.pt").write_bytes(b"mock-weights")
        (input_root / "starting_model.pt").write_bytes(b"mock-pretrained-weights")
        base = root / "input" / "base-dataset" / "data"
        (base / "images").mkdir(parents=True)
        (base / "labels").mkdir()
        (base / "classes.txt").write_text("Apple\n", encoding="utf-8")
        for index in range(30):
            (base / "images" / f"base_{index}.jpg").write_bytes(f"base-image-{index}".encode())
            (base / "labels" / f"base_{index}.txt").write_text("0 0.5 0.5 0.4 0.4\n", encoding="utf-8")
        job = {"training_run_id": "run-1", "dataset_version": "dataset-v1", "base_dataset_slug": "owner/base", "active_model_version": "active-v1", "candidate_model_version": "candidate-v2", "starting_model_version": "yolo11s-pretrained", "require_cuda": True}
        (input_root / "job.json").write_text("{" if malformed_job else json.dumps(job), encoding="utf-8")
        return root / "input"

    def test_validation_only_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = self.make_package(root)
            result = run_worker(input_root, root / "working", validate_only=True)
            self.assertEqual(result["status"], "validated")
            self.assertEqual(result["dataset"]["evaluation_split"], "test")
            self.assertGreater(result["dataset"]["manifest"]["source_counts"]["base"], 0)
            self.assertGreater(result["dataset"]["manifest"]["source_counts"]["correction"], 0)
            samples = result["dataset"]["manifest"]["samples"]
            self.assertEqual(len({sample["source_image_sha256"] for sample in samples}), len(samples))
            self.assertEqual({sample["split"] for sample in samples}, {"train", "val", "test"})
            second = run_worker(input_root, root / "working-second", validate_only=True)
            first_assignment = {sample["source_image_sha256"]: sample["split"] for sample in samples}
            second_assignment = {sample["source_image_sha256"]: sample["split"] for sample in second["dataset"]["manifest"]["samples"]}
            self.assertEqual(first_assignment, second_assignment)
            self.assertNotEqual(Path(result["candidate_output"]).name, "active_model.pt")

    def test_validation_accepts_kaggle_expanded_dataset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = self.make_package(root)
            archive = input_root / "attached-dataset" / "dataset.zip"
            expanded = input_root / "attached-dataset" / "dataset"
            with zipfile.ZipFile(archive) as bundle:
                bundle.extractall(expanded)
            archive.unlink()
            result = run_worker(input_root, root / "working-expanded", validate_only=True)
            self.assertEqual(result["status"], "validated")
            self.assertGreater(result["dataset"]["manifest"]["source_counts"]["correction"], 0)
            run_manifest = json.loads((root / "working-expanded" / "run_manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(run_manifest["inputs"]["correction_dataset"]["format"], "directory")

    def test_conflicting_duplicate_base_image_is_skipped_and_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = self.make_package(root)
            base = input_root / "base-dataset" / "data"
            duplicate_image = base / "images" / "duplicate.jpg"
            duplicate_image.write_bytes((base / "images" / "base_0.jpg").read_bytes())
            (base / "labels" / "duplicate.txt").write_text("0 0.3 0.3 0.2 0.2\n", encoding="utf-8")
            result = run_worker(input_root, root / "working-conflict", validate_only=True)
            skipped = result["dataset"]["manifest"]["skipped_conflicting_base_duplicates"]
            self.assertEqual(len(skipped), 1)
            self.assertEqual(skipped[0]["reason"], "identical base image has conflicting labels")
            self.assertEqual(len(skipped[0]["label_paths"]), 2)
            self.assertNotIn(skipped[0]["source_image_sha256"], {sample["source_image_sha256"] for sample in result["dataset"]["manifest"]["samples"]})

    def test_malformed_job_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = self.make_package(root, malformed_job=True)
            with self.assertRaises(WorkerError):
                run_worker(input_root, root / "working", validate_only=True)
            failure = json.loads((root / "working" / "failure.json").read_text(encoding="utf-8"))
            self.assertEqual(failure["stage"], "job_validation")

    def test_missing_and_duplicate_inputs_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.mkdir(exist_ok=True)
            with self.assertRaises(WorkerError):
                discover_inputs(root)
            input_root = self.make_package(root)
            duplicate = input_root / "second"
            duplicate.mkdir()
            (duplicate / "job.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(WorkerError, "Ambiguous job.json"):
                discover_inputs(input_root)

    def test_zip_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "bad.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("../escape.txt", "bad")
            with self.assertRaises(WorkerError):
                safe_extract_zip(archive, root / "out")

    def test_base_box_crossing_image_edge_is_clipped_but_correction_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            label = Path(directory) / "edge.txt"
            label.write_text("2 0.854365911175158 0.3140311804008898 0.49192977859295056 0.20935412026725878\n", encoding="utf-8")
            with self.assertRaisesRegex(WorkerError, "Invalid normalized box"):
                _parse_detection_label(label, ["a", "b", "c"])
            objects = _parse_detection_label(label, ["a", "b", "c"], clip_to_image=True)
            self.assertEqual(objects[0][0], "c")
            cx, _, width, _ = objects[0][1]
            self.assertAlmostEqual(cx + width / 2, 1.0)
            self.assertGreater(width, 0)

    def test_job_constraints_and_comparison(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "job.json"
            path.write_text(json.dumps({"training_run_id": "r", "dataset_version": "d", "base_dataset_slug": "o/b", "active_model_version": "a", "candidate_model_version": "c", "starting_model_version": "pretrained", "epochs": 0}), encoding="utf-8")
            with self.assertRaises(WorkerError):
                Job.load(path)
        active = {"precision": 0.5, "recall": 0.4, "map50": 0.6, "map50_95": 0.3}
        candidate = {"precision": 0.55, "recall": 0.45, "map50": 0.63, "map50_95": 0.32}
        delta = metric_differences(candidate, active)
        self.assertAlmostEqual(delta["map50_95"], 0.02)
        self.assertTrue(candidate_is_better(delta))
        self.assertFalse(candidate_is_better(metric_differences(active, candidate)))

    def test_class_aware_comparison_matches_names_instead_of_ids(self):
        active = {
            "per_class": [
                {"class_id": 0, "name": "Apple", "precision": .5, "recall": .4, "map50": .6, "map50_95": .3},
                {"class_id": 1, "name": "Banana", "precision": .7, "recall": .6, "map50": .8, "map50_95": .5},
                {"class_id": 2, "name": "New", "precision": 0, "recall": 0, "map50": 0, "map50_95": 0},
            ]
        }
        candidate = {
            "per_class": [
                {"class_id": 0, "name": "Banana", "precision": .8, "recall": .7, "map50": .9, "map50_95": .6},
                {"class_id": 1, "name": "Apple", "precision": .6, "recall": .5, "map50": .7, "map50_95": .4},
                {"class_id": 2, "name": "New", "precision": .9, "recall": .9, "map50": .9, "map50_95": .9},
            ]
        }
        result = class_aware_comparison(
            ["Apple", "Banana"], ["Banana", "Apple", "New"], active, candidate
        )
        self.assertEqual(result["class_comparison"]["shared_classes"], ["Apple", "Banana"])
        self.assertEqual(result["class_comparison"]["added_classes"], ["New"])
        shared = result["shared_class_comparison"]
        self.assertEqual(shared["class_count"], 2)
        self.assertAlmostEqual(shared["active_metrics"]["precision"], .6)
        self.assertAlmostEqual(shared["candidate_metrics"]["precision"], .7)
        self.assertTrue(shared["candidate_outperforms_active"])


    def test_training_dependencies_pin_cuda_torch_and_ultralytics(self):
        versions = {"torch": "2.9.0+cu130", "torchvision": "0.24.0+cu130", "ultralytics": None}
        with patch("train._installed_version", side_effect=lambda package: versions[package]), patch("train.importlib.util.find_spec", return_value=object()), patch("train.subprocess.run", return_value=SimpleNamespace(returncode=0)) as run:
            ensure_training_dependencies()
        self.assertEqual(run.call_count, 2)
        torch_command = run.call_args_list[0].args[0]
        ultralytics_command = run.call_args_list[1].args[0]
        self.assertIn("torch==2.7.1", torch_command)
        self.assertIn("torchvision==0.22.1", torch_command)
        self.assertIn("https://download.pytorch.org/whl/cu118", torch_command)
        self.assertIn("ultralytics==8.4.120", ultralytics_command)

    def test_failed_training_dependency_install_is_actionable(self):
        with patch("train._installed_version", return_value=None), patch("train.subprocess.run", return_value=SimpleNamespace(returncode=1)):
            with self.assertRaisesRegex(WorkerError, "PyTorch 2.7.1.*pip exited with 1"):
                ensure_training_dependencies()

    def test_active_model_can_be_fairly_evaluated_when_dataset_adds_a_class(self):
        core = SimpleNamespace(names={0: "Apple", 1: "Banana"}, model=[SimpleNamespace(nc=2)])
        model = SimpleNamespace(model=core)
        missing = align_model_names_for_evaluation(model, ["Apple", "Banana", "New product"])
        self.assertEqual(missing, ["New product"])
        self.assertEqual(core.model[-1].nc, 2)
        self.assertEqual(core.names, {0: "Apple", 1: "Banana", 2: "New product"})

    def test_evaluation_rejects_changed_existing_class_order(self):
        core = SimpleNamespace(names={0: "Banana"}, model=[SimpleNamespace(nc=1)])
        with self.assertRaisesRegex(WorkerError, "evaluation dataset maps"):
            align_model_names_for_evaluation(SimpleNamespace(model=core), ["Apple"])


if __name__ == "__main__":
    unittest.main()
