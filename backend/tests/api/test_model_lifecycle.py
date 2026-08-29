import hashlib
import importlib
import itertools
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np
import psycopg2
import pytest
from psycopg2.extras import Json

from backend.class_aware_metrics import build_class_aware_comparison


pytestmark = [pytest.mark.integration, pytest.mark.api]


class ImmediateThread:
    def __init__(self, target, args=(), daemon=None):
        self.target = target
        self.args = args

    def start(self):
        self.target(*self.args)


class DeferredThread:
    instances = []

    def __init__(self, target, args=(), daemon=None):
        self.target = target
        self.args = args
        self.__class__.instances.append(self)

    def start(self):
        return None

    def run(self):
        self.target(*self.args)


class FakeYolo:
    metrics = {
        "precision": 0.81,
        "recall": 0.76,
        "map50": 0.79,
        "map50_95": 0.62,
    }

    def __init__(self, path):
        self.path = Path(path)
        self.task = "detect"
        self.names = {0: "Milk"}
        self.trainer = None

    def train(self, **kwargs):
        best = Path(kwargs["project"]) / kwargs["name"] / "weights" / "best.pt"
        best.parent.mkdir(parents=True, exist_ok=True)
        best.write_bytes(b"deterministic-fake-candidate-weights")
        self.trainer = SimpleNamespace(best=str(best))

    def val(self, **kwargs):
        box = SimpleNamespace(
            mp=self.metrics["precision"],
            mr=self.metrics["recall"],
            map50=self.metrics["map50"],
            map=self.metrics["map50_95"],
        )
        return SimpleNamespace(box=box)


@pytest.fixture
def lifecycle_context(
    monkeypatch, tmp_path, test_database_url, db_connection
):
    runtime = importlib.import_module("services.model_lifecycle")
    detection = runtime.detection
    schema = importlib.import_module("db.schema")
    providers = importlib.import_module("training_providers")
    trainer = importlib.import_module("train_yolo_candidate")
    comparison = importlib.import_module("compare_yolo_models")

    root = tmp_path / "lifecycle"
    uploads = root / "uploads"
    uploads.mkdir(parents=True)
    active_path = root / "active.pt"
    active_path.write_bytes(b"deterministic-fake-active-weights")
    active_hash = hashlib.sha256(active_path.read_bytes()).hexdigest()
    foundation_path = root / "foundation.pt"
    foundation_path.write_bytes(b"deterministic-fake-foundation-weights")
    foundation_hash = hashlib.sha256(foundation_path.read_bytes()).hexdigest()
    foundation_version = "yolo11s-pretrained"

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE model_versions
            SET model_path = %s, model_sha256 = %s
            WHERE status = 'active'
            RETURNING id, version;
            """,
            (str(active_path), active_hash),
        )
        active_id, active_version = cursor.fetchone()
    db_connection.commit()

    monkeypatch.setattr(runtime, "DATABASE_URL", test_database_url)
    monkeypatch.setattr(runtime, "BACKEND_DIR", root)
    monkeypatch.setattr(runtime.threading, "Thread", ImmediateThread)
    monkeypatch.setattr(providers, "DATABASE_URL", test_database_url)
    monkeypatch.setattr(providers, "BACKEND_DIR", root)
    monkeypatch.setattr(providers, "TRAINING_STARTING_WEIGHTS_PATH", foundation_path)
    monkeypatch.setattr(providers, "TRAINING_STARTING_MODEL_VERSION", foundation_version)
    monkeypatch.setattr(
        providers,
        "_prepare_local_combined_dataset",
        lambda correction_dir, dataset_version: correction_dir,
    )
    monkeypatch.setattr(trainer, "YOLO", FakeYolo)

    with runtime._LIFECYCLE_JOB_LOCK:
        runtime._LIFECYCLE_JOBS.clear()
        runtime._ACTIVE_LIFECYCLE_JOB_ID = None
    detection.MODEL = None
    detection._MODEL_VERSION = None
    detection._MODEL_PATH = None

    yield SimpleNamespace(
        runtime=runtime,
        detection=detection,
        schema=schema,
        providers=providers,
        trainer=trainer,
        comparison=comparison,
        root=root,
        uploads=uploads,
        active_id=active_id,
        active_version=active_version,
        active_path=active_path,
        active_hash=active_hash,
        foundation_path=foundation_path,
        foundation_hash=foundation_hash,
        foundation_version=foundation_version,
        database_url=test_database_url,
    )

    with runtime._LIFECYCLE_JOB_LOCK:
        runtime._LIFECYCLE_JOBS.clear()
        runtime._ACTIVE_LIFECYCLE_JOB_ID = None
    detection.MODEL = None
    detection._MODEL_VERSION = None
    detection._MODEL_PATH = None


@pytest.fixture
def submission_factory(test_client, db_connection, lifecycle_context):
    sequence = itertools.count(1)

    def create(kind, status, label):
        number = next(sequence)
        image_path = lifecycle_context.uploads / f"source-{number}.png"
        image = np.full(
            (80, 120, 3),
            (30 + number, 100 + number, 210 - number),
            dtype=np.uint8,
        )
        encoded, contents = cv2.imencode(".png", image)
        assert encoded
        image_path.write_bytes(contents.tobytes())

        source = "detector" if kind == "assisted" else "manual_annotation"
        with db_connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO scans(image_ref, image_width, image_height, source)
                VALUES (%s, 120, 80, %s)
                RETURNING id;
                """,
                (str(image_path), source),
            )
            scan_id = cursor.fetchone()[0]
            detection_id = None
            if kind == "assisted":
                cursor.execute(
                    """
                    INSERT INTO scan_detections(
                        scan_id, label, confidence, x1, y1, x2, y2
                    ) VALUES (%s, %s, 0.92, 10, 10, 60, 60)
                    RETURNING id;
                    """,
                    (scan_id, label),
                )
                detection_id = cursor.fetchone()[0]
        db_connection.commit()

        annotation = (
            {"action": "CONFIRM", "source_detection_id": detection_id}
            if kind == "assisted"
            else {
                "action": "ADD",
                "final_label": label,
                "final_x1": 15,
                "final_y1": 12,
                "final_x2": 70,
                "final_y2": 65,
            }
        )
        response = test_client.post(
            f"/scans/{scan_id}/annotation-submissions",
            json={"annotations": [annotation]},
        )
        assert response.status_code == 200
        body = response.json()
        if status != "pending":
            moderated = test_client.patch(
                f"/annotation-submissions/{body['submission']['id']}",
                json={"status": status},
            )
            assert moderated.status_code == 200
        return {
            "scan_id": scan_id,
            "submission_id": body["submission"]["id"],
            "annotation_id": body["annotations"][0]["id"],
            "action": body["annotations"][0]["action"],
            "status": status,
        }

    return create


def _active_count(connection):
    with connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM model_versions WHERE status = 'active';")
        return cursor.fetchone()[0]


def _prepare_contributions(submission_factory):
    return {
        "assisted": submission_factory("assisted", "approved", "Apple"),
        "manual": submission_factory("manual", "approved", "Milk"),
        "pending": submission_factory("assisted", "pending", "Orange"),
        "rejected": submission_factory("manual", "rejected", "Bread"),
    }


def _run_successful_training(
    test_client, lifecycle_context, submission_ids=None
):
    response = test_client.post(
        "/model-lifecycle/train",
        json={"submission_ids": submission_ids} if submission_ids is not None else None,
    )
    assert response.status_code == 200
    job = response.json()
    assert job["kind"] == "TRAIN"
    assert job["status"] == "completed"
    assert job["provider"] == "local"
    assert job["phase"] == "training_local"
    lookup = test_client.get(f"/model-lifecycle/jobs/{job['job_id']}")
    assert lookup.status_code == 200
    assert lookup.json() == job
    return job


def _evaluation(classes, overall, per_class=None):
    rows = per_class or {name: overall for name in classes}
    return {
        "classes": classes,
        "metrics": overall,
        "per_class": [
            {"name": name, **rows[name]}
            for name in classes
            if name in rows
        ],
    }


def _run_comparison(
    test_client,
    lifecycle_context,
    candidate_version,
    active_metrics,
    candidate_metrics,
    *,
    active_classes=None,
    candidate_classes=None,
    active_per_class=None,
    candidate_per_class=None,
):
    active_evaluation = _evaluation(
        active_classes or ["Apple", "Milk"], active_metrics, active_per_class
    )
    candidate_evaluation = _evaluation(
        candidate_classes or ["Apple", "Milk"],
        candidate_metrics,
        candidate_per_class,
    )

    def evaluate(_path, _data_yaml, _args, _output_dir, name):
        return active_evaluation if name == "active" else candidate_evaluation

    with patch.object(lifecycle_context.comparison, "evaluate", side_effect=evaluate):
        response = test_client.post(
            f"/model-lifecycle/candidates/{candidate_version}/compare"
        )
    assert response.status_code == 200
    return response.json()


def _run_policy_comparison(
    test_client,
    lifecycle_context,
    submission_factory,
    *,
    candidate_classes,
    shared_candidate_map50_95=0.79,
    added_map50_95=None,
    candidate_overall_map50_95=0.72,
):
    submission_factory("assisted", "approved", "Apple")
    submission_factory("manual", "approved", "Milk")
    trained = _run_successful_training(test_client, lifecycle_context)
    candidate_version = trained["result"]["model_version"]
    active_classes = ["Apple", "Banana", "Milk"]
    active_overall = {
        "precision": 0.84, "recall": 0.82, "map50": 0.86, "map50_95": 0.80
    }
    candidate_overall = {
        "precision": 0.77, "recall": 0.75, "map50": 0.79,
        "map50_95": candidate_overall_map50_95,
    }
    active_per_class = {
        name: {"precision": 0.84, "recall": 0.82, "map50": 0.86, "map50_95": 0.80}
        for name in active_classes
    }
    active_identities = {name.casefold() for name in active_classes}
    added_map50_95 = added_map50_95 or {}
    candidate_per_class = {}
    for name in candidate_classes:
        if name.casefold() in active_identities:
            candidate_per_class[name] = {
                "precision": 0.83, "recall": 0.81, "map50": 0.85,
                "map50_95": shared_candidate_map50_95,
            }
        else:
            score = added_map50_95[name]
            candidate_per_class[name] = {
                "precision": score, "recall": score, "map50": score,
                "map50_95": score,
            }
    compared = _run_comparison(
        test_client,
        lifecycle_context,
        candidate_version,
        active_overall,
        candidate_overall,
        active_classes=active_classes,
        candidate_classes=candidate_classes,
        active_per_class=active_per_class,
        candidate_per_class=candidate_per_class,
    )
    return candidate_version, compared


def test_ultralytics_per_class_rows_follow_model_class_ids(
    monkeypatch, tmp_path
):
    comparison = importlib.import_module("compare_yolo_models")

    class FakeBox:
        mp = 0.75
        mr = 0.70
        map50 = 0.78
        map = 0.60
        ap_class_index = [1, 0]

        @staticmethod
        def class_result(position):
            return (
                (0.90, 0.85, 0.88, 0.72)
                if position == 0
                else (0.60, 0.55, 0.68, 0.48)
            )

    model = SimpleNamespace(
        task="detect",
        names={0: "Milk", 1: "Apple"},
        val=lambda **_kwargs: SimpleNamespace(box=FakeBox()),
    )
    monkeypatch.setattr(comparison, "YOLO", lambda _path: model)
    model_path = tmp_path / "model.pt"
    model_path.write_bytes(b"fake")
    data_yaml = tmp_path / "data.yaml"
    data_yaml.write_text("names: {0: Milk, 1: Apple}\n", encoding="utf-8")
    output = tmp_path / "comparison"
    args = SimpleNamespace(
        imgsz=640,
        batch=2,
        device="cpu",
        workers=0,
        seed=0,
        verbose=False,
    )

    evaluated = comparison.evaluate(
        model_path, data_yaml, args, output, "candidate"
    )
    assert evaluated["classes"] == ["Milk", "Apple"]
    assert evaluated["metrics"] == pytest.approx(
        {"precision": 0.75, "recall": 0.70, "map50": 0.78, "map50_95": 0.60}
    )
    assert evaluated["per_class"] == [
        {
            "name": "Apple",
            "precision": 0.90,
            "recall": 0.85,
            "map50": 0.88,
            "map50_95": 0.72,
        },
        {
            "name": "Milk",
            "precision": 0.60,
            "recall": 0.55,
            "map50": 0.68,
            "map50_95": 0.48,
        },
    ]


