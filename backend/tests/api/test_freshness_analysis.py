import importlib
from io import BytesIO

import pytest
from PIL import Image


pytestmark = [pytest.mark.integration, pytest.mark.api]


def _image_bytes():
    output = BytesIO()
    Image.new("RGB", (32, 24), "green").save(output, format="PNG")
    return output.getvalue()


class _Scalar:
    def __init__(self, value):
        self.value = value

    def item(self):
        return self.value


class _Probabilities:
    top1 = 1
    top1conf = _Scalar(0.8)
    data = [0.1, 0.8, 0.1]


class _FreshnessModel:
    names = {0: "Fresh Apples", 1: "Rotten Banana", 2: "mystery"}

    def __init__(self):
        self.images = []

    def predict(self, image, verbose=False):
        assert verbose is False
        self.images.append(image)
        return [type("Result", (), {"probs": _Probabilities()})()]


def test_freshness_analysis_returns_classification_candidates_and_saved_image(
    test_client, monkeypatch
):
    freshness_analysis = importlib.import_module("services.freshness_analysis")
    model = _FreshnessModel()
    monkeypatch.setattr(freshness_analysis, "get_freshness_model", lambda: model)

    response = test_client.post(
        "/freshness/analyze",
        files={"file": ("produce.png", _image_bytes(), "image/png")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["classification"] == {
        "predicted_class": "Rotten Banana",
        "item": "Banana",
        "condition": "Rotten",
        "is_rotten": True,
        "class_id": 1,
        "confidence": pytest.approx(0.8),
    }
    assert [candidate["class_id"] for candidate in body["candidates"]] == [1, 0, 2]
    assert body["message"] == "The image was classified as rotten banana."
    assert body["image_url"].startswith("/uploads/freshness/")
    assert len(model.images) == 1
    assert model.images[0].shape[:2] == (24, 32)

    stored = test_client.get(body["image_url"])
    assert stored.status_code == 200
    assert stored.headers["content-type"] == "image/jpeg"


def test_freshness_analysis_preserves_upload_and_model_error_statuses(
    test_client, monkeypatch
):
    freshness_analysis = importlib.import_module("services.freshness_analysis")

    unsupported = test_client.post(
        "/freshness/analyze",
        files={"file": ("produce.txt", b"text", "text/plain")},
    )
    undecodable = test_client.post(
        "/freshness/analyze",
        files={"file": ("produce.png", b"not an image", "image/png")},
    )

    monkeypatch.setattr(
        freshness_analysis,
        "get_freshness_model",
        lambda: (_ for _ in ()).throw(RuntimeError("Freshness unavailable")),
    )
    unavailable = test_client.post(
        "/freshness/analyze",
        files={"file": ("produce.png", _image_bytes(), "image/png")},
    )

    assert unsupported.status_code == 415
    assert unsupported.json()["detail"] == "Upload a JPEG, PNG, or WebP image."
    assert undecodable.status_code == 400
    assert undecodable.json()["detail"] == "Uploaded image could not be decoded."
    assert unavailable.status_code == 503
    assert unavailable.json()["detail"] == "Freshness unavailable"
