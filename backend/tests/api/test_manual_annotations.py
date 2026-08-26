import importlib
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
import pytest

from backend.export_yolo_dataset import fetch_export_rows, reconstruct_scan


pytestmark = [pytest.mark.integration, pytest.mark.api]


def _png_image(width=120, height=80):
    image = np.zeros((height, width, 3), dtype=np.uint8)
    image[:, :] = (40, 120, 220)
    encoded, contents = cv2.imencode(".png", image)
    assert encoded
    return contents.tobytes()


def _upload_manual_image(client, contents=None, filename="manual.png"):
    response = client.post(
        "/annotation-images/upload",
        files={"file": (filename, contents or _png_image(), "image/png")},
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True
    return response.json()


def _submit_adds(client, scan_id, annotations):
    return client.post(
        f"/scans/{scan_id}/annotation-submissions",
        json={"annotations": annotations},
    )


def test_annotation_image_upload_never_invokes_detector(
    test_client, db_connection, test_environment
):
    runtime = importlib.import_module("backend.main").runtime
    contents = _png_image(120, 80)
    with patch.object(runtime, "infer", side_effect=AssertionError("detector invoked")) as infer:
        uploaded = _upload_manual_image(test_client, contents)

    assert infer.call_count == 0
    assert uploaded["source"] == "manual_annotation"
    assert (uploaded["image_width"], uploaded["image_height"]) == (120, 80)
    assert uploaded["image_url"] == f"/scans/{uploaded['scan_id']}/image"

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT image_ref, image_width, image_height, source
            FROM scans WHERE id = %s;
            """,
            (uploaded["scan_id"],),
        )
        image_ref, width, height, source = cursor.fetchone()
        cursor.execute(
            "SELECT COUNT(*) FROM scan_detections WHERE scan_id = %s;",
            (uploaded["scan_id"],),
        )
        detection_count = cursor.fetchone()[0]

    stored_image = Path(image_ref)
    assert stored_image.parent == Path(test_environment["UPLOAD_DIR"])
    original_pixels = cv2.imdecode(np.frombuffer(contents, dtype=np.uint8), cv2.IMREAD_COLOR)
    stored_pixels = cv2.imread(str(stored_image), cv2.IMREAD_COLOR)
    assert np.array_equal(stored_pixels, original_pixels)
    assert (width, height, source) == (120, 80, "manual_annotation")
    assert detection_count == 0

    image_response = test_client.get(uploaded["image_url"])
    assert image_response.status_code == 200
    assert image_response.headers["content-type"] == "image/png"
    served_pixels = cv2.imdecode(np.frombuffer(image_response.content, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert np.array_equal(served_pixels, original_pixels)


def test_manual_adds_use_normal_moderation_and_training_provenance(
    test_client, db_connection
):
    first = _upload_manual_image(test_client, _png_image(160, 100), "first.png")
    second = _upload_manual_image(test_client, _png_image(90, 60), "second.png")
    annotations = [
        {
            "action": "ADD",
            "source_detection_id": None,
            "final_label": "Apple",
            "final_x1": 10,
            "final_y1": 12,
            "final_x2": 55,
            "final_y2": 70,
        },
        {
            "action": "ADD",
            "source_detection_id": None,
            "final_label": "Milk",
            "final_x1": 80,
            "final_y1": 15,
            "final_x2": 145,
            "final_y2": 85,
        },
    ]

    created = _submit_adds(test_client, first["scan_id"], annotations)
    assert created.status_code == 200
    body = created.json()
    submission_id = body["submission"]["id"]
    assert body["submission"]["status"] == "pending"
    assert body["submission"]["scan_id"] == first["scan_id"]
    assert {annotation["final_label"] for annotation in body["annotations"]} == {
        "Apple",
        "Milk",
    }
    assert all(annotation["action"] == "ADD" for annotation in body["annotations"])
    assert all(annotation["source_detection_id"] is None for annotation in body["annotations"])

    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT COUNT(*) FROM scan_detections WHERE scan_id = ANY(%s);",
            ([first["scan_id"], second["scan_id"]],),
        )
        assert cursor.fetchone()[0] == 0
        cursor.execute(
            "SELECT COUNT(*) FROM annotation_submissions WHERE scan_id = %s;",
            (second["scan_id"],),
        )
        assert cursor.fetchone()[0] == 0
        cursor.execute(
            """
            SELECT final_label, final_x1, final_y1, final_x2, final_y2
            FROM annotations WHERE submission_id = %s ORDER BY id;
            """,
            (submission_id,),
        )
        assert cursor.fetchall() == [
            ("Apple", 10.0, 12.0, 55.0, 70.0),
            ("Milk", 80.0, 15.0, 145.0, 85.0),
        ]

    approved = test_client.patch(
        f"/annotation-submissions/{submission_id}", json={"status": "approved"}
    )
    assert approved.status_code == 200
    detail = test_client.get(f"/annotation-submissions/{submission_id}")
    assert detail.status_code == 200
    assert detail.json()["submission"]["status"] == "approved"
    assert detail.json()["submission"]["scan_id"] == first["scan_id"]
    assert detail.json()["submission"]["training_status"] == "not_used"
    assert detail.json()["submission"]["training_usages"] == []
    assert all(annotation["training_usages"] == [] for annotation in detail.json()["annotations"])

    submissions, detections, persisted_annotations = fetch_export_rows(db_connection)
    assert [row["submission_id"] for row in submissions] == [submission_id]
    assert detections == []
    objects, action_counts, warnings = reconstruct_scan(
        submissions, detections, persisted_annotations
    )
    assert {(item.label, item.box) for item in objects} == {
        ("Apple", (10.0, 12.0, 55.0, 70.0)),
        ("Milk", (80.0, 15.0, 145.0, 85.0)),
    }
    assert action_counts["ADD"] == 2
    assert warnings == []


def test_annotation_image_upload_rejects_invalid_files_without_persistence(
    test_client, db_connection, test_environment
):
    upload_dir = Path(test_environment["UPLOAD_DIR"])
    files_before = set(upload_dir.iterdir())

    unsupported = test_client.post(
        "/annotation-images/upload",
        files={"file": ("manual.txt", b"text", "text/plain")},
    )
    empty = test_client.post(
        "/annotation-images/upload",
        files={"file": ("empty.png", b"", "image/png")},
    )
    undecodable = test_client.post(
        "/annotation-images/upload",
        files={"file": ("broken.png", b"not an image", "image/png")},
    )

    assert unsupported.status_code == 415
    assert empty.status_code == 400
    assert undecodable.status_code == 400
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM scans;")
        assert cursor.fetchone()[0] == 0
    assert set(upload_dir.iterdir()) == files_before


def test_invalid_manual_annotations_are_atomic_and_image_scoped(
    test_client, db_connection
):
    first = _upload_manual_image(test_client, _png_image(120, 80), "one.png")
    second = _upload_manual_image(test_client, _png_image(120, 80), "two.png")
    invalid_annotations = [
        {
            "action": "ADD",
            "final_label": "   ",
            "final_x1": 10,
            "final_y1": 10,
            "final_x2": 50,
            "final_y2": 50,
        },
        {
            "action": "ADD",
            "final_label": "Apple",
            "final_x1": "NaN",
            "final_y1": 10,
            "final_x2": 50,
            "final_y2": 50,
        },
        {
            "action": "ADD",
            "final_label": "Apple",
            "final_x1": 20,
            "final_y1": 10,
            "final_x2": 20,
            "final_y2": 50,
        },
        {
            "action": "ADD",
            "final_label": "Apple",
            "final_x1": 50,
            "final_y1": 30,
            "final_x2": 20,
            "final_y2": 50,
        },
        {
            "action": "ADD",
            "final_label": "Apple",
            "final_x1": 10,
            "final_y1": 10,
            "final_x2": 121,
            "final_y2": 50,
        },
        {
            "action": "ADD",
            "source_detection_id": 999999,
            "final_label": "Apple",
            "final_x1": 10,
            "final_y1": 10,
            "final_x2": 50,
            "final_y2": 50,
        },
    ]

    for annotation in invalid_annotations:
        response = _submit_adds(test_client, first["scan_id"], [annotation])
        assert response.status_code == 400

    atomic = _submit_adds(
        test_client,
        first["scan_id"],
        [
            {
                "action": "ADD",
                "final_label": "Valid",
                "final_x1": 10,
                "final_y1": 10,
                "final_x2": 50,
                "final_y2": 50,
            },
            {
                "action": "ADD",
                "final_label": "Outside",
                "final_x1": 70,
                "final_y1": 10,
                "final_x2": 130,
                "final_y2": 50,
            },
        ],
    )
    assert atomic.status_code == 400

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
                (SELECT COUNT(*) FROM annotation_submissions),
                (SELECT COUNT(*) FROM annotations),
                (SELECT COUNT(*) FROM scan_detections),
                (SELECT COUNT(*) FROM scans WHERE source = 'manual_annotation');
            """
        )
        assert cursor.fetchone() == (0, 0, 0, 2)
        cursor.execute(
            "SELECT COUNT(*) FROM annotation_submissions WHERE scan_id = %s;",
            (second["scan_id"],),
        )
        assert cursor.fetchone()[0] == 0