def test_successful_training_records_eligibility_provenance_and_candidate(
    test_client, db_connection, lifecycle_context, submission_factory
):
    contributions = _prepare_contributions(submission_factory)
    assert _active_count(db_connection) == 1
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM training_run_submission_usage;")
        assert cursor.fetchone()[0] == 0
        cursor.execute("SELECT COUNT(*) FROM training_run_annotation_usage;")
        assert cursor.fetchone()[0] == 0

    job = _run_successful_training(test_client, lifecycle_context)
    result = job["result"]
    run_id = result["training_run_id"]
    dataset_version = result["dataset_version"]
    manifest_path = (
        lifecycle_context.root / "dataset_exports" / job["job_id"] / "manifest.json"
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    approved_ids = {
        contributions["assisted"]["submission_id"],
        contributions["manual"]["submission_id"],
    }
    assert set(manifest["included_submission_ids"]) == approved_ids
    assert manifest["source_submission_status"] == "approved"

    with db_connection.cursor() as cursor:
        cursor.execute("SELECT * FROM training_runs WHERE id = %s;", (run_id,))
        columns = [column.name for column in cursor.description]
        run = dict(zip(columns, cursor.fetchone()))
        cursor.execute(
            "SELECT * FROM model_versions WHERE training_run_id = %s;", (run_id,)
        )
        columns = [column.name for column in cursor.description]
        candidate = dict(zip(columns, cursor.fetchone()))
        cursor.execute(
            """
            SELECT submission_id, dataset_version, model_version_id
            FROM training_run_submission_usage
            WHERE training_run_id = %s ORDER BY submission_id;
            """,
            (run_id,),
        )
        submission_usage = cursor.fetchall()
        cursor.execute(
            """
            SELECT annotation_id, submission_id, dataset_version, model_version_id
            FROM training_run_annotation_usage
            WHERE training_run_id = %s ORDER BY annotation_id;
            """,
            (run_id,),
        )
        annotation_usage = cursor.fetchall()
        cursor.execute(
            """
            SELECT COUNT(*), COUNT(DISTINCT submission_id)
            FROM training_run_submission_usage WHERE training_run_id = %s;
            """,
            (run_id,),
        )
        assert cursor.fetchone() == (2, 2)

    assert run["dataset_version"] == dataset_version
    assert run["starting_model_version"] == lifecycle_context.foundation_version
    assert Path(run["starting_weights_path"]) == lifecycle_context.foundation_path
    assert run["starting_weights_sha256"] == lifecycle_context.foundation_hash
    assert run["training_parameters"] == {
        "epochs": 30,
        "imgsz": 640,
        "batch": 8,
        "device": "cpu",
        "workers": 0,
        "patience": 10,
        "seed": 0,
        "deterministic": True,
        "comparison_active_model_version": lifecycle_context.active_version,
    }
    assert run["status"] == "completed"
    assert run["ended_at"] is not None
    assert Path(run["candidate_model_path"]).is_file()
    assert (run["precision"], run["recall"], run["map50"], run["map50_95"]) == pytest.approx(
        (0.81, 0.76, 0.79, 0.62)
    )

    assert candidate["status"] == "candidate"
    assert candidate["dataset_version"] == dataset_version
    assert candidate["training_run_id"] == run_id
    assert candidate["model_path"] == run["candidate_model_path"]
    assert candidate["model_sha256"] == hashlib.sha256(
        Path(candidate["model_path"]).read_bytes()
    ).hexdigest()
    assert _active_count(db_connection) == 1

    assert {row[0] for row in submission_usage} == approved_ids
    assert all(row[1] == dataset_version and row[2] == candidate["id"] for row in submission_usage)
    expected_annotations = {
        contributions["assisted"]["annotation_id"],
        contributions["manual"]["annotation_id"],
    }
    assert {row[0] for row in annotation_usage} == expected_annotations
    assert {row[1] for row in annotation_usage} == approved_ids
    assert all(row[2] == dataset_version and row[3] == candidate["id"] for row in annotation_usage)
    assert contributions["pending"]["submission_id"] not in {row[0] for row in submission_usage}
    assert contributions["rejected"]["submission_id"] not in {row[0] for row in submission_usage}

    for key in ("assisted", "manual"):
        detail = test_client.get(
            f"/annotation-submissions/{contributions[key]['submission_id']}"
        ).json()
        assert detail["submission"]["status"] == "approved"
        assert detail["submission"]["training_status"] == "used"
        assert detail["submission"]["training_usages"][0]["training_run_id"] == run_id

    progress = test_client.get("/ai-progress")
    assert progress.status_code == 200
    body = progress.json()
    assert body["active_model"]["id"] == lifecycle_context.active_id
    assert body["latest_candidate"]["id"] == candidate["id"]
    assert body["candidate"] == body["latest_candidate"]
    assert body["candidate_state"] == "needs_comparison"
    assert body["comparison"] is None
    assert body["model_display_names"] == {
        lifecycle_context.active_version: "Initial Model",
        candidate["version"]: "Model 2",
    }
    assert body["contributions"] == {
        "total_approved": 2,
        "used_in_training": 2,
        "approved_waiting": 0,
    }
    assert body["training_history"][0]["status"] == "completed"
    assert body["training_history"][0]["submission_count"] == 2
    assert body["training_history"][0]["annotation_count"] == 2
    assert body["actions"]["can_train"] is False
    assert body["actions"]["can_compare"] is True
    assert body["actions"]["can_promote"] is False
    assert body["promotion_evaluation"]["eligible"] is False
    assert body["promotion_evaluation"]["reasons"][0]["code"] == "comparison_missing"


def test_ai_progress_clearly_reports_no_candidate(test_client, lifecycle_context):
    progress = test_client.get("/ai-progress")
    assert progress.status_code == 200
    body = progress.json()
    assert body["active_model"] == {
        "id": lifecycle_context.active_id,
        "version": lifecycle_context.active_version,
        "status": "active",
        "created_at": body["active_model"]["created_at"],
        "dataset_version": None,
        "training_run_id": None,
        "precision": None,
        "recall": None,
        "map50": None,
        "map50_95": None,
    }
    assert body["candidate"] is None
    assert body["latest_candidate"] is None
    assert body["candidate_state"] == "none"
    assert body["active_model_classes"] == {
        "available": False,
        "count": 0,
        "classes": [],
    }
    assert body["rollback_targets"] == []


def test_failed_training_preserves_active_model_and_has_no_usage(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    approved = submission_factory("assisted", "approved", "Apple")
    submission_factory("manual", "approved", "Milk")

    class FailingYolo:
        def __init__(self, _path):
            raise RuntimeError("deterministic training failure")

    monkeypatch.setattr(lifecycle_context.trainer, "YOLO", FailingYolo)
    response = test_client.post("/model-lifecycle/train")
    assert response.status_code == 200
    job = response.json()
    assert job["status"] == "failed"
    assert job["error"] == {
        "type": "RuntimeError",
        "message": "deterministic training failure",
    }
    lookup = test_client.get(f"/model-lifecycle/jobs/{job['job_id']}")
    assert lookup.status_code == 200
    assert lookup.json()["status"] == "failed"

    with db_connection.cursor() as cursor:
        cursor.execute("SELECT * FROM training_runs;")
        columns = [column.name for column in cursor.description]
        run = dict(zip(columns, cursor.fetchone()))
        cursor.execute("SELECT COUNT(*) FROM model_versions WHERE status = 'candidate';")
        assert cursor.fetchone()[0] == 0
        cursor.execute("SELECT COUNT(*) FROM training_run_submission_usage;")
        assert cursor.fetchone()[0] == 0
        cursor.execute("SELECT COUNT(*) FROM training_run_annotation_usage;")
        assert cursor.fetchone()[0] == 0
        cursor.execute(
            "SELECT status, training_state FROM annotation_submissions ORDER BY id;"
        )
        submission_states = cursor.fetchall()
        assert len(submission_states) == 2
        assert set(submission_states) == {("approved", "eligible")}
    assert run["status"] == "failed"
    assert run["ended_at"] is not None
    assert run["candidate_model_path"] is None
    assert run["error"]["type"] == "RuntimeError"
    assert "deterministic training failure" in run["error"]["message"]
    assert _active_count(db_connection) == 1


def test_provider_failure_leaves_selected_submissions_eligible(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    selected = submission_factory("manual", "approved", "Lemon")
    monkeypatch.setattr(
        lifecycle_context.providers,
        "training_provider",
        lambda _name: lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("Kaggle denied access to kernels. Check account permissions.")
        ),
    )

    response = test_client.post(
        "/model-lifecycle/train",
        json={"submission_ids": [selected["submission_id"]]},
    )
    assert response.status_code == 200
    job = response.json()
    assert job["status"] == "failed"
    assert job["error"]["message"] == (
        "Kaggle denied access to kernels. Check account permissions."
    )
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM model_versions WHERE status = 'candidate';")
        assert cursor.fetchone()[0] == 0
        cursor.execute(
            "SELECT status, training_state FROM annotation_submissions WHERE id = %s;",
            (selected["submission_id"],),
        )
        assert cursor.fetchone() == ("approved", "eligible")
    assert _active_count(db_connection) == 1


def test_ai_progress_is_read_only(
    test_client, db_connection, lifecycle_context, submission_factory
):
    contribution = submission_factory("manual", "approved", "Milk")
    submission_factory("manual", "approved", "Apple")
    trained = _run_successful_training(test_client, lifecycle_context)
    candidate_version = trained["result"]["model_version"]
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT status FROM model_versions WHERE version = %s;",
            (candidate_version,),
        )
        model_status_before = cursor.fetchone()[0]
        cursor.execute(
            "SELECT status, training_state FROM annotation_submissions WHERE id = %s;",
            (contribution["submission_id"],),
        )
        submission_before = cursor.fetchone()

    with patch.object(
        lifecycle_context.runtime,
        "reject_model",
        side_effect=AssertionError("GET /ai-progress attempted a lifecycle mutation"),
    ) as reject:
        assert test_client.get("/ai-progress").status_code == 200
        assert test_client.get("/ai-progress").status_code == 200
    reject.assert_not_called()

    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT status FROM model_versions WHERE version = %s;",
            (candidate_version,),
        )
        assert cursor.fetchone()[0] == model_status_before == "candidate"
        cursor.execute(
            "SELECT status, training_state FROM annotation_submissions WHERE id = %s;",
            (contribution["submission_id"],),
        )
        assert cursor.fetchone() == submission_before == ("approved", "experimental")


