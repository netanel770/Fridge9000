import importlib

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
