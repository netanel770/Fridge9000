import importlib
from datetime import date, timedelta
from io import BytesIO
from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image


pytestmark = [pytest.mark.integration, pytest.mark.api]

def _image_bytes(image_format="PNG", width=64, height=48, orientation=None):
    image = Image.new("RGB", (width, height), "white")
    for x in range(width // 4):
        for y in range(height):
            image.putpixel((x, y), (240, 20, 20))
    output = BytesIO()
    exif = Image.Exif()
    if orientation is not None:
        exif[274] = orientation
    image.save(output, format=image_format, quality=95, exif=exif)
    return output.getvalue()


PNG_BYTES = _image_bytes()
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
    scans = importlib.import_module("services.scans")
    inference_calls = []

    class FreshnessModel:
        names = {
            0: "Fresh Apples", 1: "Rotten Apples",
            2: "Fresh Bananas", 3: "Rotten Bananas",
            4: "Fresh Oranges", 5: "Rotten Oranges",
        }

    monkeypatch.setattr(
        scans.freshness_analysis, "get_freshness_model", lambda: FreshnessModel()
    )

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

    monkeypatch.setattr(scans, "infer", fake_infer)
    return test_client, scans, inference_calls


def _upload_scan(client, filename="fridge.png", contents=PNG_BYTES, content_type="image/png"):
    response = client.post(
        "/door/closed/upload",
        files={"file": (filename, contents, content_type)},
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
    with Image.open(stored_image) as stored:
        assert stored.size == (64, 48)
        assert stored.getexif().get(274) is None
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
    with Image.open(BytesIO(image_response.content)) as served:
        assert served.size == (64, 48)
        assert served.getexif().get(274) is None


def test_scan_detections_report_backend_freshness_eligibility(scan_api):
    client, _, _ = scan_api
    scan_id = _upload_scan(client)["scan_id"]
    detections = _detections_by_label(client, scan_id)
    assert detections["Apple"]["freshness_supported"] is True
    assert detections["Milk"]["freshness_supported"] is False


@pytest.mark.parametrize(
    ("predicted_class", "condition", "is_rotten"),
    [("Fresh Apples", "Fresh", False), ("Rotten Apples", "Rotten", True)],
)
def test_detection_freshness_is_crop_based_and_read_only(
    scan_api, db_connection, monkeypatch, predicted_class, condition, is_rotten
):
    client, scans, _ = scan_api
    scan_id = _upload_scan(client)["scan_id"]
    apple = _detections_by_label(client, scan_id)["Apple"]
    seen_crops = []

    def classify(crop):
        seen_crops.append(crop.copy())
        return {"classification": {
            "predicted_class": predicted_class, "item": "Apples",
            "condition": condition, "is_rotten": is_rotten,
            "class_id": 0 if not is_rotten else 1, "confidence": 0.94,
        }, "candidates": []}

    monkeypatch.setattr(scans.freshness_analysis, "classify_freshness_image", classify)
    tables = (
        "inventory", "inventory_batches", "events", "detection_reviews",
        "annotation_submissions", "annotations", "freshness_analyses",
    )
    with db_connection.cursor() as cursor:
        before = {}
        for table in tables:
            cursor.execute(f"SELECT COUNT(*) FROM {table};")
            before[table] = cursor.fetchone()[0]

    response = client.post(f"/scans/{scan_id}/detections/{apple['id']}/freshness")

    assert response.status_code == 200
    assert response.json()["classification"] == {
        "predicted_class": predicted_class, "item": "Apples",
        "condition": condition, "is_rotten": is_rotten,
        "class_id": 0 if not is_rotten else 1, "confidence": 0.94,
    }
    assert response.json()["detection_id"] == apple["id"]
    assert seen_crops[0].shape[:2] == (28, 24)
    with db_connection.cursor() as cursor:
        for table in tables:
            cursor.execute(f"SELECT COUNT(*) FROM {table};")
            assert cursor.fetchone()[0] == before[table]


def test_detection_freshness_rejects_unsupported_invalid_and_mismatched_results(
    scan_api, db_connection, monkeypatch
):
    client, scans, _ = scan_api
    scan_id = _upload_scan(client)["scan_id"]
    detections = _detections_by_label(client, scan_id)
    unsupported = client.post(
        f"/scans/{scan_id}/detections/{detections['Milk']['id']}/freshness"
    )
    missing = client.post(f"/scans/{scan_id}/detections/999999/freshness")
    monkeypatch.setattr(
        scans.freshness_analysis, "classify_freshness_image",
        lambda _crop: {"classification": {
            "predicted_class": "Fresh Bananas", "item": "Bananas",
            "condition": "Fresh", "is_rotten": False,
            "class_id": 2, "confidence": 0.9,
        }, "candidates": []},
    )
    mismatch = client.post(
        f"/scans/{scan_id}/detections/{detections['Apple']['id']}/freshness"
    )
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE scan_detections SET x2 = x1 WHERE id = %s;",
            (detections["Apple"]["id"],),
        )
    db_connection.commit()
    invalid_box = client.post(
        f"/scans/{scan_id}/detections/{detections['Apple']['id']}/freshness"
    )
    assert unsupported.status_code == 422
    assert missing.status_code == 404
    assert mismatch.status_code == 422
    assert "does not match" in mismatch.json()["detail"]
    assert invalid_box.status_code == 422
    assert "bounding box" in invalid_box.json()["detail"]


def test_detection_freshness_clamps_crop_and_hides_other_users_scan(
    scan_api, db_connection, monkeypatch
):
    client, scans, _ = scan_api
    scan_id = _upload_scan(client)["scan_id"]
    apple = _detections_by_label(client, scan_id)["Apple"]
    crops = []
    monkeypatch.setattr(
        scans.freshness_analysis, "classify_freshness_image",
        lambda crop: crops.append(crop.copy()) or {"classification": {
            "predicted_class": "Fresh Apples", "item": "Apples",
            "condition": "Fresh", "is_rotten": False,
            "class_id": 0, "confidence": 0.9,
        }, "candidates": []},
    )
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE scan_detections SET x1 = -20, y1 = -20, x2 = 80, y2 = 80 WHERE id = %s;",
            (apple["id"],),
        )
    db_connection.commit()
    clamped = client.post(f"/scans/{scan_id}/detections/{apple['id']}/freshness")
    assert clamped.status_code == 200
    assert crops[0].shape[:2] == (48, 64)

    other_user = client.post(
        "/auth/register/password",
        json={"email": "freshness-other@example.com", "password": "other password"},
    ).json()["user"]
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE scans SET created_by_user_id = %s WHERE id = %s;",
            (other_user["id"], scan_id),
        )
    db_connection.commit()
    unauthorized = client.post(f"/scans/{scan_id}/detections/{apple['id']}/freshness")
    assert unauthorized.status_code == 404