def test_lifecycle_job_queue_lookup_and_conflict_are_deterministic(
    test_client, lifecycle_context, submission_factory, monkeypatch
):
    submission_factory("manual", "approved", "Milk")
    DeferredThread.instances.clear()
    monkeypatch.setattr(lifecycle_context.runtime.threading, "Thread", DeferredThread)
    monkeypatch.setattr(
        lifecycle_context.providers,
        "training_provider",
        lambda _name: lambda job_id, progress: {"training_run_id": job_id},
    )

    queued = test_client.post("/model-lifecycle/train")
    assert queued.status_code == 200
    job = queued.json()
    assert job["status"] == "queued"
    assert test_client.get(f"/model-lifecycle/jobs/{job['job_id']}").json()["status"] == "queued"
    assert test_client.get("/model-lifecycle/jobs/not-a-job").status_code == 404

    conflict = test_client.post("/model-lifecycle/train")
    assert conflict.status_code == 409
    assert "already running" in conflict.json()["detail"]

    assert len(DeferredThread.instances) == 1
    DeferredThread.instances[0].run()
    completed = test_client.get(f"/model-lifecycle/jobs/{job['job_id']}")
    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"


@pytest.mark.parametrize(
    ("active_metrics", "candidate_metrics", "outperforms"),
    [
        (
            {"precision": 0.70, "recall": 0.68, "map50": 0.72, "map50_95": 0.55},
            {"precision": 0.78, "recall": 0.75, "map50": 0.80, "map50_95": 0.63},
            True,
        ),
        (
            {"precision": 0.80, "recall": 0.78, "map50": 0.82, "map50_95": 0.66},
            {"precision": 0.76, "recall": 0.73, "map50": 0.79, "map50_95": 0.61},
            False,
        ),
    ],
)
def test_comparison_persists_fingerprints_metrics_and_decision(
    test_client,
    db_connection,
    lifecycle_context,
    submission_factory,
    active_metrics,
    candidate_metrics,
    outperforms,
):
    submission_factory("assisted", "approved", "Apple")
    submission_factory("manual", "approved", "Milk")
    trained = _run_successful_training(test_client, lifecycle_context)
    candidate_version = trained["result"]["model_version"]
    compared = _run_comparison(
        test_client,
        lifecycle_context,
        candidate_version,
        active_metrics,
        candidate_metrics,
    )
    assert compared["status"] == "completed"
    assert compared["result"]["candidate_outperforms_active"] is outperforms
    comparison_id = compared["result"]["comparison_id"]

    with db_connection.cursor() as cursor:
        cursor.execute("SELECT * FROM model_comparisons WHERE id = %s;", (comparison_id,))
        columns = [column.name for column in cursor.description]
        row = dict(zip(columns, cursor.fetchone()))
        cursor.execute(
            "SELECT id, dataset_version FROM model_versions WHERE version = %s;",
            (candidate_version,),
        )
        candidate_id, dataset_version = cursor.fetchone()

    assert row["active_model_id"] == lifecycle_context.active_id
    assert row["candidate_model_id"] == candidate_id
    assert row["dataset_version"] == dataset_version
    assert len(row["dataset_content_sha256"]) == 64
    assert len(row["validation_split_sha256"]) == 64
    assert row["evaluation_parameters"] == {
        "split": "val",
        "imgsz": 640,
        "batch": 8,
        "device": "cpu",
        "workers": 0,
        "seed": 0,
        "deterministic": True,
    }
    assert row["active_metrics"] == active_metrics
    assert row["candidate_metrics"] == candidate_metrics
    assert row["metric_differences"] == pytest.approx(
        {key: candidate_metrics[key] - active_metrics[key] for key in active_metrics}
    )
    assert row["class_comparison"] == {
        "active_classes": ["Apple", "Milk"],
        "candidate_classes": ["Apple", "Milk"],
        "shared_classes": ["Apple", "Milk"],
        "added_classes": [],
        "removed_classes": [],
    }
    assert row["shared_class_comparison"]["available"] is True
    assert row["shared_class_comparison"]["classes"] == ["Apple", "Milk"]
    assert row["added_class_metrics"]["available"] is False
    assert row["added_class_metrics"]["classes"] == []
    assert "candidate map50_95" in row["comparison_rule"]
    assert row["candidate_outperforms_active"] is outperforms
    assert _active_count(db_connection) == 1

    decision = compared["result"]["promotion_evaluation"]
    assert decision["mode"] == "same_classes"
    assert decision["eligible"] is outperforms
    assert compared["result"]["auto_rejected"] is False
    assert [reason["code"] for reason in decision["reasons"]] == (
        [] if outperforms else ["candidate_lost"]
    )
    progress = test_client.get("/ai-progress").json()
    assert progress["actions"]["can_promote"] is outperforms
    assert progress["candidate_state"] == (
        "eligible" if outperforms else "not_eligible"
    )
    assert progress["comparison"] is not None


def test_losing_candidate_blocks_training_until_explicit_rejection(
    test_client, db_connection, lifecycle_context, submission_factory
):
    selected = [
        submission_factory("assisted", "approved", "Apple"),
        submission_factory("manual", "approved", "Milk"),
    ]
    trained = _run_successful_training(test_client, lifecycle_context)
    candidate_version = trained["result"]["model_version"]

    # Reconciliation (including the startup path) must retain the unresolved
    # candidate's selected data as experimental.
    lifecycle_context.schema.ensure_schema()
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT training_state FROM annotation_submissions WHERE id = ANY(%s);",
            ([item["submission_id"] for item in selected],),
        )
        assert {row[0] for row in cursor.fetchall()} == {"experimental"}
    db_connection.commit()

    blocked = test_client.post("/model-lifecycle/train")
    assert blocked.status_code == 409
    assert "must be promoted or rejected" in blocked.json()["detail"]
    with pytest.raises(psycopg2.errors.UniqueViolation):
        with psycopg2.connect(lifecycle_context.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO model_versions(version, model_path, status) VALUES ('duplicate-candidate', 'duplicate.pt', 'candidate');"
                )

    compared = _run_comparison(
        test_client,
        lifecycle_context,
        candidate_version,
        {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.7},
        {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.6},
    )
    assert compared["result"]["promotion_evaluation"]["reasons"][0]["code"] == "candidate_lost"
    assert compared["result"]["auto_rejected"] is False
    assert test_client.get("/ai-progress").json()["latest_candidate"]["version"] == candidate_version

    rejected = test_client.post(f"/models/{candidate_version}/reject")
    assert rejected.status_code == 200
    assert rejected.json()["quarantined_submission_count"] == 2
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT status FROM model_versions WHERE version = %s;", (candidate_version,))
        assert cursor.fetchone()[0] == "rejected"
        cursor.execute(
            "SELECT training_state FROM annotation_submissions WHERE id = ANY(%s) ORDER BY id;",
            ([item["submission_id"] for item in selected],),
        )
        assert {row[0] for row in cursor.fetchall()} == {"quarantined"}
    next_selected = [
        submission_factory("assisted", "approved", "Lemon")["submission_id"],
        submission_factory("manual", "approved", "Milk")["submission_id"],
    ]
    next_training = _run_successful_training(test_client, lifecycle_context, next_selected)
    assert next_training["status"] == "completed"


@pytest.mark.parametrize(
    ("active_classes", "candidate_classes", "expected"),
    [
        (
            ["Apple", "Banana", "Milk"],
            ["Milk", "Apple", "Banana", "Cheese"],
            {
                "shared_classes": ["Apple", "Banana", "Milk"],
                "added_classes": ["Cheese"],
                "removed_classes": [],
            },
        ),
        (
            ["Apple", "Banana", "Milk"],
            ["Apple", "Milk"],
            {
                "shared_classes": ["Apple", "Milk"],
                "added_classes": [],
                "removed_classes": ["Banana"],
            },
        ),
    ],
)
def test_class_sets_are_persisted_by_semantic_name_not_numeric_order(
    test_client,
    db_connection,
    lifecycle_context,
    submission_factory,
    active_classes,
    candidate_classes,
    expected,
):
    submission_factory("assisted", "approved", "Apple")
    submission_factory("manual", "approved", "Milk")
    trained = _run_successful_training(test_client, lifecycle_context)
    candidate_version = trained["result"]["model_version"]
    overall = {"precision": 0.75, "recall": 0.74, "map50": 0.76, "map50_95": 0.60}
    compared = _run_comparison(
        test_client,
        lifecycle_context,
        candidate_version,
        overall,
        overall,
        active_classes=active_classes,
        candidate_classes=candidate_classes,
    )
    assert compared["status"] == "completed"
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT class_comparison FROM model_comparisons WHERE id = %s;",
            (compared["result"]["comparison_id"],),
        )
        class_comparison = cursor.fetchone()[0]
    assert class_comparison["active_classes"] == active_classes
    assert class_comparison["candidate_classes"] == candidate_classes
    for field, value in expected.items():
        assert class_comparison[field] == value
    assert _active_count(db_connection) == 1


