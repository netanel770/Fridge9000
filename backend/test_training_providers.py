import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import training_providers as providers


class TrainingProviderTests(unittest.TestCase):
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
            with self.assertRaisesRegex(providers.ProviderError, "private notebooks"):
                runner.run(["kernels", "status", "owner/kernel"], retry=True)
            run.assert_called_once()

    def test_status_mapping(self):
        self.assertEqual(providers.parse_kernel_status('Kernel has status "queued"'), "queued")
        self.assertEqual(providers.parse_kernel_status('Kernel has status "running"'), "running")
        self.assertEqual(providers.parse_kernel_status('Kernel has status "complete"'), "completed")
        self.assertEqual(providers.parse_kernel_status('Kernel has status "error"'), "failed")
        with self.assertRaises(providers.ProviderError):
            providers.parse_kernel_status("unknown")

    def test_remote_dataset_waits_for_two_complete_listings_before_settling(self):
        runner = SimpleNamespace(run=Mock(side_effect=[
            providers.KaggleForbiddenError("private dataset ACL is still propagating"),
            "active_model.pt\njob.json",
            "active_model.pt\nstarting_model.pt\njob.json\ndataset/manifest.json",
            "active_model.pt\nstarting_model.pt\njob.json\ndataset/manifest.json",
        ]))
        required = ("active_model.pt", "starting_model.pt", "job.json", "dataset/manifest.json")
        with patch.object(providers.time, "sleep") as sleep:
            providers._wait_for_remote_dataset_files(runner, "owner/run", required, poll_seconds=0, settle_seconds=20)
        self.assertEqual(runner.run.call_count, 4)
        sleep.assert_any_call(20)

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

    def test_remote_artifact_validation_rejects_mismatch_before_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / "candidate_best.pt").write_bytes(b"candidate")
            (output / "comparison.json").write_text(json.dumps({"training_run_id": "other"}), encoding="utf-8")
            (output / "training_metrics.json").write_text(json.dumps({"training_run_id": "run"}), encoding="utf-8")
            (output / "run_manifest.json").write_text(json.dumps({"job": {"training_run_id": "run"}}), encoding="utf-8")
            with self.assertRaisesRegex(providers.ProviderError, "another training run"):
                providers._register_remote("run", "dataset", output / "local-dataset", {"version": "active"}, "candidate", output)


if __name__ == "__main__":
    unittest.main()