def test_detection_freshness_reports_missing_image_and_classifier_failure(
    scan_api, db_connection, monkeypatch
):
    client, scans, _ = scan_api
    missing_image_scan = _upload_scan(client, "missing-freshness-image.png")
    missing_detections = _detections_by_label(client, missing_image_scan["scan_id"])
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT image_ref FROM scans WHERE id = %s;",
            (missing_image_scan["scan_id"],),
        )
        Path(cursor.fetchone()[0]).unlink()
    missing_image = client.post(
        f"/scans/{missing_image_scan['scan_id']}/detections/"
        f"{missing_detections['Apple']['id']}/freshness"
    )
    assert missing_image.status_code == 404

    failed_scan = _upload_scan(client, "failed-freshness.png")
    failed_apple = _detections_by_label(client, failed_scan["scan_id"])["Apple"]
    monkeypatch.setattr(
        scans.freshness_analysis,
        "classify_freshness_image",
        lambda _crop: (_ for _ in ()).throw(
            HTTPException(status_code=500, detail="Freshness analysis failed.")
        ),
    )
    failed = client.post(
        f"/scans/{failed_scan['scan_id']}/detections/{failed_apple['id']}/freshness"
    )
    assert failed.status_code == 500
    assert failed.json()["detail"] == "Freshness analysis failed."


def test_zero_detection_scan_remains_retrievable_and_accepts_add_annotation(
    scan_api, monkeypatch, db_connection
):
    client, runtime, _ = scan_api

    def infer_without_detections(payload):
        image_path = Path(payload["image_ref"])
        assert image_path.is_file()
        return {
            "ok": True,
            "image_ref": str(image_path),
            "image_width": 64,
            "image_height": 48,
            "detections": [],
        }

    monkeypatch.setattr(runtime, "infer", infer_without_detections)
    result = _upload_scan(client, "unknown-product.png")
    scan_id = result["scan_id"]
    assert result["detections_count"] == 0

    metadata = client.get(f"/scans/{scan_id}")
    assert metadata.status_code == 200
    assert metadata.json()["id"] == scan_id
    assert metadata.json()["detection_count"] == 0
    assert (metadata.json()["image_width"], metadata.json()["image_height"]) == (64, 48)

    recent = client.get("/scans/recent")
    assert recent.status_code == 200
    recent_scan = next(scan for scan in recent.json() if scan["id"] == scan_id)
    assert recent_scan["detection_count"] == 0
    assert (recent_scan["image_width"], recent_scan["image_height"]) == (64, 48)

    image_response = client.get(f"/scans/{scan_id}/image")
    assert image_response.status_code == 200
    with Image.open(BytesIO(image_response.content)) as served:
        assert served.size == (64, 48)
        assert served.getexif().get(274) is None

    submission = client.post(
        f"/scans/{scan_id}/annotation-submissions",
        json={
            "annotations": [
                {
                    "action": "ADD",
                    "final_label": "Lemon",
                    "final_x1": 4,
                    "final_y1": 5,
                    "final_x2": 44,
                    "final_y2": 40,
                }
            ]
        },
    )
    assert submission.status_code == 200
    body = submission.json()
    assert body["submission"]["scan_id"] == scan_id
    assert (body["submission"]["image_width"], body["submission"]["image_height"]) == (64, 48)
    annotation = body["annotations"][0]
    assert annotation["action"] == "ADD"
    assert annotation["source_detection_id"] is None
    assert annotation["final_label"] == "Lemon"

    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM scan_detections WHERE scan_id = %s;", (scan_id,))
        assert cursor.fetchone()[0] == 0


