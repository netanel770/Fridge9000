import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import train_yolo_candidate as trainer


class FakeTrainingModel:
    task = "detect"
    names = {0: "apple", 1: "banana", 2: "milk"}

    def __init__(self, best_path: Path):
        self.best_path = best_path
        self.trainer = None

    def train(self, **kwargs):
        self.best_path.parent.mkdir(parents=True, exist_ok=True)
        self.best_path.write_bytes(b"candidate-with-bad-class-metadata")
        self.trainer = SimpleNamespace(best=str(self.best_path))


class FakeCandidateModel:
    task = "detect"
    names = {0: "apple", 1: "lemon"}

    def val(self, **kwargs):
        raise AssertionError("an invalid candidate must not be evaluated")


class CandidateClassPreservationTests(unittest.TestCase):
    def test_combined_dataset_missing_active_class_is_rejected_before_training(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active = root / "active.pt"
            active.write_bytes(b"unchanged-active-model")
            data_yaml = root / "data.yaml"
            data_yaml.write_text(
                "nc: 3\nnames:\n  0: apple\n  1: milk\n  2: lemon\n",
                encoding="utf-8",
            )
            training_model = FakeTrainingModel(root / "must-not-exist.pt")
            training_model.train = Mock()
            fail = Mock()
            args = SimpleNamespace(
                dataset_dir=root,
                dataset_version="invalid-combined-v1",
                starting_weights=active,
                output_root=root / "candidates",
                database_url="postgresql://unused/test",
                epochs=1,
                imgsz=64,
                batch=1,
                device="cpu",
                workers=0,
                patience=0,
                seed=0,
                verbose=False,
            )
            with (
                patch.object(trainer, "active_model_version", return_value="active-v1"),
                patch.object(trainer, "create_training_run"),
                patch.object(trainer, "complete_training_run") as complete,
                patch.object(trainer, "fail_training_run", fail),
                patch.object(
                    trainer,
                    "validate_dataset",
                    return_value=({"content_sha256": "dataset-hash"}, data_yaml),
                ),
                patch.object(trainer, "YOLO", return_value=training_model),
            ):
                with self.assertRaisesRegex(ValueError, "banana"):
                    trainer.train_candidate(args)

            training_model.train.assert_not_called()
            complete.assert_not_called()
            fail.assert_called_once()
            self.assertEqual(active.read_bytes(), b"unchanged-active-model")

    def test_candidate_missing_active_class_is_not_registered(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active = root / "active.pt"
            active.write_bytes(b"unchanged-active-model")
            data_yaml = root / "data.yaml"
            data_yaml.write_text(
                "nc: 4\nnames:\n  0: lemon\n  1: MILK\n  2: Apple\n  3: Banana\n",
                encoding="utf-8",
            )
            best = root / "fake-training" / "best.pt"
            training_model = FakeTrainingModel(best)
            candidate_model = FakeCandidateModel()
            complete = Mock()
            fail = Mock()
            args = SimpleNamespace(
                dataset_dir=root,
                dataset_version="combined-v1",
                starting_weights=active,
                output_root=root / "candidates",
                database_url="postgresql://unused/test",
                epochs=1,
                imgsz=64,
                batch=1,
                device="cpu",
                workers=0,
                patience=0,
                seed=0,
                verbose=False,
            )

            with (
                patch.object(trainer, "active_model_version", return_value="active-v1"),
                patch.object(trainer, "create_training_run"),
                patch.object(trainer, "complete_training_run", complete),
                patch.object(trainer, "fail_training_run", fail),
                patch.object(
                    trainer,
                    "validate_dataset",
                    return_value=({"content_sha256": "dataset-hash"}, data_yaml),
                ),
                patch.object(
                    trainer, "YOLO", side_effect=[training_model, candidate_model]
                ),
            ):
                with self.assertRaisesRegex(ValueError, "banana, milk"):
                    trainer.train_candidate(args)

            complete.assert_not_called()
            fail.assert_called_once()
            failed_summary = fail.call_args.args[2]
            self.assertEqual(failed_summary["status"], "failed")
            self.assertIn("banana, milk", failed_summary["error"]["message"])
            self.assertEqual(active.read_bytes(), b"unchanged-active-model")
            self.assertFalse(any((root / "candidates").rglob("candidate.pt")))


if __name__ == "__main__":
    unittest.main()
