import base64
import importlib
from datetime import date, timedelta
from pathlib import Path

import pytest


pytestmark = [pytest.mark.integration, pytest.mark.api]

PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZhxkAAAAASUVORK5CYII="
)
FAKE_DETECTIONS = [
    {
        "label": "apple",
        "confidence": 0.92,
        "x1": 4.0,
        "y1": 6.0,
        "x2": 24.0,
        "y2": 30.0,
    },
    {
        "label": "milk",
        "confidence": 0.87,
        "x1": 32.0,
        "y1": 8.0,
        "x2": 58.0,
        "y2": 42.0,
    },
]


@pytest.fixture
def scan_api(test_client, monkeypatch):
    runtime = importlib.import_module("backend.main").runtime
    inference_calls = []

    def fake_infer(payload):
        image_path = Path(payload["image_ref"])
        assert image_path.is_file()
        inference_calls.append(payload)
        return {
            "ok": True,
            "image_ref": str(image_path),
            "image_width": 64,
            "image_height": 48,
            "detections": [dict(detection) for detection in FAKE_DETECTIONS],
        }

    monkeypatch.setattr(runtime, "infer", fake_infer)
    return test_client, runtime, inference_calls


def _upload_scan(client, filename="fridge.png"):
    response = client.post(
        "/door/closed/upload",
        files={"file": (filename, PNG_BYTES, "image/png")},
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True
    return response.json()


def _detections_by_label(client, scan_id):
    response = client.get(f"/scans/{scan_id}/detections")
    assert response.status_code == 200
    return {detection["label"]: detection for detection in response.json()}


def _future_date(days=10):
    return (date.today() + timedelta(days=days)).isoformat()


def _inventory_by_name(client):
    response = client.get("/inventory")
    assert response.status_code == 200
    return {item["name"]: item for item in response.json()}


def _manual_add(client, item_name, quantity, expiry_date):
    response = client.post(
        "/inventory/manual",
        json={
            "item_name": item_name,
            "action": "Added",
            "quantity": quantity,
            "expiry_date": expiry_date,
            "expiry_source": "manual",
        },
    )
    assert response.status_code == 200


def _assert_item_consistent(db_connection, item_name, expected_quantity):
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT COALESCE(SUM(b.quantity), 0), inv.quantity
            FROM items i
            LEFT JOIN inventory_batches b ON b.item_id = i.id
            LEFT JOIN inventory inv ON inv.item_id = i.id
            WHERE i.name = %s
            GROUP BY i.id, inv.quantity;
            """,
            (item_name,),
        )
        batch_quantity, summary_quantity = cursor.fetchone()
        cursor.execute(
            """
            SELECT COUNT(*)
            FROM inventory_batches b JOIN items i ON i.id = b.item_id
            WHERE i.name = %s AND b.quantity < 0;
            """,
            (item_name,),
        )
        negative_batches = cursor.fetchone()[0]

    assert int(batch_quantity) == expected_quantity
    assert summary_quantity == expected_quantity
    assert negative_batches == 0


def test_upload_persists_scan_detections_and_retrievable_image(
    scan_api, db_connection, test_environment
):
    client, _, inference_calls = scan_api
    result = _upload_scan(client)
    scan_id = result["scan_id"]

    assert result["detections_count"] == 2
    assert [detection["item_name"] for detection in result["detections"]] == [
        "Apple",
        "Milk",
    ]
    assert len(inference_calls) == 1
    assert inference_calls[0]["conf"] == 0.25

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT image_ref, image_width, image_height
            FROM scans WHERE id = %s;
            """,
            (scan_id,),
        )
        image_ref, width, height = cursor.fetchone()
        cursor.execute(
            """
            SELECT scan_id, label, confidence, x1, y1, x2, y2
            FROM scan_detections
            WHERE scan_id = %s
            ORDER BY confidence DESC;
            """,
            (scan_id,),
        )
        persisted = cursor.fetchall()

    stored_image = Path(image_ref)
    assert stored_image.parent == Path(test_environment["UPLOAD_DIR"])
    assert stored_image.read_bytes() == PNG_BYTES
    assert (width, height) == (64, 48)
    assert len(persisted) == 2
    assert all(row[0] == scan_id for row in persisted)
    assert persisted[0][1] == "Apple"
    assert persisted[0][2] == pytest.approx(0.92)
    assert persisted[0][3:] == pytest.approx((4.0, 6.0, 24.0, 30.0))
    assert persisted[1][1] == "Milk"
    assert persisted[1][2] == pytest.approx(0.87)
    assert persisted[1][3:] == pytest.approx((32.0, 8.0, 58.0, 42.0))

    latest = client.get("/scans/latest")
    assert latest.status_code == 200
    assert latest.json()["id"] == scan_id
    assert latest.json()["image_ref"] == image_ref

    recent = client.get("/scans/recent")
    assert recent.status_code == 200
    recent_scan = next(scan for scan in recent.json() if scan["id"] == scan_id)
    assert recent_scan["detection_count"] == 2
    assert (recent_scan["image_width"], recent_scan["image_height"]) == (64, 48)

    image_response = client.get(f"/scans/{scan_id}/image")
    assert image_response.status_code == 200
    assert image_response.headers["content-type"] == "image/png"
    assert image_response.content == PNG_BYTES