def test_expanded_candidate_records_shared_regression_and_added_class_quality(
    test_client, db_connection, lifecycle_context, submission_factory
):
    submission_factory("assisted", "approved", "Apple")
    submission_factory("manual", "approved", "Milk")
    trained = _run_successful_training(test_client, lifecycle_context)
    candidate_version = trained["result"]["model_version"]
    active_classes = ["Apple", "Banana", "Milk"]
    candidate_classes = ["Apple", "Banana", "Milk", "Cheese", "Orange"]
    active_overall = {"precision": 0.84, "recall": 0.82, "map50": 0.86, "map50_95": 0.80}
    candidate_overall = {"precision": 0.77, "recall": 0.75, "map50": 0.79, "map50_95": 0.72}
    active_per_class = {
        name: {"precision": 0.84, "recall": 0.82, "map50": 0.86, "map50_95": 0.80}
        for name in active_classes
    }
    candidate_per_class = {
        name: {"precision": 0.83, "recall": 0.81, "map50": 0.85, "map50_95": 0.79}
        for name in active_classes
    }
    candidate_per_class.update(
        {
            "Cheese": {"precision": 0.70, "recall": 0.64, "map50": 0.68, "map50_95": 0.45},
            "Orange": {"precision": 0.42, "recall": 0.31, "map50": 0.35, "map50_95": 0.12},
        }
    )
    compared = _run_comparison(
        test_client,
        lifecycle_context,
        candidate_version,
        active_overall,
        candidate_overall,
        active_classes=active_classes,
        candidate_classes=candidate_classes,
        active_per_class=active_per_class,
        candidate_per_class=candidate_per_class,
    )
    assert compared["status"] == "completed"
    assert compared["result"]["candidate_outperforms_active"] is False
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT metric_differences, class_comparison,
                   shared_class_comparison, added_class_metrics
            FROM model_comparisons WHERE id = %s;
            """,
            (compared["result"]["comparison_id"],),
        )
        overall_delta, classes, shared, added = cursor.fetchone()

    assert overall_delta["map50_95"] == pytest.approx(-0.08)
    assert classes["shared_classes"] == active_classes
    assert classes["added_classes"] == ["Cheese", "Orange"]
    assert classes["removed_classes"] == []
    assert shared["available"] is True
    assert shared["classes"] == active_classes
    assert shared["active_metrics"]["map50_95"] == pytest.approx(0.80)
    assert shared["candidate_metrics"]["map50_95"] == pytest.approx(0.79)
    assert shared["metric_differences"]["map50_95"] == pytest.approx(-0.01)
    assert added["available"] is True
    assert added["classes"] == ["Cheese", "Orange"]
    assert added["aggregate"] == pytest.approx(
        {"precision": 0.56, "recall": 0.475, "map50": 0.515, "map50_95": 0.285}
    )
    assert added["per_class"]["Cheese"]["map50_95"] == pytest.approx(0.45)
    assert added["per_class"]["Orange"]["map50_95"] == pytest.approx(0.12)

    assert compared["result"]["auto_rejected"] is True
    assert compared["result"]["promotion_evaluation"]["eligible"] is False


@pytest.mark.parametrize("invalid_metric", [float("nan"), float("inf"), float("-inf"), "0.5"])
def test_class_aware_metrics_reject_non_finite_and_non_numeric_values(invalid_metric):
    valid = {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.8}
    invalid = {**valid, "map50_95": invalid_metric}
    with pytest.raises(ValueError):
        build_class_aware_comparison(
            _evaluation(["Apple"], valid),
            _evaluation(["Apple"], valid, {"Apple": invalid}),
        )


@pytest.mark.parametrize(
    "candidate_evaluation",
    [
        {"classes": ["Apple", " apple "], "per_class": []},
        {"classes": ["Apple", ""], "per_class": []},
        {
            "classes": ["Apple"],
            "per_class": [{"name": "Cheese", "precision": 0.5, "recall": 0.5, "map50": 0.5, "map50_95": 0.5}],
        },
        {
            "classes": ["Apple"],
            "per_class": [{"name": "Apple", "precision": 0.5, "recall": 0.5, "map50": 0.5}],
        },
    ],
)
def test_class_metadata_and_required_metrics_are_strictly_validated(candidate_evaluation):
    valid = {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.8}
    with pytest.raises(ValueError):
        build_class_aware_comparison(
            _evaluation(["Apple"], valid), candidate_evaluation
        )


def test_remote_class_aware_artifact_must_match_declared_model_metadata(
    lifecycle_context
):
    active_metrics = {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.8}
    candidate_metrics = {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.6}
    active_evaluation = _evaluation(["Apple", "Banana"], active_metrics)
    candidate_evaluation = _evaluation(
        ["Banana", "Apple", "Cheese"], candidate_metrics
    )
    class_aware = build_class_aware_comparison(
        active_evaluation, candidate_evaluation
    )
    artifact = {
        "active_model": {
            "classes": active_evaluation["classes"],
            "per_class": active_evaluation["per_class"],
        },
        "candidate_model": {
            "classes": candidate_evaluation["classes"],
            "per_class": candidate_evaluation["per_class"],
        },
        **class_aware,
    }
    assert lifecycle_context.providers._remote_class_aware_comparison(artifact) == class_aware

    artifact["class_comparison"] = {
        **artifact["class_comparison"],
        "added_classes": ["Orange"],
    }
    with pytest.raises(
        lifecycle_context.providers.ProviderError, match="disagrees"
    ):
        lifecycle_context.providers._remote_class_aware_comparison(artifact)


def test_invalid_comparison_metrics_are_not_persisted(
    test_client, db_connection, lifecycle_context, submission_factory
):
    submission_factory("assisted", "approved", "Apple")
    submission_factory("manual", "approved", "Milk")
    trained = _run_successful_training(test_client, lifecycle_context)
    candidate_version = trained["result"]["model_version"]
    valid = {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.7}
    invalid = {**valid, "map50_95": float("nan")}

    compared = _run_comparison(
        test_client, lifecycle_context, candidate_version, valid, invalid
    )
    assert compared["status"] == "failed"
    assert compared["error"]["type"] == "ValueError"
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM model_comparisons;")
        assert cursor.fetchone()[0] == 0
    assert _active_count(db_connection) == 1


def test_promotion_and_rollback_preserve_single_active_and_history(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    apple = submission_factory("assisted", "approved", "Apple")
    milk = submission_factory("manual", "approved", "Milk")
    submission_ids = [apple["submission_id"], milk["submission_id"]]
    trained = _run_successful_training(test_client, lifecycle_context)
    candidate_version = trained["result"]["model_version"]
    active_metrics = {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.5}
    candidate_metrics = {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.6}
    compared = _run_comparison(
        test_client,
        lifecycle_context,
        candidate_version,
        active_metrics,
        candidate_metrics,
        active_classes=["Apple", "Milk"],
        candidate_classes=["Apple", "Milk", "Lemon"],
    )
    comparison_id = compared["result"]["comparison_id"]

    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (SimpleNamespace(task="detect"), str(Path(record["model_path"]).resolve())),
    )
    promoted = test_client.post(
        f"/models/{candidate_version}/promote", json={"comparison_id": comparison_id}
    )
    assert promoted.status_code == 200
    assert promoted.json()["previous_active_version"] == lifecycle_context.active_version
    assert promoted.json()["active_version"] == candidate_version
    assert _active_count(db_connection) == 1

    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, version, status FROM model_versions ORDER BY id;"
        )
        models = {row[1]: (row[0], row[2]) for row in cursor.fetchall()}
        cursor.execute(
            "SELECT action, from_model_id, to_model_id, comparison_id FROM model_activation_history;"
        )
        promotion = cursor.fetchone()
    assert models[lifecycle_context.active_version][1] == "archived"
    assert models[candidate_version][1] == "active"
    assert promotion == (
        "PROMOTE",
        lifecycle_context.active_id,
        models[candidate_version][0],
        comparison_id,
    )
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, training_state FROM annotation_submissions WHERE id = ANY(%s);",
            (submission_ids,),
        )
        promoted_states = dict(cursor.fetchall())
        cursor.execute("SELECT COUNT(*) FROM model_versions;")
        model_count = cursor.fetchone()[0]
        cursor.execute("SELECT COUNT(*) FROM training_runs;")
        training_run_count = cursor.fetchone()[0]
        cursor.execute(
            "SELECT id, model_path, model_sha256 FROM model_versions WHERE version = %s;",
            (candidate_version,),
        )
        candidate_identity = cursor.fetchone()
    assert set(promoted_states.values()) == {"trusted"}

    rolled_back = test_client.post(
        f"/models/{lifecycle_context.active_version}/rollback"
    )
    assert rolled_back.status_code == 200
    assert rolled_back.json()["previous_active_version"] == candidate_version
    assert rolled_back.json()["active_version"] == lifecycle_context.active_version
    assert _active_count(db_connection) == 1
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT version, status FROM model_versions ORDER BY id;"
        )
        statuses = dict(cursor.fetchall())
        cursor.execute(
            """
            SELECT action, from_model_id, to_model_id, comparison_id
            FROM model_activation_history ORDER BY id;
            """
        )
        history = cursor.fetchall()
    assert statuses[lifecycle_context.active_version] == "active"
    assert statuses[candidate_version] == "archived"
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, training_state FROM annotation_submissions WHERE id = ANY(%s);",
            (submission_ids,),
        )
        rolled_back_states = dict(cursor.fetchall())
    assert set(rolled_back_states.values()) == {"eligible"}
    assert history[1] == (
        "ROLLBACK",
        models[candidate_version][0],
        lifecycle_context.active_id,
        None,
    )
    db_connection.commit()

    historical_provenance = {
        "dataset_version": "historical-initial-vs-lemon",
        "dataset_content_sha256": "historical-content-hash",
        "validation_split_sha256": "historical-validation-hash",
        "evaluation_parameters": {
            "provider": "historical",
            "split": "validation-from-original-comparison",
        },
    }
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE model_comparisons
            SET dataset_version = %s,
                dataset_content_sha256 = %s,
                validation_split_sha256 = %s,
                evaluation_parameters = %s
            WHERE id = %s;
            """,
            (
                historical_provenance["dataset_version"],
                historical_provenance["dataset_content_sha256"],
                historical_provenance["validation_split_sha256"],
                Json(historical_provenance["evaluation_parameters"]),
                comparison_id,
            ),
        )
        cursor.execute("SELECT COUNT(*) FROM model_comparisons;")
        comparison_count_before_lookup = cursor.fetchone()[0]
        cursor.execute(
            "SELECT version, status FROM model_versions ORDER BY id;"
        )
        statuses_before_lookup = cursor.fetchall()
        cursor.execute(
            "SELECT id, training_state FROM annotation_submissions ORDER BY id;"
        )
        annotation_states_before_lookup = cursor.fetchall()
    db_connection.commit()
    with lifecycle_context.runtime._LIFECYCLE_JOB_LOCK:
        jobs_before_lookup = dict(lifecycle_context.runtime._LIFECYCLE_JOBS)

    with (
        patch.object(
            lifecycle_context.runtime,
            "_dataset_directory",
            side_effect=AssertionError("historical cache lookup must not inspect datasets"),
        ),
        patch.object(
            lifecycle_context.comparison,
            "compare",
            side_effect=AssertionError("historical cache lookup must not evaluate models"),
        ),
    ):
        cached = test_client.get(
            f"/model-lifecycle/rollback-targets/{candidate_version}/compare"
        )

    assert cached.status_code == 200
    result = cached.json()
    assert result["available"] is True
    assert result["comparison"]["comparison_id"] == comparison_id
    assert result["comparison"]["active_model"]["version"] == lifecycle_context.active_version
    assert result["comparison"]["rollback_target"]["version"] == candidate_version
    for field, value in historical_provenance.items():
        assert result["comparison"][field] == value
    assert result["comparison"]["class_comparison"]["only_in_rollback_target"] == ["Lemon"]

    with lifecycle_context.runtime._LIFECYCLE_JOB_LOCK:
        assert lifecycle_context.runtime._LIFECYCLE_JOBS == jobs_before_lookup
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM model_comparisons;")
        assert cursor.fetchone()[0] == comparison_count_before_lookup
        cursor.execute("SELECT version, status FROM model_versions ORDER BY id;")
        assert cursor.fetchall() == statuses_before_lookup
        cursor.execute(
            "SELECT id, training_state FROM annotation_submissions ORDER BY id;"
        )
        assert cursor.fetchall() == annotation_states_before_lookup
    db_connection.commit()

    # Startup reconciliation must be idempotent and must not trust data merely
    # because its former model still exists in archived history.
    lifecycle_context.schema.ensure_schema()
    lifecycle_context.schema.ensure_schema()
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, training_state FROM annotation_submissions WHERE id = ANY(%s);",
            (submission_ids,),
        )
        startup_states = dict(cursor.fetchall())
    assert set(startup_states.values()) == {"eligible"}

    exporter = importlib.import_module("export_yolo_dataset")
    exported_submissions, _, _ = exporter.fetch_export_rows(
        db_connection, selected_submission_ids=submission_ids
    )
    assert {row["submission_id"] for row in exported_submissions} == set(submission_ids)
    db_connection.commit()

    # Reactivation reuses the exact archived artifact and provenance. Repeated
    # switches only append activation history; they never retrain or clone it.
    for expected_state in ("trusted", "eligible", "trusted"):
        target_version = (
            candidate_version
            if expected_state == "trusted"
            else lifecycle_context.active_version
        )
        reactivated = test_client.post(f"/models/{target_version}/rollback")
        assert reactivated.status_code == 200
        with db_connection.cursor() as cursor:
            cursor.execute(
                "SELECT training_state FROM annotation_submissions WHERE id = ANY(%s);",
                (submission_ids,),
            )
            assert {row[0] for row in cursor.fetchall()} == {expected_state}

    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM model_versions;")
        assert cursor.fetchone()[0] == model_count
        cursor.execute("SELECT COUNT(*) FROM training_runs;")
        assert cursor.fetchone()[0] == training_run_count
        cursor.execute(
            "SELECT id, model_path, model_sha256, status FROM model_versions WHERE version = %s;",
            (candidate_version,),
        )
        final_candidate = cursor.fetchone()
        cursor.execute("SELECT COUNT(*) FROM model_versions WHERE status = 'candidate';")
        assert cursor.fetchone()[0] == 0
        cursor.execute("SELECT COUNT(*) FROM model_activation_history;")
        assert cursor.fetchone()[0] == 5
    assert final_candidate[:3] == candidate_identity
    assert final_candidate[3] == "active"
    assert _active_count(db_connection) == 1