@pytest.mark.parametrize(
    ("orientation", "expected_box", "red_point", "white_point"),
    [
        (6, (0.0, 0.0, 20.0, 10.0), (10, 2), (10, 35)),
        (8, (0.0, 30.0, 20.0, 40.0), (10, 37), (10, 4)),
    ],
)
def test_exif_oriented_scan_uses_one_canonical_detection_space(
    scan_api, monkeypatch, db_connection, orientation, expected_box, red_point, white_point
):
    client, runtime, _ = scan_api

    def infer_normalized_image(payload):
        with Image.open(payload["image_ref"]) as detector_image:
            assert detector_image.size == (20, 40)
            assert detector_image.getexif().get(274) is None
            red = detector_image.convert("RGB").getpixel(red_point)
            white = detector_image.convert("RGB").getpixel(white_point)
            assert red[0] > 180 and red[1] < 80
            assert min(white) > 180
        return {
            "ok": True,
            "image_ref": payload["image_ref"],
            "image_width": 20,
            "image_height": 40,
            "detections": [
                {
                    "label": "apple",
                    "confidence": 0.9,
                    "x1": expected_box[0],
                    "y1": expected_box[1],
                    "x2": expected_box[2],
                    "y2": expected_box[3],
                }
            ],
        }

    monkeypatch.setattr(runtime, "infer", infer_normalized_image)
    uploaded = _upload_scan(
        client,
        f"orientation-{orientation}.jpg",
        _image_bytes("JPEG", 40, 20, orientation),
        "image/jpeg",
    )
    scan_id = uploaded["scan_id"]
    assert (uploaded["image_width"], uploaded["image_height"]) == (20, 40)

    metadata = client.get(f"/scans/{scan_id}").json()
    assert (metadata["image_width"], metadata["image_height"]) == (20, 40)
    image_response = client.get(f"/scans/{scan_id}/image")
    assert image_response.status_code == 200
    with Image.open(BytesIO(image_response.content)) as served:
        assert served.size == (20, 40)
        assert served.getexif().get(274) is None
        served_rgb = served.convert("RGB")
        assert served_rgb.getpixel(red_point)[0] > 180
        assert min(served_rgb.getpixel(white_point)) > 180

    detection = next(iter(_detections_by_label(client, scan_id).values()))
    assert (detection["x1"], detection["y1"], detection["x2"], detection["y2"]) == pytest.approx(expected_box)
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT image_width, image_height FROM scans WHERE id = %s;", (scan_id,))
        assert cursor.fetchone() == (20, 40)


def test_zero_detection_exif_scan_accepts_annotation_in_normalized_space(scan_api, monkeypatch):
    client, runtime, _ = scan_api

    def infer_without_detections(payload):
        with Image.open(payload["image_ref"]) as detector_image:
            assert detector_image.size == (20, 40)
            assert detector_image.getexif().get(274) is None
        return {
            "ok": True,
            "image_ref": payload["image_ref"],
            "image_width": 20,
            "image_height": 40,
            "detections": [],
        }

    monkeypatch.setattr(runtime, "infer", infer_without_detections)
    uploaded = _upload_scan(
        client,
        "zero-orientation-6.jpg",
        _image_bytes("JPEG", 40, 20, 6),
        "image/jpeg",
    )
    assert uploaded["detections_count"] == 0
    assert (uploaded["image_width"], uploaded["image_height"]) == (20, 40)

    response = client.post(
        f"/scans/{uploaded['scan_id']}/annotation-submissions",
        json={
            "annotations": [
                {
                    "action": "ADD",
                    "final_label": "Lemon",
                    "final_x1": 1,
                    "final_y1": 1,
                    "final_x2": 19,
                    "final_y2": 15,
                }
            ]
        },
    )
    assert response.status_code == 200
    annotation = response.json()["annotations"][0]
    assert annotation["source_detection_id"] is None
    assert (annotation["final_x1"], annotation["final_y1"], annotation["final_x2"], annotation["final_y2"]) == pytest.approx((1, 1, 19, 15))


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
    assert invalid.json()["detail"] == "Uploaded image could not be decoded"

    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM scans;")
        assert cursor.fetchone()[0] == 0
