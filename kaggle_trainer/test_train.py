import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from train import Job, WorkerError, _nvidia_smi_diagnostic, _parse_detection_label, align_model_names_for_evaluation, candidate_is_better, class_aware_comparison, discover_inputs, ensure_training_dependencies, metric_differences, require_class_preservation, run_worker, safe_extract_zip


class TrainerValidationTests(unittest.TestCase):
    def make_package(
        self,
        root: Path,
        *,
        malformed_job=False,
        correction_class="Apple",
        base_classes=("Apple",),
    ):
        source = root / "source"
        (source / "images" / "train").mkdir(parents=True)
        (source / "images" / "val").mkdir(parents=True)
        (source / "labels" / "train").mkdir(parents=True)
        (source / "labels" / "val").mkdir(parents=True)
        for split in ("train", "val"):
            (source / "images" / split / f"{split}.jpg").write_bytes(b"mock-image")
            (source / "labels" / split / f"{split}.txt").write_text("0 0.5 0.5 0.4 0.4\n", encoding="utf-8")
        (source / "data.yaml").write_text(
            f"train: images/train\nval: images/val\nnc: 1\nnames:\n  0: {correction_class}\n",
            encoding="utf-8",
        )
        manifest = {
            "dataset_version": "dataset-v1",
            "source_submission_status": "approved",
            "class_mapping": [{"id": 0, "name": correction_class}],
            "included_submission_ids": [10, 11, 12],
            "trusted_submission_ids": [10, 11],
            "experimental_submission_ids": [12],
        }
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
        (base / "classes.txt").write_text(
            "".join(f"{name}\n" for name in base_classes), encoding="utf-8"
        )
        for index in range(30):
            (base / "images" / f"base_{index}.jpg").write_bytes(f"base-image-{index}".encode())
            class_id = index % len(base_classes)
            (base / "labels" / f"base_{index}.txt").write_text(f"{class_id} 0.5 0.5 0.4 0.4\n", encoding="utf-8")
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

    def test_combined_dataset_preserves_base_vocabulary_and_adds_lemon(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = self.make_package(
                root,
                correction_class="Lemon",
                base_classes=("apple", "banana", "milk"),
            )
            result = run_worker(input_root, root / "working", validate_only=True)
            correction_manifest = json.loads(
                (root / "working" / "dataset" / "manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            combined_manifest = result["dataset"]["manifest"]
            self.assertEqual(
                [entry["name"] for entry in correction_manifest["class_mapping"]],
                ["Lemon"],
            )
            self.assertEqual(
                [entry["name"] for entry in combined_manifest["class_mapping"]],
                ["apple", "banana", "milk", "Lemon"],
            )
            self.assertEqual(combined_manifest["included_submission_ids"], [10, 11, 12])
            self.assertEqual(combined_manifest["trusted_submission_ids"], [10, 11])
            self.assertEqual(combined_manifest["experimental_submission_ids"], [12])

    def test_class_preservation_is_semantic_and_order_independent(self):
        require_class_preservation(
            ["apple", "banana", "milk"],
            ["MILK", "Apple", "lemon", "Banana"],
            "combined training dataset",
        )

    def test_class_preservation_rejects_missing_active_class(self):
        with self.assertRaisesRegex(WorkerError, "(?i)banana"):
            require_class_preservation(
                ["apple", "banana", "milk"],
                ["apple", "milk", "lemon"],
                "combined training dataset",
            )

    def test_missing_base_dataset_fails_before_training(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = self.make_package(root, correction_class="Lemon")
            import shutil

            shutil.rmtree(input_root / "base-dataset")
            with self.assertRaisesRegex(WorkerError, "base dataset"):
                run_worker(input_root, root / "working", validate_only=True)
            failure = json.loads(
                (root / "working" / "failure.json").read_text(encoding="utf-8")
            )
            self.assertEqual(failure["stage"], "base_dataset_validation")

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


    @staticmethod
    def usable_dependency_stack():
        return {
            "errors": {},
            "torch_version": "2.9.0+cu130",
            "torchvision_version": "0.24.0+cu130",
            "cuda_version": "13.0",
            "cuda_available": True,
            "device_count": 1,
            "gpu_name": "Kaggle Test GPU",
            "nvidia_smi_available": False,
            "nvidia_smi_gpu_names": [],
            "ultralytics_version": "8.3.99",
        }

    def test_cuda_stack_is_accepted_when_nvidia_smi_is_unavailable(self):
        with patch("train._dependency_probe", return_value=self.usable_dependency_stack()), patch("train._pip_install") as install:
            ensure_training_dependencies(require_cuda=True)
        install.assert_not_called()

    def test_missing_torchvision_installs_fallback_torch_stack_only(self):
        unavailable = {
            **self.usable_dependency_stack(),
            "errors": {"torchvision": "RuntimeError: missing CUDA operator"},
        }
        with patch("train._dependency_probe", side_effect=[unavailable, self.usable_dependency_stack()]), patch("train._pip_install") as install:
            ensure_training_dependencies(require_cuda=True)
        install.assert_called_once()
        arguments, description = install.call_args.args
        self.assertIn("torch==2.7.1", arguments)
        self.assertIn("torchvision==0.22.1", arguments)
        self.assertIn("https://download.pytorch.org/whl/cu118", arguments)
        self.assertIn("PyTorch", description)

    def test_missing_ultralytics_installs_only_ultralytics(self):
        unavailable = {
            **self.usable_dependency_stack(),
            "errors": {"ultralytics": "ModuleNotFoundError: ultralytics"},
        }
        with patch("train._dependency_probe", side_effect=[unavailable, self.usable_dependency_stack()]), patch("train._pip_install") as install:
            ensure_training_dependencies(require_cuda=True)
        install.assert_called_once_with(
            ["ultralytics==8.4.120"], "Ultralytics 8.4.120"
        )

    def test_cuda_is_optional_when_job_does_not_require_it(self):
        cpu_stack = {
            **self.usable_dependency_stack(),
            "cuda_version": None,
            "cuda_available": False,
            "device_count": 0,
            "gpu_name": None,
        }
        with patch("train._dependency_probe", return_value=cpu_stack), patch("train._pip_install") as install:
            ensure_training_dependencies(require_cuda=False)
        install.assert_not_called()

    def test_failed_required_dependency_install_reports_network_failure(self):
        unavailable = {
            "errors": {"torch": "ModuleNotFoundError: torch"},
            "cuda_available": False,
            "device_count": 0,
            "gpu_name": None,
            "nvidia_smi_available": False,
        }
        with patch("train._dependency_probe", return_value=unavailable), patch("train.subprocess.run", return_value=SimpleNamespace(returncode=1)):
            with self.assertRaisesRegex(
                WorkerError, "Dependency installation failed.*Network access may be unavailable"
            ):
                ensure_training_dependencies(require_cuda=False)

    def test_cpu_provisioned_cuda_job_fails_without_pip_installation(self):
        cpu_stack = {
            "errors": {},
            "torch_version": "2.10.0+cpu",
            "torchvision_version": "0.25.0+cpu",
            "cuda_version": None,
            "cuda_available": False,
            "device_count": 0,
            "gpu_name": None,
            "nvidia_smi_available": False,
            "ultralytics_version": "8.4.120",
        }
        with patch("train._dependency_probe", return_value=cpu_stack), patch("train._pip_install") as install:
            with self.assertRaisesRegex(WorkerError, "does not currently expose usable CUDA"):
                ensure_training_dependencies(require_cuda=True)
        install.assert_not_called()

    def test_nvidia_smi_present_is_captured_as_optional_diagnostic(self):
        result = SimpleNamespace(
            returncode=0, stdout="NVIDIA Tesla T4\n", stderr=""
        )
        with patch("train.shutil.which", return_value="/usr/bin/nvidia-smi"), patch("train.subprocess.run", return_value=result):
            diagnostic = _nvidia_smi_diagnostic()
        self.assertIs(diagnostic["nvidia_smi_available"], True)
        self.assertEqual(diagnostic["nvidia_smi_gpu_names"], ["NVIDIA Tesla T4"])

    def test_missing_nvidia_smi_is_reported_without_invoking_it(self):
        with patch("train.shutil.which", return_value=None), patch("train.subprocess.run") as run:
            diagnostic = _nvidia_smi_diagnostic()
        self.assertEqual(
            diagnostic,
            {"nvidia_smi_available": False, "nvidia_smi_gpu_names": []},
        )
        run.assert_not_called()

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