def test_rollback_reconciles_shared_and_model_specific_training_lineage(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    apple = submission_factory("assisted", "approved", "Apple")
    milk = submission_factory("manual", "approved", "Milk")
    shared_ids = {apple["submission_id"], milk["submission_id"]}
    first = _run_successful_training(test_client, lifecycle_context)
    first_version = first["result"]["model_version"]
    metrics_before = {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.5}
    metrics_after = {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.6}
    first_comparison = _run_comparison(
        test_client, lifecycle_context, first_version, metrics_before, metrics_after
    )
    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (
            SimpleNamespace(task="detect"),
            str(Path(record["model_path"]).resolve()),
        ),
    )
    assert test_client.post(
        f"/models/{first_version}/promote",
        json={"comparison_id": first_comparison["result"]["comparison_id"]},
    ).status_code == 200

    lemon = submission_factory("manual", "approved", "Lemon")
    lemon_id = lemon["submission_id"]
    second = _run_successful_training(test_client, lifecycle_context, [lemon_id])
    second_version = second["result"]["model_version"]
    second_comparison = _run_comparison(
        test_client, lifecycle_context, second_version, metrics_before, metrics_after
    )
    assert test_client.post(
        f"/models/{second_version}/promote",
        json={"comparison_id": second_comparison["result"]["comparison_id"]},
    ).status_code == 200

    all_ids = sorted(shared_ids | {lemon_id})
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, training_state FROM annotation_submissions WHERE id = ANY(%s);",
            (all_ids,),
        )
        assert set(dict(cursor.fetchall()).values()) == {"trusted"}
        cursor.execute(
            "SELECT training_run_id, submission_id, is_experimental FROM training_run_submission_usage ORDER BY training_run_id, submission_id;"
        )
        original_provenance = cursor.fetchall()
        cursor.execute("SELECT COUNT(*) FROM model_versions;")
        original_model_count = cursor.fetchone()[0]
        cursor.execute("SELECT COUNT(*) FROM training_runs;")
        original_run_count = cursor.fetchone()[0]
    db_connection.commit()

    assert test_client.post(f"/models/{first_version}/rollback").status_code == 200
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, training_state FROM annotation_submissions WHERE id = ANY(%s);",
            (all_ids,),
        )
        first_lineage_states = dict(cursor.fetchall())
    assert {first_lineage_states[value] for value in shared_ids} == {"trusted"}
    assert first_lineage_states[lemon_id] == "eligible"
    db_connection.commit()

    assert test_client.post(f"/models/{second_version}/rollback").status_code == 200
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, training_state FROM annotation_submissions WHERE id = ANY(%s);",
            (all_ids,),
        )
        assert set(dict(cursor.fetchall()).values()) == {"trusted"}
        cursor.execute(
            "SELECT training_run_id, submission_id, is_experimental FROM training_run_submission_usage ORDER BY training_run_id, submission_id;"
        )
        assert cursor.fetchall() == original_provenance
        cursor.execute("SELECT COUNT(*) FROM model_versions;")
        assert cursor.fetchone()[0] == original_model_count
        cursor.execute("SELECT COUNT(*) FROM training_runs;")
        assert cursor.fetchone()[0] == original_run_count
    assert _active_count(db_connection) == 1


def test_ai_progress_rollback_targets_and_comparison_are_pair_safe_and_reusable(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    submission_factory("assisted", "approved", "Apple")
    submission_factory("manual", "approved", "Milk")
    trained = _run_successful_training(test_client, lifecycle_context)
    active_version = trained["result"]["model_version"]
    active_metrics = {
        "precision": 0.72, "recall": 0.71, "map50": 0.74, "map50_95": 0.55
    }
    candidate_metrics = {
        "precision": 0.82, "recall": 0.80, "map50": 0.84, "map50_95": 0.66
    }
    promoted_comparison = _run_comparison(
        test_client,
        lifecycle_context,
        active_version,
        active_metrics,
        candidate_metrics,
        active_classes=["Apple", "Milk"],
        candidate_classes=["Apple", "Milk", "Yogurt"],
        active_per_class={
            name: active_metrics for name in ["Apple", "Milk"]
        },
        candidate_per_class={
            name: candidate_metrics for name in ["Apple", "Milk", "Yogurt"]
        },
    )
    promoted_comparison_id = promoted_comparison["result"]["comparison_id"]
    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (
            SimpleNamespace(task="detect"),
            str(Path(record["model_path"]).resolve()),
        ),
    )
    promoted = test_client.post(
        f"/models/{active_version}/promote",
        json={"comparison_id": promoted_comparison_id},
    )
    assert promoted.status_code == 200

    unused_path = lifecycle_context.root / "unused-model.pt"
    unused_path.write_bytes(b"unused")
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO model_versions(version, model_path, status)
            VALUES ('arbitrary-archive', %s, 'archived'),
                   ('never-production-rejected', %s, 'rejected'),
                   ('unresolved-candidate', %s, 'candidate');
            """,
            (str(unused_path), str(unused_path), str(unused_path)),
        )
    db_connection.commit()

    progress = test_client.get("/ai-progress").json()
    assert progress["active_model"]["version"] == active_version
    assert progress["model_display_names"] == {
        lifecycle_context.active_version: "Initial Model",
        active_version: "Model 2",
        "arbitrary-archive": "Model 3",
        "never-production-rejected": "Model 4",
        "unresolved-candidate": "Model 5",
    }
    assert progress["active_model_classes"] == {
        "available": True,
        "count": 3,
        "classes": ["Apple", "Milk", "Yogurt"],
    }
    assert [row["version"] for row in progress["rollback_targets"]] == [
        lifecycle_context.active_version
    ]
    target = progress["rollback_targets"][0]
    assert target["status"] == "archived"
    assert target["classes_available"] is True
    assert target["supported_product_count"] == 2
    assert target["supported_classes"] == ["Apple", "Milk"]
    assert len(progress["training_history"]) == 1
    assert progress["training_history"][0]["model_version"] == active_version
    for invalid_version in (
        active_version,
        "arbitrary-archive",
        "never-production-rejected",
        "unresolved-candidate",
    ):
        invalid = test_client.post(
            f"/model-lifecycle/rollback-targets/{invalid_version}/compare"
        )
        assert invalid.status_code == 409

    rollback_active_metrics = {
        "precision": 0.81, "recall": 0.79, "map50": 0.83, "map50_95": 0.65
    }
    rollback_target_metrics = {
        "precision": 0.70, "recall": 0.69, "map50": 0.72, "map50_95": 0.53
    }
    comparison_url = (
        f"/model-lifecycle/rollback-targets/"
        f"{lifecycle_context.active_version}/compare"
    )
    with lifecycle_context.runtime._LIFECYCLE_JOB_LOCK:
        jobs_before_lookup = dict(lifecycle_context.runtime._LIFECYCLE_JOBS)
    with patch.object(
        lifecycle_context.comparison,
        "compare",
        side_effect=AssertionError("cache miss must not run model evaluation"),
    ):
        missing = test_client.get(comparison_url)
    assert missing.status_code == 200
    assert missing.json() == {"available": False, "comparison": None}
    with lifecycle_context.runtime._LIFECYCLE_JOB_LOCK:
        assert lifecycle_context.runtime._LIFECYCLE_JOBS == jobs_before_lookup
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM model_comparisons;")
        assert cursor.fetchone()[0] == 1
        cursor.execute(
            """
            SELECT dataset_version, dataset_content_sha256,
                   validation_split_sha256, evaluation_parameters
            FROM model_comparisons WHERE id = %s;
            """,
            (promoted_comparison_id,),
        )
        dataset_version, content_hash, validation_hash, parameters = cursor.fetchone()
        cursor.execute(
            "SELECT id FROM model_versions WHERE version = %s;",
            (active_version,),
        )
        active_id = cursor.fetchone()[0]

    class_aware = build_class_aware_comparison(
        _evaluation(["Apple", "Milk", "Yogurt"], rollback_active_metrics),
        _evaluation(["Apple", "Milk"], rollback_target_metrics),
    )
    differences = {
        key: rollback_target_metrics[key] - rollback_active_metrics[key]
        for key in rollback_active_metrics
    }
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO model_comparisons(
                id, dataset_version, dataset_content_sha256,
                validation_split_sha256, active_model_id, candidate_model_id,
                evaluation_parameters, active_metrics, candidate_metrics,
                metric_differences, class_comparison,
                shared_class_comparison, added_class_metrics,
                comparison_rule, candidate_outperforms_active
            ) VALUES (
                'cached-rollback-comparison', %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s, %s,
                'informational rollback comparison', FALSE
            );
            """,
            (
                dataset_version, content_hash, validation_hash,
                active_id, lifecycle_context.active_id,
                Json(parameters), Json(rollback_active_metrics),
                Json(rollback_target_metrics), Json(differences),
                Json(class_aware["class_comparison"]),
                Json(class_aware["shared_class_comparison"]),
                Json(class_aware["added_class_metrics"]),
            ),
        )
    db_connection.commit()

    response = test_client.post(
        comparison_url,
        json={"active_version": "client-must-not-control-this"},
    )
    assert response.status_code == 200
    assert response.json()["available"] is True
    result = response.json()["comparison"]
    assert result["comparison_type"] == "rollback_target_vs_active"
    assert result["comparison_id"] == "cached-rollback-comparison"
    assert result["active_model"]["version"] == active_version
    assert result["rollback_target"]["version"] == lifecycle_context.active_version
    assert result["rollback_target_metrics"] == rollback_target_metrics
    assert result["shared_class_comparison"] == class_aware["shared_class_comparison"]
    assert result["added_class_metrics"] == class_aware["added_class_metrics"]
    assert result["class_comparison"] == {
        "active_classes": ["Apple", "Milk", "Yogurt"],
        "rollback_target_classes": ["Apple", "Milk"],
        "shared_classes": ["Apple", "Milk"],
        "only_in_active": ["Yogurt"],
        "only_in_rollback_target": [],
    }
    assert [
        row["version"] for row in test_client.get("/ai-progress").json()["rollback_targets"]
    ] == [lifecycle_context.active_version]

    with db_connection.cursor() as cursor:
        cursor.execute("SELECT version, status FROM model_versions;")
        statuses = dict(cursor.fetchall())
        cursor.execute("SELECT COUNT(*) FROM model_comparisons;")
        comparison_count = cursor.fetchone()[0]
        cursor.execute("SELECT COUNT(*) FROM model_activation_history;")
        activation_count = cursor.fetchone()[0]
    assert statuses[active_version] == "active"
    assert statuses[lifecycle_context.active_version] == "archived"
    assert statuses["arbitrary-archive"] == "archived"
    assert statuses["never-production-rejected"] == "rejected"
    assert statuses["unresolved-candidate"] == "candidate"
    assert comparison_count == 2
    assert activation_count == 1