def test_added_review_applies_relabel_and_excludes_false_positive(
    scan_api, db_connection
):
    client, _, _ = scan_api
    reviewed_scan = _upload_scan(client, "reviewed.png")
    untouched_scan = _upload_scan(client, "untouched.png")
    scan_id = reviewed_scan["scan_id"]
    detections = _detections_by_label(client, scan_id)
    untouched_detections = _detections_by_label(client, untouched_scan["scan_id"])
    expiry = _future_date()

    wrong_scan = client.post(
        f"/scans/{scan_id}/review",
        json={
            "mode": "Added",
            "items": [
                {
                    "id": untouched_detections["Apple"]["id"],
                    "original_label": "Apple",
                    "final_label": "Pear",
                    "included": True,
                    "expiry_date": expiry,
                    "expiry_source": "manual",
                }
            ],
        },
    )
    assert wrong_scan.status_code == 400
    assert _inventory_by_name(client) == {}

    response = client.post(
        f"/scans/{scan_id}/review",
        json={
            "mode": "Added",
            "items": [
                {
                    "id": detections["Apple"]["id"],
                    "original_label": "Apple",
                    "final_label": "pear",
                    "included": True,
                    "confidence": 0.92,
                    "expiry_date": expiry,
                    "expiry_source": "manual",
                },
                {
                    "id": detections["Milk"]["id"],
                    "original_label": "Milk",
                    "final_label": "Milk",
                    "included": False,
                    "confidence": 0.87,
                },
            ],
        },
    )

    assert response.status_code == 200
    assert response.json()["updated_items"][0]["name"] == "Pear"
    inventory = _inventory_by_name(client)
    assert inventory["Pear"]["quantity"] == 1
    assert "Apple" not in inventory
    assert "Milk" not in inventory
    _assert_item_consistent(db_connection, "Pear", 1)

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT original_label, final_label, included
            FROM detection_reviews
            WHERE scan_id = %s ORDER BY id;
            """,
            (scan_id,),
        )
        assert cursor.fetchall() == [("Apple", "Pear", True), ("Milk", "Milk", False)]
        cursor.execute(
            """
            SELECT i.name, e.action, e.quantity_change, e.confidence
            FROM events e JOIN items i ON i.id = e.item_id
            WHERE e.scan_id = %s;
            """,
            (scan_id,),
        )
        event = cursor.fetchone()
        assert event[:3] == ("Pear", "Added", 1)
        assert event[3] == pytest.approx(0.92)
        cursor.execute(
            "SELECT COUNT(*) FROM detection_reviews WHERE scan_id = %s;",
            (untouched_scan["scan_id"],),
        )
        assert cursor.fetchone()[0] == 0

    assert set(_detections_by_label(client, scan_id)) == {"Apple", "Milk"}
    assert set(_detections_by_label(client, untouched_scan["scan_id"])) == {
        "Apple",
        "Milk",
    }


def test_supported_review_quantity_updates_inventory_and_event(scan_api, db_connection):
    client, _, _ = scan_api
    scan_id = _upload_scan(client)["scan_id"]
    apple = _detections_by_label(client, scan_id)["Apple"]

    response = client.post(
        f"/scans/{scan_id}/review",
        json={
            "mode": "Added",
            "source": "receipt",
            "items": [
                {
                    "id": apple["id"],
                    "original_label": "Apple",
                    "final_label": "Apple",
                    "included": True,
                    "quantity": 3,
                    "confidence": 0.92,
                    "expiry_date": _future_date(),
                    "expiry_source": "manual",
                }
            ],
        },
    )

    assert response.status_code == 200
    assert response.json()["updated_items"][0]["quantity"] == 3
    assert _inventory_by_name(client)["Apple"]["quantity"] == 3
    _assert_item_consistent(db_connection, "Apple", 3)
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT quantity_change FROM events WHERE scan_id = %s;",
            (scan_id,),
        )
        assert cursor.fetchall() == [(3,)]


def test_removed_review_updates_batches_events_and_summary(scan_api, db_connection):
    client, _, _ = scan_api
    expiry = _future_date(20)
    _manual_add(client, "Apple", 2, expiry)
    scan_id = _upload_scan(client)["scan_id"]
    detections = _detections_by_label(client, scan_id)

    response = client.post(
        f"/scans/{scan_id}/review",
        json={
            "mode": "Removed",
            "items": [
                {
                    "id": detections["Apple"]["id"],
                    "original_label": "Apple",
                    "final_label": "Apple",
                    "included": True,
                    "confidence": 0.92,
                    "expiry_date": expiry,
                    "expiry_source": "inventory",
                },
                {
                    "id": detections["Milk"]["id"],
                    "original_label": "Milk",
                    "final_label": "Milk",
                    "included": False,
                },
            ],
        },
    )

    assert response.status_code == 200
    assert _inventory_by_name(client)["Apple"]["quantity"] == 1
    _assert_item_consistent(db_connection, "Apple", 1)
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT action, quantity_change
            FROM events
            WHERE scan_id = %s;
            """,
            (scan_id,),
        )
        assert cursor.fetchall() == [("Removed", 1)]


