from pathlib import Path

import pytest
from PIL import Image
import pytesseract


pytestmark = [pytest.mark.integration, pytest.mark.api]


def _receipt_image(path: Path):
    Image.new("RGB", (80, 120), "white").save(path, format="PNG")
    return path.read_bytes()


def test_receipt_upload_parses_quantities_and_persists_receipt_scan(
    test_client, db_connection, tmp_path, monkeypatch
):
    monkeypatch.setattr(
        pytesseract,
        "image_to_string",
        lambda page, lang: "2 Apples 3.50\nMilk\n4.25\nSubtotal 11.25\n",
    )

    response = test_client.post(
        "/receipts/upload",
        files={"file": ("receipt.png", _receipt_image(tmp_path / "receipt.png"), "image/png")},
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "scan_id": response.json()["scan_id"],
        "items_count": 3,
        "items": ["Apples", "Apples", "Milk"],
    }

    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT image_ref, source FROM scans WHERE id = %s;",
            (response.json()["scan_id"],),
        )
        image_ref, source = cursor.fetchone()
        cursor.execute(
            "SELECT label, confidence FROM scan_detections WHERE scan_id = %s ORDER BY id;",
            (response.json()["scan_id"],),
        )
        detections = cursor.fetchall()

    assert source == "receipt"
    assert Path(image_ref).is_file()
    assert detections == [("Apples", 1.0), ("Apples", 1.0), ("Milk", 1.0)]


def test_receipt_upload_error_contract_and_existing_file_retention(
    test_client, db_connection, test_environment, tmp_path, monkeypatch
):
    upload_dir = Path(test_environment["UPLOAD_DIR"])
    files_before = set(upload_dir.iterdir())
    monkeypatch.setattr(pytesseract, "image_to_string", lambda page, lang: "TOTAL 9.99\n")

    unsupported = test_client.post(
        "/receipts/upload",
        files={"file": ("receipt.txt", b"text", "text/plain")},
    )
    no_items = test_client.post(
        "/receipts/upload",
        files={"file": ("receipt.png", _receipt_image(tmp_path / "empty.png"), "image/png")},
    )

    assert unsupported.status_code == 400
    assert unsupported.json()["detail"] == "Only PDF, JPG, JPEG or PNG files are supported"
    assert no_items.status_code == 400
    assert no_items.json()["detail"] == "No items found in receipt"
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM scans;")
        assert cursor.fetchone()[0] == 0

    retained_files = set(upload_dir.iterdir()) - files_before
    assert len(retained_files) == 1
    assert next(iter(retained_files)).suffix == ".png"