def test_rollback_comparison_preserves_current_candidate_and_annotation_states(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    submission_factory("assisted", "approved", "Apple")
    submission_factory("manual", "approved", "Milk")
    baseline = _run_successful_training(test_client, lifecycle_context)
    baseline_version = baseline["result"]["model_version"]
    metrics = {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.5}
    better = {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.6}
    compared = _run_comparison(
        test_client, lifecycle_context, baseline_version, metrics, better
    )
    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (
            SimpleNamespace(task="detect"),
            str(Path(record["model_path"]).resolve()),
        ),
    )
    assert test_client.post(
        f"/models/{baseline_version}/promote",
        json={"comparison_id": compared["result"]["comparison_id"]},
    ).status_code == 200

    selected = [
        submission_factory("manual", "approved", "Lemon"),
        submission_factory("manual", "approved", "Orange"),
    ]
    quarantined = submission_factory("manual", "approved", "Bread")
    candidate = _run_successful_training(
        test_client,
        lifecycle_context,
        [row["submission_id"] for row in selected],
    )
    candidate_version = candidate["result"]["model_version"]
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE annotation_submissions SET training_state = 'quarantined' WHERE id = %s;",
            (quarantined["submission_id"],),
        )
    db_connection.commit()
    before = test_client.get("/ai-progress").json()
    assert before["candidate_state"] == "needs_comparison"

    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM model_comparisons;")
        comparison_count = cursor.fetchone()[0]
    with lifecycle_context.runtime._LIFECYCLE_JOB_LOCK:
        jobs_before_lookup = dict(lifecycle_context.runtime._LIFECYCLE_JOBS)
    with patch.object(
        lifecycle_context.comparison,
        "compare",
        side_effect=AssertionError("cache lookup must not evaluate models"),
    ):
        response = test_client.get(
            f"/model-lifecycle/rollback-targets/{lifecycle_context.active_version}/compare"
        )
    assert response.status_code == 200
    assert response.json() == {"available": False, "comparison": None}
    with lifecycle_context.runtime._LIFECYCLE_JOB_LOCK:
        assert lifecycle_context.runtime._LIFECYCLE_JOBS == jobs_before_lookup

    after = test_client.get("/ai-progress").json()
    assert after["active_model"]["version"] == baseline_version
    assert after["candidate"]["version"] == candidate_version
    assert after["candidate_state"] == before["candidate_state"]
    assert after["promotion_evaluation"] == before["promotion_evaluation"]
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, training_state FROM annotation_submissions WHERE id = ANY(%s);",
            ([row["submission_id"] for row in selected] + [quarantined["submission_id"]],),
        )
        states = dict(cursor.fetchall())
        cursor.execute(
            "SELECT status FROM model_versions WHERE version = %s;",
            (candidate_version,),
        )
        candidate_status = cursor.fetchone()[0]
        cursor.execute("SELECT COUNT(*) FROM model_comparisons;")
        final_comparison_count = cursor.fetchone()[0]
    assert {states[row["submission_id"]] for row in selected} == {"experimental"}
    assert states[quarantined["submission_id"]] == "quarantined"
    assert candidate_status == "candidate"
    assert final_comparison_count == comparison_count


