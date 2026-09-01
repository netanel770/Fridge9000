import importlib
import os

import cv2
import numpy as np
import pytest


pytestmark = [pytest.mark.integration, pytest.mark.api]


class ImmediateThread:
    def __init__(self, target, args=(), daemon=None):
        self.target = target
        self.args = args

    def start(self):
        self.target(*self.args)


def test_outline_preparation_job_contract_for_empty_inventory(test_client, monkeypatch):
    outlines = importlib.import_module("services.outlines")
    monkeypatch.setattr(outlines.threading, "Thread", ImmediateThread)

    started = test_client.post("/outlines/prepare")

    assert started.status_code == 200
    job = started.json()
    assert job == {
        "job_id": job["job_id"],
        "status": "complete",
        "phase": "complete",
        "message": "Outline preparation is complete.",
        "current_product": None,
        "total": 0,
        "processed": 0,
        "ready": 0,
        "skipped": 0,
        "failed": 0,
        "progress": 100,
        "failures": [],
    }

    fetched = test_client.get(f"/outlines/jobs/{job['job_id']}")
    missing = test_client.get("/outlines/jobs/unknown")
    assert fetched.status_code == 200
    assert fetched.json() == job
    assert missing.status_code == 404
    assert missing.json()["detail"] == "Outline preparation job not found"


def test_repeated_manual_replacement_is_revisioned_and_failure_keeps_current(
    test_client,
    db_connection,
    monkeypatch,
):
    outlines = importlib.import_module("services.outlines")
    with db_connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO items(name, category) VALUES ('Outline Lemon', 'Fruit') RETURNING id;"
        )
        item_id = cursor.fetchone()[0]
    db_connection.commit()

    first_mask = np.zeros((120, 120), dtype=np.uint8)
    cv2.circle(first_mask, (60, 60), 24, 1, -1)
    second_mask = np.zeros((120, 120), dtype=np.uint8)
    cv2.rectangle(second_mask, (42, 20), (78, 105), 1, -1)
    masks = iter((first_mask, second_mask))
    monkeypatch.setattr(
        outlines,
        "segment_manual_product_outline",
        lambda _path: (np.zeros((120, 120, 3), dtype=np.uint8), next(masks), 0.82),
    )
    ok, encoded = cv2.imencode(".png", np.zeros((20, 20, 3), dtype=np.uint8))
    assert ok
    upload = {"file": ("product.png", encoded.tobytes(), "image/png")}

    first = test_client.post(f"/items/{item_id}/representative-image", files=upload)
    assert first.status_code == 200
    first_revision = first.json()["outline_revision"]
    first_get = test_client.get(f"/items/{item_id}/representative-image?generate=false")
    assert first_get.status_code == 200
    assert "no-store" in first_get.headers["cache-control"]

    second = test_client.post(f"/items/{item_id}/representative-image", files=upload)
    assert second.status_code == 200
    second_revision = second.json()["outline_revision"]
    second_get = test_client.get(f"/items/{item_id}/representative-image?generate=false")
    assert second_revision != first_revision
    assert second_get.content != first_get.content

    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT image_path FROM representative_outlines WHERE item_id = %s;",
            (item_id,),
        )
        current_path = cursor.fetchone()[0]
    assert second_revision in current_path
    assert os.path.exists(current_path)

    monkeypatch.setattr(
        outlines,
        "segment_manual_product_outline",
        lambda _path: (_ for _ in ()).throw(RuntimeError("SAM failed")),
    )
    failed = test_client.post(f"/items/{item_id}/representative-image", files=upload)
    after_failure = test_client.get(f"/items/{item_id}/representative-image?generate=false")

    assert failed.status_code == 422
    assert after_failure.content == second_get.content
    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT image_path FROM representative_outlines WHERE item_id = %s;",
            (item_id,),
        )
        assert cursor.fetchone()[0] == current_path
