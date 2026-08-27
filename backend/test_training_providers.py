import copy
import json
import math
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, call, patch

import training_providers as providers
from core.config import DEFAULT_KAGGLE_MACHINE_SHAPE


class TrainingProviderTests(unittest.TestCase):
    def test_default_kaggle_machine_shape_is_tesla_t4(self):
        self.assertEqual(DEFAULT_KAGGLE_MACHINE_SHAPE, "NvidiaTeslaT4")

    def test_generated_kernel_metadata_requests_gpu_and_internet(self):
        with (
            patch.object(providers, "KAGGLE_USERNAME", "owner"),
            patch.object(providers, "KAGGLE_DATASET_SLUG_PREFIX", "base-data"),
            patch.object(providers, "KAGGLE_MACHINE_SHAPE", "NvidiaTeslaT4"),
        ):
            metadata = providers._kernel_metadata(
                {"enable_gpu": False, "enable_internet": False},
                "owner/run-kernel",
                "owner/run-data",
            )
        self.assertIs(metadata["enable_gpu"], True)
        self.assertIs(metadata["enable_internet"], True)
        self.assertEqual(metadata["machine_shape"], "NvidiaTeslaT4")

    def test_configured_kaggle_machine_shape_is_honored(self):
        with (
            patch.object(providers, "KAGGLE_USERNAME", "owner"),
            patch.object(providers, "KAGGLE_DATASET_SLUG_PREFIX", "base-data"),
            patch.object(providers, "KAGGLE_MACHINE_SHAPE", "NvidiaA100"),
        ):
            metadata = providers._kernel_metadata(
                {}, "owner/run-kernel", "owner/run-data"
            )
        self.assertEqual(metadata["machine_shape"], "NvidiaA100")

    def test_kernel_push_requests_default_accelerator(self):
        kernel_dir = Path("kernel-stage")
        with patch.object(
            providers, "KAGGLE_MACHINE_SHAPE", DEFAULT_KAGGLE_MACHINE_SHAPE
        ):
            command = providers._kernel_push_command(kernel_dir)
        self.assertEqual(
            command,
            [
                "kernels",
                "push",
                "-p",
                str(kernel_dir),
                "--accelerator",
                "NvidiaTeslaT4",
            ],
        )

    def test_custom_accelerator_is_propagated_to_cli_and_metadata(self):
        with (
            patch.object(providers, "KAGGLE_USERNAME", "owner"),
            patch.object(providers, "KAGGLE_DATASET_SLUG_PREFIX", "base-data"),
            patch.object(providers, "KAGGLE_MACHINE_SHAPE", "NvidiaA100"),
        ):
            command = providers._kernel_push_command(Path("kernel-stage"))
            metadata = providers._kernel_metadata(
                {}, "owner/run-kernel", "owner/run-data"
            )
        accelerator_index = command.index("--accelerator") + 1
        self.assertEqual(command[accelerator_index], "NvidiaA100")
        self.assertEqual(metadata["machine_shape"], command[accelerator_index])

    def test_provider_selection(self):
        self.assertIs(providers.training_provider("local"), providers.local_training)
        self.assertIs(providers.training_provider("kaggle"), providers.kaggle_training)
        with self.assertRaises(providers.ProviderError):
            providers.training_provider("unknown")

    def test_missing_credentials_fail_without_command(self):
        with patch.object(providers, "KAGGLE_API_TOKEN", ""), patch.object(providers, "KAGGLE_USERNAME", ""), patch.object(providers, "KAGGLE_KEY", ""):
            with self.assertRaisesRegex(providers.ProviderError, "credentials"):
                providers.KaggleCommandRunner()

    def test_new_api_token_auth_is_passed_only_through_environment(self):
        with patch.object(providers, "KAGGLE_API_TOKEN", "secret-token"), patch.object(providers, "KAGGLE_USERNAME", "owner"), patch.object(providers, "KAGGLE_KEY", ""), patch.object(providers, "KAGGLE_KERNEL_SLUG", "owner/kernel"):
            runner = providers.KaggleCommandRunner()
            self.assertEqual(runner.environment["KAGGLE_API_TOKEN"], "secret-token")
            self.assertNotIn("KAGGLE_KEY", runner.environment)

    def test_forbidden_kaggle_response_is_not_retried_and_has_clear_message(self):
        forbidden = SimpleNamespace(returncode=1, stdout="", stderr="403 Client Error: Forbidden")
        with patch.object(providers, "KAGGLE_API_TOKEN", "secret-token"), patch.object(providers, "KAGGLE_USERNAME", "owner"), patch.object(providers, "KAGGLE_KEY", ""), patch.object(providers, "KAGGLE_KERNEL_SLUG", "owner/kernel"), patch.object(providers.subprocess, "run", return_value=forbidden) as run:
            runner = providers.KaggleCommandRunner()
            with self.assertRaisesRegex(providers.ProviderError, "denied access"):
                runner.run(["kernels", "status", "owner/kernel"], retry=True)
            run.assert_called_once()

    def test_kernel_push_failure_is_never_retried(self):
        failed = SimpleNamespace(returncode=1, stdout="", stderr="temporary service failure")
        with patch.object(providers, "KAGGLE_API_TOKEN", "secret-token"), patch.object(providers, "KAGGLE_USERNAME", "owner"), patch.object(providers, "KAGGLE_KEY", ""), patch.object(providers, "KAGGLE_KERNEL_SLUG", "owner/kernel"), patch.object(providers.subprocess, "run", return_value=failed) as run:
            runner = providers.KaggleCommandRunner()
            with self.assertRaisesRegex(providers.ProviderError, "command failed"):
                runner.run(["kernels", "push", "-p", "kernel-stage"], retry=False)
            run.assert_called_once()

    def test_remote_training_lock_rejects_a_second_submission(self):
        connection = MagicMock()
        cursor = connection.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = (False,)
        with patch.object(providers.psycopg2, "connect", return_value=connection):
            with self.assertRaisesRegex(providers.ProviderError, "already in progress"):
                providers._acquire_remote_training_lock()
        connection.close.assert_called_once()

    def test_status_mapping(self):
        self.assertEqual(providers.parse_kernel_status('Kernel has status "queued"'), "queued")
        self.assertEqual(providers.parse_kernel_status('Kernel has status "running"'), "running")
        self.assertEqual(providers.parse_kernel_status('Kernel has status "complete"'), "completed")
        self.assertEqual(providers.parse_kernel_status('Kernel has status "error"'), "failed")
        with self.assertRaises(providers.ProviderError):
            providers.parse_kernel_status("unknown")

    def test_remote_dataset_files_ready_on_first_page(self):
        listing = "active_model.pt\nstarting_model.pt\njob.json\ndataset/manifest.json"
        runner = SimpleNamespace(run=Mock(side_effect=[listing, listing]))
        required = ("active_model.pt", "starting_model.pt", "job.json", "dataset/manifest.json")
        with patch.object(providers.time, "sleep") as sleep:
            providers._wait_for_remote_dataset_files(
                runner, "owner/run", required, poll_seconds=0, settle_seconds=20
            )
        expected = ["datasets", "files", "owner/run", "--page-size", "200"]
        self.assertEqual(runner.run.call_args_list, [call(expected, retry=True)] * 2)
        sleep.assert_any_call(20)

    def test_remote_dataset_files_are_aggregated_across_pages(self):
        first = "Next Page Token = token-2\nactive_model.pt\nimage-001.jpg"
        second = "starting_model.pt\njob.json\ndataset/manifest.json"
        runner = SimpleNamespace(run=Mock(side_effect=[first, second, first, second]))
        required = ("active_model.pt", "starting_model.pt", "job.json", "dataset/manifest.json")
        with patch.object(providers.time, "sleep"):
            providers._wait_for_remote_dataset_files(
                runner, "owner/run", required, poll_seconds=0, settle_seconds=0
            )
        first_args = ["datasets", "files", "owner/run", "--page-size", "200"]
        second_args = first_args + ["--page-token", "token-2"]
        self.assertEqual(
            runner.run.call_args_list,
            [
                call(first_args, retry=True),
                call(second_args, retry=True),
                call(first_args, retry=True),
                call(second_args, retry=True),
            ],
        )

    def test_remote_dataset_missing_file_after_all_pages_times_out(self):
        runner = SimpleNamespace(run=Mock(side_effect=[
            "Next Page Token = token-2\nactive_model.pt",
            "starting_model.pt\njob.json",
        ]))
        required = ("active_model.pt", "starting_model.pt", "job.json", "dataset/manifest.json")
        with patch.object(providers.time, "sleep"):
            with self.assertRaisesRegex(providers.ProviderError, "dataset/manifest.json"):
                providers._wait_for_remote_dataset_files(
                    runner, "owner/run", required, timeout_seconds=0, poll_seconds=0
                )
        self.assertEqual(runner.run.call_count, 2)

    def test_remote_dataset_temporary_forbidden_still_retries_and_settles(self):
        runner = SimpleNamespace(run=Mock(side_effect=[
            providers.KaggleForbiddenError("private dataset ACL is still propagating"),
            "active_model.pt\nstarting_model.pt\njob.json\ndataset/manifest.json",
            "active_model.pt\nstarting_model.pt\njob.json\ndataset/manifest.json",
        ]))
        required = ("active_model.pt", "starting_model.pt", "job.json", "dataset/manifest.json")
        with patch.object(providers.time, "sleep") as sleep:
            providers._wait_for_remote_dataset_files(runner, "owner/run", required, poll_seconds=0, settle_seconds=20)
        self.assertEqual(runner.run.call_count, 3)
        sleep.assert_any_call(20)

    def test_remote_dataset_persistent_forbidden_stops_cleanly(self):
        runner = SimpleNamespace(run=Mock(side_effect=providers.KaggleForbiddenError("denied")))
        with patch.object(providers.time, "sleep"):
            with self.assertRaisesRegex(providers.KaggleForbiddenError, "repeatedly denied"):
                providers._wait_for_remote_dataset_files(
                    runner,
                    "owner/run",
                    ("job.json",),
                    poll_seconds=0,
                    max_forbidden_checks=3,
                )
        self.assertEqual(runner.run.call_count, 3)

    def test_kaggle_resource_slug_obeys_length_limit_and_keeps_run_identity(self):
        resource = providers._kaggle_resource_slug(
            "netanel",
            "fridge9000-training-data-with-an-intentionally-very-long-prefix",
            "remote-lifecycle-train-4cb481d01867",
        )
        owner, slug = resource.split("/", 1)
        self.assertEqual(owner, "netanel")
        self.assertGreaterEqual(len(slug), 6)
        self.assertLessEqual(len(slug), 50)
        self.assertTrue(slug.endswith("ifecycle-train-4cb481d01867"[-24:]))

    def test_kaggle_resource_slug_is_deterministic_and_unique_per_run(self):
        first = providers._kaggle_resource_slug("owner", "fridge9000-training-data", "remote-job-aaaaaaaaaaaa")
        repeated = providers._kaggle_resource_slug("owner", "fridge9000-training-data", "remote-job-aaaaaaaaaaaa")
        second = providers._kaggle_resource_slug("owner", "fridge9000-training-data", "remote-job-bbbbbbbbbbbb")
        self.assertEqual(first, repeated)
        self.assertNotEqual(first, second)

    def test_zip_contains_only_dataset_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset = root / "dataset"
            (dataset / "images" / "train").mkdir(parents=True)
            (dataset / "images" / "train" / "one.jpg").write_bytes(b"image")
            (dataset / "data.yaml").write_text("train: images/train", encoding="utf-8")
            destination = root / "dataset.zip"
            providers._zip_dataset(dataset, destination)
            import zipfile
            with zipfile.ZipFile(destination) as archive:
                self.assertEqual(sorted(archive.namelist()), ["data.yaml", "images/train/one.jpg"])

    def test_local_provider_requires_base_dataset_before_training(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            corrections = root / "corrections"
            corrections.mkdir()
            active = root / "active.pt"
            active.write_bytes(b"active")
            with (
                patch.object(
                    providers,
                    "_export",
                    return_value=(corrections, {"dataset_version": "corrections-v1"}),
                ),
                patch.object(
                    providers,
                    "_active_model",
                    return_value={"resolved_path": active},
                ),
                patch.object(providers, "LOCAL_BASE_DATASET_PATH", root / "missing"),
                patch("train_yolo_candidate.train_candidate") as train_candidate,
            ):
                with self.assertRaisesRegex(
                    providers.ProviderError,
                    "requires a real base dataset.*LOCAL_BASE_DATASET_PATH",
                ):
                    providers.local_training("job-1", lambda **kwargs: None)
            train_candidate.assert_not_called()

    def test_local_combined_dataset_preserves_base_classes_and_adds_correction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            (base / "images").mkdir(parents=True)
            (base / "labels").mkdir()
            (base / "classes.txt").write_text(
                "apple\nbanana\nmilk\n", encoding="utf-8"
            )
            for index in range(30):
                class_id = index % 3
                (base / "images" / f"base-{index}.jpg").write_bytes(
                    f"base-{index}".encode()
                )
                (base / "labels" / f"base-{index}.txt").write_text(
                    f"{class_id} 0.5 0.5 0.4 0.4\n", encoding="utf-8"
                )

            corrections = root / "job-1"
            for split in ("train", "val"):
                (corrections / "images" / split).mkdir(parents=True)
                (corrections / "labels" / split).mkdir(parents=True)
                (corrections / "images" / split / f"{split}.jpg").write_bytes(
                    f"lemon-{split}".encode()
                )
                (corrections / "labels" / split / f"{split}.txt").write_text(
                    "0 0.5 0.5 0.4 0.4\n", encoding="utf-8"
                )
            (corrections / "data.yaml").write_text(
                "train: images/train\nval: images/val\nnc: 1\nnames:\n  0: lemon\n",
                encoding="utf-8",
            )
            (corrections / "manifest.json").write_text(
                json.dumps(
                    {
                        "dataset_version": "corrections-v1",
                        "source_submission_status": "approved",
                        "class_mapping": [{"id": 0, "name": "lemon"}],
                        "included_submission_ids": [10, 11, 12],
                        "trusted_submission_ids": [10, 11],
                        "experimental_submission_ids": [12],
                    }
                ),
                encoding="utf-8",
            )

            with patch.object(providers, "LOCAL_BASE_DATASET_PATH", base):
                combined = providers._prepare_local_combined_dataset(
                    corrections, "corrections-v1"
                )

            manifest = json.loads(
                (combined / "manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                [entry["name"] for entry in manifest["class_mapping"]],
                ["apple", "banana", "milk", "lemon"],
            )
            self.assertEqual(manifest["included_submission_ids"], [10, 11, 12])
            self.assertEqual(manifest["trusted_submission_ids"], [10, 11])
            self.assertEqual(manifest["experimental_submission_ids"], [12])
            correction_manifest = json.loads(
                (root / "job-1-corrections" / "manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                [entry["name"] for entry in correction_manifest["class_mapping"]],
                ["lemon"],
            )

    def test_remote_artifact_validation_rejects_mismatch_before_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / "candidate_best.pt").write_bytes(b"candidate")
            (output / "comparison.json").write_text(json.dumps({"training_run_id": "other"}), encoding="utf-8")
            (output / "training_metrics.json").write_text(json.dumps({"training_run_id": "run"}), encoding="utf-8")
            (output / "run_manifest.json").write_text(json.dumps({"job": {"training_run_id": "run"}}), encoding="utf-8")
            with self.assertRaisesRegex(providers.ProviderError, "another training run"):
                providers._register_remote("run", "dataset", output / "local-dataset", {"version": "active"}, "candidate", output)

    def test_remote_candidate_missing_active_class_is_rejected(self):
        metrics = {
            "precision": 0.8,
            "recall": 0.8,
            "map50": 0.8,
            "map50_95": 0.8,
        }

        def evaluation(classes):
            return {
                "classes": classes,
                "per_class": [
                    {"class_id": index, "name": name, **metrics}
                    for index, name in enumerate(classes)
                ],
            }

        active = evaluation(["apple", "banana", "milk"])
        candidate = evaluation(["lemon", "apple", "milk"])
        comparison = {
            "active_model": active,
            "candidate_model": candidate,
            **providers.build_class_aware_comparison(active, candidate),
        }
        with self.assertRaisesRegex(providers.ProviderError, "banana"):
            providers._remote_class_aware_comparison(comparison)

    def test_remote_value_float_tolerance_accepts_only_harmless_drift(self):
        self.assertTrue(providers._remote_value_matches(0.3 + 1e-16, 0.3))
        self.assertTrue(providers._remote_value_matches(1.0 + 5e-10, 1.0))
        self.assertTrue(providers._remote_value_matches(5e-13, 0.0))

        self.assertFalse(providers._remote_value_matches(1.0 + 2e-9, 1.0))
        self.assertFalse(providers._remote_value_matches(2e-12, 0.0))
        self.assertFalse(providers._remote_value_matches(0.81, 0.8))

    def test_remote_value_rejects_nonfinite_metrics_and_numeric_booleans(self):
        for value in (math.nan, math.inf, -math.inf):
            with self.subTest(value=value):
                self.assertFalse(providers._remote_value_matches(value, 0.8))
                self.assertFalse(providers._remote_value_matches(value, value))

        self.assertTrue(providers._remote_value_matches(True, True))
        self.assertFalse(providers._remote_value_matches(False, True))
        self.assertFalse(providers._remote_value_matches(True, 1.0))
        self.assertFalse(providers._remote_value_matches(1, True))

    def test_remote_value_keeps_structures_and_non_float_values_strict(self):
        expected_dict = {"metric": 0.8, "class_count": 2}
        self.assertFalse(providers._remote_value_matches({"metric": 0.8}, expected_dict))
        self.assertFalse(
            providers._remote_value_matches(
                {"metric": 0.8, "class_count": 2, "extra": None},
                expected_dict,
            )
        )

        expected_list = ["apple", "banana"]
        self.assertFalse(providers._remote_value_matches(["banana", "apple"], expected_list))
        self.assertFalse(providers._remote_value_matches(["apple"], expected_list))
        self.assertFalse(providers._remote_value_matches(["apple", "milk"], expected_list))
        self.assertFalse(providers._remote_value_matches(3, 2))
        self.assertFalse(providers._remote_value_matches(2.0, 2))

    def test_remote_class_aware_comparison_tolerates_drift_but_rejects_mismatch(self):
        metrics = {
            "precision": 0.8,
            "recall": 0.7,
            "map50": 0.6,
            "map50_95": 0.5,
        }

        def evaluation(classes):
            return {
                "classes": classes,
                "per_class": [
                    {"class_id": index, "name": name, **metrics}
                    for index, name in enumerate(classes)
                ],
            }

        active = evaluation(["apple", "milk"])
        candidate = evaluation(["milk", "apple", "lemon"])
        expected = providers.build_class_aware_comparison(active, candidate)
        comparison = {
            "active_model": active,
            "candidate_model": candidate,
            **copy.deepcopy(expected),
        }
        comparison["shared_class_comparison"]["candidate_metrics"]["precision"] += 1e-16
        comparison["added_class_metrics"]["per_class"]["lemon"]["map50_95"] += 5e-13

        self.assertEqual(providers._remote_class_aware_comparison(comparison), expected)

        mismatched = copy.deepcopy(comparison)
        mismatched["shared_class_comparison"]["candidate_metrics"]["precision"] += 1e-4
        with self.assertRaisesRegex(providers.ProviderError, "shared_class_comparison"):
            providers._remote_class_aware_comparison(mismatched)


if __name__ == "__main__":
    unittest.main()