def test_rollback_released_submission_can_be_selected_again_without_losing_provenance(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    contribution = submission_factory("manual", "approved", "Lemon")
    submission_id = contribution["submission_id"]
    companion = submission_factory("manual", "approved", "Milk")
    selected_ids = [submission_id, companion["submission_id"]]
    first = _run_successful_training(
        test_client, lifecycle_context, selected_ids
    )
    first_version = first["result"]["model_version"]
    first_run_id = first["result"]["training_run_id"]
    compared = _run_comparison(
        test_client,
        lifecycle_context,
        first_version,
        {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.5},
        {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.6},
    )
    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (
            SimpleNamespace(task="detect"),
            str(Path(record["model_path"]).resolve()),
        ),
    )
    promoted = test_client.post(
        f"/models/{first_version}/promote",
        json={"comparison_id": compared["result"]["comparison_id"]},
    )
    assert promoted.status_code == 200

    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT training_state FROM annotation_submissions WHERE id = %s;",
            (submission_id,),
        )
        assert cursor.fetchone()[0] == "trusted"
    db_connection.commit()

    rolled_back = test_client.post(
        f"/models/{lifecycle_context.active_version}/rollback"
    )
    assert rolled_back.status_code == 200
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT training_state FROM annotation_submissions WHERE id = %s;",
            (submission_id,),
        )
        assert cursor.fetchone()[0] == "eligible"
    db_connection.commit()

    second = _run_successful_training(
        test_client, lifecycle_context, selected_ids
    )
    second_run_id = second["result"]["training_run_id"]
    assert second_run_id != first_run_id
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT u.training_run_id, m.version, u.is_experimental
            FROM training_run_submission_usage u
            JOIN model_versions m ON m.id = u.model_version_id
            WHERE u.submission_id = %s
            ORDER BY u.used_at, u.training_run_id;
            """,
            (submission_id,),
        )
        usages = {
            row[0]: (row[1], row[2])
            for row in cursor.fetchall()
        }
        cursor.execute(
            """
            SELECT training_run_id
            FROM training_run_annotation_usage
            WHERE submission_id = %s
            ORDER BY used_at, training_run_id;
            """,
            (submission_id,),
        )
        annotation_run_ids = {row[0] for row in cursor.fetchall()}
        cursor.execute(
            "SELECT training_state FROM annotation_submissions WHERE id = %s;",
            (submission_id,),
        )
        current_state = cursor.fetchone()[0]
        cursor.execute(
            """
            SELECT starting_weights_path, starting_model_version,
                   starting_weights_sha256,
                   training_parameters->>'comparison_active_model_version'
            FROM training_runs WHERE id = %s;
            """,
            (second_run_id,),
        )
        second_run_provenance = cursor.fetchone()
    assert set(usages) == {first_run_id, second_run_id}
    assert {value[0] for value in usages.values()} == {
        first_version,
        second["result"]["model_version"],
    }
    assert {value[1] for value in usages.values()} == {True}
    assert annotation_run_ids == {first_run_id, second_run_id}
    assert current_state == "experimental"
    assert second_run_provenance == (
        str(lifecycle_context.foundation_path),
        lifecycle_context.foundation_version,
        lifecycle_context.foundation_hash,
        lifecycle_context.active_version,
    )


def test_rejected_candidate_quarantines_only_its_experimental_batch(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    baseline_a = submission_factory("assisted", "approved", "Apple")
    baseline_b = submission_factory("manual", "approved", "Milk")
    first = _run_successful_training(test_client, lifecycle_context)
    first_version = first["result"]["model_version"]
    compared = _run_comparison(
        test_client,
        lifecycle_context,
        first_version,
        {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.5},
        {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.6},
    )
    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (
            SimpleNamespace(task="detect"),
            str(Path(record["model_path"]).resolve()),
        ),
    )
    promoted = test_client.post(
        f"/models/{first_version}/promote",
        json={"comparison_id": compared["result"]["comparison_id"]},
    )
    assert promoted.status_code == 200

    experimental_d = submission_factory("manual", "approved", "Lemon")
    second = _run_successful_training(test_client, lifecycle_context)
    second_version = second["result"]["model_version"]
    second_run = second["result"]["training_run_id"]
    second_manifest = json.loads(
        (
            lifecycle_context.root
            / "dataset_exports"
            / second["job_id"]
            / "manifest.json"
        ).read_text(encoding="utf-8")
    )
    baseline_ids = {baseline_a["submission_id"], baseline_b["submission_id"]}
    assert set(second_manifest["trusted_submission_ids"]) == baseline_ids
    assert second_manifest["experimental_submission_ids"] == [
        experimental_d["submission_id"]
    ]
    assert set(second_manifest["included_submission_ids"]) == baseline_ids | {
        experimental_d["submission_id"]
    }

    rejected = test_client.post(f"/models/{second_version}/reject")
    assert rejected.status_code == 200
    assert rejected.json()["quarantined_submission_count"] == 1

    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, training_state FROM annotation_submissions ORDER BY id;"
        )
        states = dict(cursor.fetchall())
        cursor.execute(
            """
            SELECT submission_id, is_experimental
            FROM training_run_submission_usage
            WHERE training_run_id = %s ORDER BY submission_id;
            """,
            (second_run,),
        )
        usage = dict(cursor.fetchall())
        cursor.execute(
            """
            SELECT submission_id, is_experimental
            FROM training_run_annotation_usage
            WHERE training_run_id = %s ORDER BY submission_id;
            """,
            (second_run,),
        )
        annotation_usage = dict(cursor.fetchall())
    assert {states[value] for value in baseline_ids} == {"trusted"}
    assert states[experimental_d["submission_id"]] == "quarantined"
    assert usage == {
        baseline_a["submission_id"]: False,
        baseline_b["submission_id"]: False,
        experimental_d["submission_id"]: True,
    }
    assert annotation_usage == usage

    # Switching active archived models must not release rejected experimental
    # data from quarantine.
    assert test_client.post(
        f"/models/{lifecycle_context.active_version}/rollback"
    ).status_code == 200
    assert test_client.post(f"/models/{first_version}/rollback").status_code == 200
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT training_state FROM annotation_submissions WHERE id = %s;",
            (experimental_d["submission_id"],),
        )
        assert cursor.fetchone()[0] == "quarantined"
    db_connection.commit()

    experimental_e = submission_factory("manual", "approved", "Orange")
    third = _run_successful_training(test_client, lifecycle_context)
    third_manifest = json.loads(
        (
            lifecycle_context.root
            / "dataset_exports"
            / third["job_id"]
            / "manifest.json"
        ).read_text(encoding="utf-8")
    )
    assert set(third_manifest["trusted_submission_ids"]) == baseline_ids
    assert third_manifest["experimental_submission_ids"] == [
        experimental_e["submission_id"]
    ]
    assert set(third_manifest["included_submission_ids"]) == baseline_ids | {
        experimental_e["submission_id"]
    }
    assert experimental_d["submission_id"] not in third_manifest[
        "included_submission_ids"
    ]


def test_failed_promotion_request_does_not_quarantine_candidate_data(
    test_client, db_connection, lifecycle_context, submission_factory
):
    contribution = submission_factory("manual", "approved", "Lemon")
    submission_factory("assisted", "approved", "Milk")
    trained = _run_successful_training(test_client, lifecycle_context)
    candidate_version = trained["result"]["model_version"]

    failed = test_client.post(f"/models/{candidate_version}/promote", json={})
    assert failed.status_code == 400
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT training_state FROM annotation_submissions WHERE id = %s;",
            (contribution["submission_id"],),
        )
        assert cursor.fetchone()[0] == "experimental"
        cursor.execute(
            "SELECT status FROM model_versions WHERE version = %s;",
            (candidate_version,),
        )
        assert cursor.fetchone()[0] == "candidate"


def test_failed_candidate_auto_quarantines_only_selected_experimental_submissions(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    baseline_a = submission_factory("assisted", "approved", "Apple")
    baseline_b = submission_factory("manual", "approved", "Milk")
    baseline = _run_successful_training(test_client, lifecycle_context)
    baseline_version = baseline["result"]["model_version"]
    compared = _run_comparison(
        test_client,
        lifecycle_context,
        baseline_version,
        {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.5},
        {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.6},
    )
    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (
            SimpleNamespace(task="detect"),
            str(Path(record["model_path"]).resolve()),
        ),
    )
    assert test_client.post(
        f"/models/{baseline_version}/promote",
        json={"comparison_id": compared["result"]["comparison_id"]},
    ).status_code == 200

    selected_d = submission_factory("manual", "approved", "Lemon")
    unselected_e = submission_factory("manual", "approved", "Orange")
    selected_f = submission_factory("manual", "approved", "Bread")
    selected_ids = [selected_d["submission_id"], selected_f["submission_id"]]
    candidate = _run_successful_training(
        test_client, lifecycle_context, selected_ids
    )
    manifest = json.loads(
        (
            lifecycle_context.root
            / "dataset_exports"
            / candidate["job_id"]
            / "manifest.json"
        ).read_text(encoding="utf-8")
    )
    trusted_ids = {baseline_a["submission_id"], baseline_b["submission_id"]}
    assert set(manifest["trusted_submission_ids"]) == trusted_ids
    assert set(manifest["experimental_submission_ids"]) == set(selected_ids)
    assert set(manifest["included_submission_ids"]) == trusted_ids | set(selected_ids)
    assert unselected_e["submission_id"] not in manifest["included_submission_ids"]

    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_promotion_decision",
        lambda *args: {
            "eligible": False,
            "mode": "expanded_classes",
            "reasons": [{"code": "shared_class_regression", "message": "regression"}],
        },
    )
    compared = _run_comparison(
        test_client,
        lifecycle_context,
        candidate["result"]["model_version"],
        {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.7},
        {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.6},
    )
    assert compared["result"]["auto_rejected"] is True
    assert compared["result"]["quarantined_submission_count"] == 2
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, training_state FROM annotation_submissions ORDER BY id;"
        )
        states = dict(cursor.fetchall())
    assert {states[value] for value in selected_ids} == {"quarantined"}
    assert states[unselected_e["submission_id"]] == "eligible"

    next_candidate = _run_successful_training(
        test_client, lifecycle_context, [unselected_e["submission_id"]]
    )
    next_manifest = json.loads(
        (
            lifecycle_context.root
            / "dataset_exports"
            / next_candidate["job_id"]
            / "manifest.json"
        ).read_text(encoding="utf-8")
    )
    assert set(next_manifest["included_submission_ids"]) == trusted_ids | {
        unselected_e["submission_id"]
    }


def test_quarantined_submissions_can_be_archived_unarchived_and_restored(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    restore_item = submission_factory("manual", "approved", "Milk")
    archive_item = submission_factory("manual", "approved", "Lemon")
    selected_ids = [restore_item["submission_id"], archive_item["submission_id"]]
    candidate = _run_successful_training(test_client, lifecycle_context, selected_ids)
    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_promotion_decision",
        lambda *args: {
            "eligible": False,
            "mode": "expanded_classes",
            "reasons": [{"code": "added_class_quality", "message": "quality"}],
        },
    )
    compared = _run_comparison(
        test_client,
        lifecycle_context,
        candidate["result"]["model_version"],
        {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.7},
        {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.6},
    )
    assert compared["result"]["auto_rejected"] is True

    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT COUNT(*) FROM training_run_submission_usage WHERE submission_id = ANY(%s);",
            (selected_ids,),
        )
        usage_count = cursor.fetchone()[0]
    assert usage_count == 2

    archive_url = f"/annotation-submissions/{archive_item['submission_id']}/quarantine"
    archived = test_client.post(archive_url, json={"action": "archive"})
    assert archived.status_code == 200
    assert archived.json()["submission"]["training_state"] == "quarantined"
    assert archived.json()["submission"]["status"] == "approved"
    assert archived.json()["submission"]["archived_at"] is not None

    default_ids = {
        row["id"] for row in test_client.get("/annotation-submissions").json()
    }
    assert restore_item["submission_id"] in default_ids
    assert archive_item["submission_id"] not in default_ids
    included = test_client.get(
        "/annotation-submissions?include_archived=true"
    ).json()
    archived_row = next(
        row for row in included if row["id"] == archive_item["submission_id"]
    )
    assert archived_row["training_state"] == "quarantined"
    assert archived_row["archived_at"] is not None

    unarchived = test_client.post(archive_url, json={"action": "unarchive"})
    assert unarchived.status_code == 200
    assert unarchived.json()["submission"]["training_state"] == "quarantined"
    assert unarchived.json()["submission"]["archived_at"] is None
    assert archive_item["submission_id"] in {
        row["id"] for row in test_client.get("/annotation-submissions").json()
    }

    assert test_client.post(archive_url, json={"action": "archive"}).status_code == 200
    restored = test_client.post(archive_url, json={"action": "restore"})
    assert restored.status_code == 200
    assert restored.json()["submission"]["training_state"] == "eligible"
    assert restored.json()["submission"]["status"] == "approved"
    assert restored.json()["submission"]["archived_at"] is None
    assert test_client.post(archive_url, json={"action": "reject"}).status_code == 400

    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT COUNT(*) FROM training_run_submission_usage WHERE submission_id = ANY(%s);",
            (selected_ids,),
        )
        assert cursor.fetchone()[0] == usage_count

    quarantined = test_client.post(archive_url, json={"action": "quarantine"})
    assert quarantined.status_code == 200
    assert quarantined.json()["submission"]["training_state"] == "quarantined"
    assert quarantined.json()["submission"]["archived_at"] is None
    assert archive_item["submission_id"] in {
        row["id"] for row in test_client.get("/annotation-submissions").json()
    }

    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT COUNT(*) FROM training_run_submission_usage WHERE submission_id = ANY(%s);",
            (selected_ids,),
        )
        assert cursor.fetchone()[0] == usage_count

    assert test_client.post(archive_url, json={"action": "quarantine"}).status_code == 409


def test_selected_batch_becomes_trusted_on_promotion_and_joins_next_baseline(
    test_client, lifecycle_context, submission_factory, monkeypatch
):
    baseline_a = submission_factory("assisted", "approved", "Apple")
    baseline_b = submission_factory("manual", "approved", "Milk")
    first = _run_successful_training(test_client, lifecycle_context)
    first_version = first["result"]["model_version"]
    metrics = {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.5}
    better = {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.6}
    first_comparison = _run_comparison(
        test_client, lifecycle_context, first_version, metrics, better
    )
    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (
            SimpleNamespace(task="detect"),
            str(Path(record["model_path"]).resolve()),
        ),
    )
    assert test_client.post(
        f"/models/{first_version}/promote",
        json={"comparison_id": first_comparison["result"]["comparison_id"]},
    ).status_code == 200

    selected_d = submission_factory("manual", "approved", "Lemon")
    future_e = submission_factory("manual", "approved", "Orange")
    second = _run_successful_training(
        test_client, lifecycle_context, [selected_d["submission_id"]]
    )
    second_version = second["result"]["model_version"]
    second_comparison = _run_comparison(
        test_client, lifecycle_context, second_version, metrics, better
    )
    assert test_client.post(
        f"/models/{second_version}/promote",
        json={"comparison_id": second_comparison["result"]["comparison_id"]},
    ).status_code == 200

    third = _run_successful_training(
        test_client, lifecycle_context, [future_e["submission_id"]]
    )
    manifest = json.loads(
        (
            lifecycle_context.root
            / "dataset_exports"
            / third["job_id"]
            / "manifest.json"
        ).read_text(encoding="utf-8")
    )
    assert set(manifest["trusted_submission_ids"]) == {
        baseline_a["submission_id"],
        baseline_b["submission_id"],
        selected_d["submission_id"],
    }
    assert manifest["experimental_submission_ids"] == [future_e["submission_id"]]


def test_explicit_selection_rejects_duplicates_and_ineligible_ids(
    test_client, db_connection, lifecycle_context, submission_factory
):
    eligible = submission_factory("manual", "approved", "Lemon")
    rejected = submission_factory("manual", "rejected", "Bread")
    pending = submission_factory("manual", "pending", "Orange")
    trusted = submission_factory("manual", "approved", "Milk")
    experimental = submission_factory("manual", "approved", "Apple")
    quarantined = submission_factory("manual", "approved", "Cheese")
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE annotation_submissions SET training_state='trusted' WHERE id=%s;",
            (trusted["submission_id"],),
        )
        cursor.execute(
            "UPDATE annotation_submissions SET training_state='experimental' WHERE id=%s;",
            (experimental["submission_id"],),
        )
        cursor.execute(
            "UPDATE annotation_submissions SET training_state='quarantined' WHERE id=%s;",
            (quarantined["submission_id"],),
        )
    db_connection.commit()

    invalid_payloads = [
        ([], 400),
        ([eligible["submission_id"], eligible["submission_id"]], 400),
        ([999999], 409),
        ([trusted["submission_id"]], 409),
        ([experimental["submission_id"]], 409),
        ([quarantined["submission_id"]], 409),
        ([rejected["submission_id"]], 409),
        ([pending["submission_id"]], 409),
    ]
    for submission_ids, expected_status in invalid_payloads:
        response = test_client.post(
            "/model-lifecycle/train", json={"submission_ids": submission_ids}
        )
        assert response.status_code == expected_status

    with lifecycle_context.runtime._LIFECYCLE_JOB_LOCK:
        assert lifecycle_context.runtime._LIFECYCLE_JOBS == {}


def test_eligible_submission_details_preserve_multiple_final_labels(
    test_client, db_connection, submission_factory
):
    milk = submission_factory("manual", "approved", "Whole Milk")
    apple = submission_factory("manual", "approved", "Apple")
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO annotations(
                submission_id, action, final_label,
                final_x1, final_y1, final_x2, final_y2
            ) VALUES (%s, 'ADD', 'Lemon', 20, 15, 75, 68);
            """,
            (milk["submission_id"],),
        )
    db_connection.commit()

    listed = test_client.get("/annotation-submissions").json()
    eligible_ids = {
        row["id"] for row in listed
        if row["status"] in {"approved", "used"}
        and row["training_lifecycle_state"] == "eligible"
    }
    assert eligible_ids == {milk["submission_id"], apple["submission_id"]}

    details = {
        submission_id: test_client.get(
            f"/annotation-submissions/{submission_id}"
        ).json()
        for submission_id in eligible_ids
    }
    assert {
        annotation["final_label"]
        for annotation in details[milk["submission_id"]]["annotations"]
    } == {"Whole Milk", "Lemon"}
    assert {
        annotation["final_label"]
        for annotation in details[apple["submission_id"]]["annotations"]
    } == {"Apple"}


def test_training_fails_if_selected_submission_is_omitted_during_export(
    test_client, db_connection, lifecycle_context, submission_factory
):
    selected_a = submission_factory("manual", "approved", "Milk")
    selected_b = submission_factory("manual", "approved", "Lemon")
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT image_ref FROM scans WHERE id = %s;",
            (selected_b["scan_id"],),
        )
        Path(cursor.fetchone()[0]).unlink()

    response = test_client.post(
        "/model-lifecycle/train",
        json={
            "submission_ids": [
                selected_a["submission_id"], selected_b["submission_id"]
            ]
        },
    )
    assert response.status_code == 200
    job = response.json()
    assert job["status"] == "failed"
    assert "omitted required trusted or selected submissions" in job["error"]["message"]

    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, training_state FROM annotation_submissions ORDER BY id;"
        )
        assert dict(cursor.fetchall()) == {
            selected_a["submission_id"]: "eligible",
            selected_b["submission_id"]: "eligible",
        }
        cursor.execute("SELECT COUNT(*) FROM training_run_submission_usage;")
        assert cursor.fetchone()[0] == 0
        cursor.execute("SELECT COUNT(*) FROM training_run_annotation_usage;")
        assert cursor.fetchone()[0] == 0
        cursor.execute("SELECT COUNT(*) FROM model_versions WHERE status='candidate';")
        assert cursor.fetchone()[0] == 0