def test_failed_over_removal_rolls_back_the_entire_review(scan_api, db_connection):
    client, _, _ = scan_api
    expiry = _future_date(25)
    _manual_add(client, "Apple", 1, expiry)
    scan_id = _upload_scan(client)["scan_id"]
    detections = _detections_by_label(client, scan_id)

    response = client.post(
        f"/scans/{scan_id}/review",
        json={
            "mode": "Removed",
            "items": [
                {
                    "id": detections["Apple"]["id"],
                    "original_label": "Apple",
                    "final_label": "Apple",
                    "included": True,
                    "expiry_date": expiry,
                    "expiry_source": "inventory",
                },
                {
                    "id": detections["Milk"]["id"],
                    "original_label": "Milk",
                    "final_label": "Apple",
                    "included": True,
                    "expiry_date": expiry,
                    "expiry_source": "inventory",
                },
            ],
        },
    )

    assert response.status_code == 400
    assert _inventory_by_name(client)["Apple"]["quantity"] == 1
    _assert_item_consistent(db_connection, "Apple", 1)
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM events WHERE scan_id = %s;", (scan_id,))
        assert cursor.fetchone()[0] == 0
        cursor.execute(
            "SELECT COUNT(*) FROM detection_reviews WHERE scan_id = %s;",
            (scan_id,),
        )
        assert cursor.fetchone()[0] == 0


def test_review_validation_and_duplicate_submission(scan_api, db_connection):
    client, _, _ = scan_api
    scan_id = _upload_scan(client)["scan_id"]
    apple = _detections_by_label(client, scan_id)["Apple"]
    valid_payload = {
        "mode": "Added",
        "items": [
            {
                "id": apple["id"],
                "original_label": "Apple",
                "final_label": "Apple",
                "included": True,
                "confidence": 0.92,
                "expiry_date": _future_date(),
                "expiry_source": "manual",
            }
        ],
    }

    missing_scan = client.post("/scans/999999/review", json=valid_payload)
    assert missing_scan.status_code == 404
    malformed = client.post(
        f"/scans/{scan_id}/review",
        json={"mode": "Added", "items": {"original_label": "Apple"}},
    )
    assert malformed.status_code == 400
    invalid_quantity = client.post(
        f"/scans/{scan_id}/review",
        json={
            "mode": "Added",
            "source": "receipt",
            "items": [{"original_label": "Apple", "quantity": 0}],
        },
    )
    assert invalid_quantity.status_code == 400

    first = client.post(f"/scans/{scan_id}/review", json=valid_payload)
    assert first.status_code == 200
    duplicate = client.post(f"/scans/{scan_id}/review", json=valid_payload)
    assert duplicate.status_code == 409
    assert _inventory_by_name(client)["Apple"]["quantity"] == 1
    _assert_item_consistent(db_connection, "Apple", 1)


def test_upload_validation_does_not_persist_failed_scan(
    scan_api, monkeypatch, db_connection
):
    client, runtime, _ = scan_api

    missing = client.post("/door/closed/upload")
    assert missing.status_code == 422
    unsupported = client.post(
        "/door/closed/upload",
        files={"file": ("scan.txt", b"not an image", "text/plain")},
    )
    assert unsupported.status_code == 415

    monkeypatch.setattr(
        runtime,
        "infer",
        lambda payload: {"ok": False, "error": "could not decode image"},
    )
    invalid = client.post(
        "/door/closed/upload",
        files={"file": ("broken.jpg", b"not an image", "image/jpeg")},
    )
    assert invalid.status_code == 400
    assert "could not decode image" in invalid.json()["detail"]

    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM scans;")
        assert cursor.fetchone()[0] == 0