def test_invalid_promotion_and_rollback_leave_active_model_unchanged(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    submission_factory("assisted", "approved", "Apple")
    submission_factory("manual", "approved", "Milk")
    trained = _run_successful_training(test_client, lifecycle_context)
    candidate_version = trained["result"]["model_version"]
    active_metrics = {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.7}
    losing_metrics = {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.6}
    compared = _run_comparison(
        test_client, lifecycle_context, candidate_version, active_metrics, losing_metrics
    )
    comparison_id = compared["result"]["comparison_id"]
    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (SimpleNamespace(task="detect"), str(Path(record["model_path"]).resolve())),
    )

    attempts = [
        test_client.post("/models/unknown/promote", json={"comparison_id": comparison_id}),
        test_client.post(f"/models/{candidate_version}/promote", json={}),
        test_client.post(
            f"/models/{candidate_version}/promote",
            json={"comparison_id": comparison_id},
        ),
        test_client.post(f"/models/{lifecycle_context.active_version}/rollback"),
        test_client.post("/models/unknown/rollback"),
        test_client.post(f"/models/{candidate_version}/rollback"),
    ]
    assert [response.status_code for response in attempts] == [404, 400, 409, 409, 404, 409]
    assert "did not outperform" in attempts[2].json()["detail"]
    assert _active_count(db_connection) == 1
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT version FROM model_versions WHERE status = 'active';")
        assert cursor.fetchone()[0] == lifecycle_context.active_version
        cursor.execute("SELECT COUNT(*) FROM model_activation_history;")
        assert cursor.fetchone()[0] == 0


def test_stale_comparison_cannot_promote_against_a_new_active_model(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    submission_factory("assisted", "approved", "Apple")
    submission_factory("manual", "approved", "Milk")
    trained = _run_successful_training(test_client, lifecycle_context)
    candidate_version = trained["result"]["model_version"]
    metrics = {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.5}
    better = {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.6}
    compared = _run_comparison(
        test_client, lifecycle_context, candidate_version, metrics, better
    )
    comparison_id = compared["result"]["comparison_id"]

    replacement_path = lifecycle_context.root / "replacement.pt"
    replacement_path.write_bytes(b"replacement-active")
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE model_versions SET status = 'archived' WHERE status = 'active';"
        )
        cursor.execute(
            """
            INSERT INTO model_versions(version, model_path, status)
            VALUES ('replacement-active', %s, 'active');
            """,
            (str(replacement_path),),
        )
    db_connection.commit()
    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (SimpleNamespace(task="detect"), str(Path(record["model_path"]).resolve())),
    )

    response = test_client.post(
        f"/models/{candidate_version}/promote", json={"comparison_id": comparison_id}
    )
    assert response.status_code == 409
    assert "current active model" in response.json()["detail"]
    progress = test_client.get("/ai-progress").json()
    assert progress["comparison"]["id"] == comparison_id
    assert progress["promotion_evaluation"]["stale"] is True
    assert progress["candidate_state"] == "comparison_stale"
    assert progress["promotion_evaluation"]["reasons"][0]["code"] == "stale_comparison"
    assert progress["actions"]["can_promote"] is False
    assert progress["latest_candidate"]["version"] == candidate_version
    assert _active_count(db_connection) == 1
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT version FROM model_versions WHERE status = 'active';")
        assert cursor.fetchone()[0] == "replacement-active"
        cursor.execute("SELECT COUNT(*) FROM model_activation_history;")
        assert cursor.fetchone()[0] == 0


def test_reordered_same_classes_use_global_rule_and_can_promote(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    candidate_version, compared = _run_policy_comparison(
        test_client,
        lifecycle_context,
        submission_factory,
        candidate_classes=["Milk", "Apple", "Banana"],
        candidate_overall_map50_95=0.81,
    )
    comparison_id = compared["result"]["comparison_id"]
    progress = test_client.get("/ai-progress").json()
    decision = progress["promotion_evaluation"]
    assert decision["mode"] == "same_classes"
    assert decision["eligible"] is True
    assert decision["reasons"] == []
    assert progress["actions"]["can_promote"] is True

    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (SimpleNamespace(task="detect"), str(Path(record["model_path"]).resolve())),
    )
    promoted = test_client.post(
        f"/models/{candidate_version}/promote", json={"comparison_id": comparison_id}
    )
    assert promoted.status_code == 200
    assert _active_count(db_connection) == 1


def test_expanded_candidate_can_promote_despite_lower_global_map(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    candidate_version, compared = _run_policy_comparison(
        test_client,
        lifecycle_context,
        submission_factory,
        candidate_classes=["Apple", "Banana", "Milk", "Cheese", "Orange"],
        shared_candidate_map50_95=0.79,
        added_map50_95={"Cheese": 0.61, "Orange": 0.65},
    )
    comparison_id = compared["result"]["comparison_id"]
    assert compared["result"]["candidate_outperforms_active"] is False
    progress = test_client.get("/ai-progress").json()
    decision = progress["promotion_evaluation"]
    assert decision["mode"] == "expanded_classes"
    assert decision["eligible"] is True
    assert decision["reasons"] == []
    assert decision["thresholds"] == {
        "max_shared_map50_95_regression": 0.02,
        "min_added_class_map50_95": 0.50,
        "min_added_class_per_class_map50_95": 0.30,
    }
    assert {
        key: decision["metrics"][key]
        for key in (
            "shared_active_map50_95",
            "shared_candidate_map50_95",
            "shared_map50_95_difference",
            "added_map50_95",
        )
    } == pytest.approx(
        {
            "shared_active_map50_95": 0.80,
            "shared_candidate_map50_95": 0.79,
            "shared_map50_95_difference": -0.01,
            "added_map50_95": 0.63,
        }
    )
    assert decision["metrics"]["added_per_class_map50_95"] == pytest.approx(
        {"Cheese": 0.61, "Orange": 0.65}
    )
    assert progress["actions"]["can_promote"] is True
    assert progress["comparison"]["promotion_evaluation"] == decision

    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (SimpleNamespace(task="detect"), str(Path(record["model_path"]).resolve())),
    )
    promoted = test_client.post(
        f"/models/{candidate_version}/promote", json={"comparison_id": comparison_id}
    )
    assert promoted.status_code == 200
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, status FROM model_versions WHERE version = %s;",
            (candidate_version,),
        )
        candidate_id, candidate_status = cursor.fetchone()
        cursor.execute(
            "SELECT action, from_model_id, to_model_id, comparison_id FROM model_activation_history;"
        )
        history = cursor.fetchone()
    assert candidate_status == "active"
    assert history == (
        "PROMOTE", lifecycle_context.active_id, candidate_id, comparison_id
    )
    assert _active_count(db_connection) == 1


@pytest.mark.parametrize(
    ("candidate_classes", "shared_score", "added_scores", "reason_code"),
    [
        (["Apple", "Banana", "Milk", "Cheese", "Orange"], 0.77, {"Cheese": 0.61, "Orange": 0.65}, "shared_class_regression"),
        (["Apple", "Banana", "Milk", "Cheese", "Orange"], 0.79, {"Cheese": 0.49, "Orange": 0.49}, "added_class_quality"),
        (["Apple", "Banana", "Milk", "Cheese", "Orange"], 0.79, {"Cheese": 0.80, "Orange": 0.20}, "added_class_below_minimum"),
        (["Apple", "Milk", "Cheese"], 0.79, {"Cheese": 0.61}, "removed_classes"),
        (["Apple", "Milk"], 0.79, {}, "removed_classes"),
    ],
)
def test_expansion_policy_blocks_regression_low_quality_and_removed_classes(
    test_client,
    db_connection,
    lifecycle_context,
    submission_factory,
    monkeypatch,
    candidate_classes,
    shared_score,
    added_scores,
    reason_code,
):
    candidate_version, compared = _run_policy_comparison(
        test_client,
        lifecycle_context,
        submission_factory,
        candidate_classes=candidate_classes,
        shared_candidate_map50_95=shared_score,
        added_map50_95=added_scores,
    )
    comparison_id = compared["result"]["comparison_id"]
    decision = compared["result"]["promotion_evaluation"]
    assert decision["mode"] == "expanded_classes"
    assert decision["eligible"] is False
    assert reason_code in {reason["code"] for reason in decision["reasons"]}
    assert compared["result"]["auto_rejected"] is True
    progress = test_client.get("/ai-progress").json()
    assert progress["latest_candidate"] is None
    assert progress["actions"]["can_promote"] is False
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT DISTINCT training_state FROM annotation_submissions;"
        )
        assert cursor.fetchall() == [("quarantined",)]

    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (SimpleNamespace(task="detect"), str(Path(record["model_path"]).resolve())),
    )
    rejected = test_client.post(
        f"/models/{candidate_version}/promote", json={"comparison_id": comparison_id}
    )
    assert rejected.status_code == 409
    assert _active_count(db_connection) == 1
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT version FROM model_versions WHERE status = 'active';")
        assert cursor.fetchone()[0] == lifecycle_context.active_version
        cursor.execute("SELECT COUNT(*) FROM model_activation_history;")
        assert cursor.fetchone()[0] == 0


def test_malformed_expansion_metrics_fail_closed_everywhere(
    test_client, db_connection, lifecycle_context, submission_factory, monkeypatch
):
    candidate_version, compared = _run_policy_comparison(
        test_client,
        lifecycle_context,
        submission_factory,
        candidate_classes=["Apple", "Banana", "Milk", "Cheese"],
        added_map50_95={"Cheese": 0.65},
    )
    comparison_id = compared["result"]["comparison_id"]
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE model_comparisons SET added_class_metrics = %s WHERE id = %s;",
            (json.dumps({"available": True, "classes": ["Cheese"], "unavailable_classes": [], "per_class": {}}), comparison_id),
        )
    db_connection.commit()

    progress = test_client.get("/ai-progress").json()
    assert progress["promotion_evaluation"]["eligible"] is False
    assert progress["promotion_evaluation"]["reasons"][0]["code"] == "malformed_class_metrics"
    assert progress["candidate_state"] == "comparison_invalid"
    assert progress["actions"]["can_promote"] is False
    monkeypatch.setattr(
        lifecycle_context.runtime,
        "_load_registered_detector",
        lambda record: (SimpleNamespace(task="detect"), str(Path(record["model_path"]).resolve())),
    )
    rejected = test_client.post(
        f"/models/{candidate_version}/promote", json={"comparison_id": comparison_id}
    )
    assert rejected.status_code == 409
    assert _active_count(db_connection) == 1


def test_invalid_candidate_file_blocks_eligible_promotion_without_history(
    test_client, db_connection, lifecycle_context, submission_factory
):
    submission_factory("assisted", "approved", "Apple")
    submission_factory("manual", "approved", "Milk")
    trained = _run_successful_training(test_client, lifecycle_context)
    candidate_version = trained["result"]["model_version"]
    active = {"precision": 0.7, "recall": 0.7, "map50": 0.7, "map50_95": 0.5}
    candidate = {"precision": 0.8, "recall": 0.8, "map50": 0.8, "map50_95": 0.6}
    compared = _run_comparison(
        test_client, lifecycle_context, candidate_version, active, candidate
    )
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT model_path FROM model_versions WHERE version = %s;",
            (candidate_version,),
        )
        candidate_path = Path(cursor.fetchone()[0])
    candidate_path.unlink()

    rejected = test_client.post(
        f"/models/{candidate_version}/promote",
        json={"comparison_id": compared["result"]["comparison_id"]},
    )
    assert rejected.status_code == 409
    assert "missing" in rejected.json()["detail"].lower()
    assert _active_count(db_connection) == 1
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT version FROM model_versions WHERE status = 'active';")
        assert cursor.fetchone()[0] == lifecycle_context.active_version
        cursor.execute("SELECT COUNT(*) FROM model_activation_history;")
        assert cursor.fetchone()[0] == 0


@pytest.mark.parametrize("value", ["nan", "inf", "-0.1", "1.1"])
def test_promotion_threshold_configuration_rejects_non_finite_or_out_of_range(
    monkeypatch, value
):
    config = importlib.import_module("backend.core.config")
    monkeypatch.setenv("PROMOTION_TEST_THRESHOLD", value)
    with pytest.raises(ValueError):
        config._probability_setting("PROMOTION_TEST_THRESHOLD", "0.5")
