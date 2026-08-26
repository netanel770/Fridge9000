import itertools

import pytest


pytestmark = [pytest.mark.integration, pytest.mark.api]


@pytest.fixture
def scan_factory(db_connection):
    sequence = itertools.count(1)

    def create(detections=None):
        number = next(sequence)
        rows = detections or [
            ("Apple", 0.91, 10.0, 10.0, 40.0, 50.0),
            ("Milk", 0.87, 50.0, 10.0, 80.0, 60.0),
            ("Orange", 0.82, 90.0, 10.0, 125.0, 55.0),
            ("Bread", 0.78, 130.0, 10.0, 175.0, 65.0),
        ]
        with db_connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO scans(image_ref, image_width, image_height)
                VALUES (%s, 200, 100)
                RETURNING id;
                """,
                (f"test-annotation-scan-{number}.png",),
            )
            scan_id = cursor.fetchone()[0]
            detection_ids = {}
            for label, confidence, x1, y1, x2, y2 in rows:
                cursor.execute(
                    """
                    INSERT INTO scan_detections(
                        scan_id, label, confidence, x1, y1, x2, y2
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING id;
                    """,
                    (scan_id, label, confidence, x1, y1, x2, y2),
                )
                detection_ids[label] = cursor.fetchone()[0]
        db_connection.commit()
        return scan_id, detection_ids

    return create


def _submit(client, scan_id, annotations):
    return client.post(
        f"/scans/{scan_id}/annotation-submissions",
        json={"annotations": annotations},
    )


def _database_counts(db_connection):
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
                (SELECT COUNT(*) FROM annotation_submissions),
                (SELECT COUNT(*) FROM annotations);
            """
        )
        return cursor.fetchone()


def test_all_annotation_actions_preserve_detection_provenance(
    test_client, db_connection, scan_factory
):
    scan_id, detections = scan_factory()
    response = _submit(
        test_client,
        scan_id,
        [
            {"action": "CONFIRM", "source_detection_id": detections["Apple"]},
            {
                "action": "RELABEL",
                "source_detection_id": detections["Milk"],
                "final_label": "Yogurt",
            },
            {
                "action": "ADJUST_BOX",
                "source_detection_id": detections["Orange"],
                "final_x1": 92,
                "final_y1": 12,
                "final_x2": 132,
                "final_y2": 62,
            },
            {"action": "REMOVE", "source_detection_id": detections["Bread"]},
            {
                "action": "ADD",
                "final_label": "Banana",
                "final_x1": 145,
                "final_y1": 20,
                "final_x2": 185,
                "final_y2": 75,
            },
        ],
    )

    assert response.status_code == 200
    body = response.json()
    submission = body["submission"]
    assert submission["scan_id"] == scan_id
    assert submission["status"] == "pending"
    assert (submission["image_width"], submission["image_height"]) == (200, 100)
    annotations = {annotation["action"]: annotation for annotation in body["annotations"]}
    assert set(annotations) == {"CONFIRM", "RELABEL", "ADJUST_BOX", "ADD", "REMOVE"}
    assert all(
        annotation["submission_id"] == submission["id"]
        for annotation in annotations.values()
    )

    confirmed = annotations["CONFIRM"]
    assert confirmed["source_detection_id"] == detections["Apple"]
    assert confirmed["original_label"] == confirmed["final_label"] == "Apple"
    assert confirmed["original_confidence"] == pytest.approx(0.91)
    assert (
        confirmed["original_x1"],
        confirmed["original_y1"],
        confirmed["original_x2"],
        confirmed["original_y2"],
    ) == pytest.approx((10, 10, 40, 50))
    assert (
        confirmed["final_x1"],
        confirmed["final_y1"],
        confirmed["final_x2"],
        confirmed["final_y2"],
    ) == pytest.approx((10, 10, 40, 50))

    relabeled = annotations["RELABEL"]
    assert relabeled["original_label"] == "Milk"
    assert relabeled["final_label"] == "Yogurt"
    assert relabeled["source_detection_id"] == detections["Milk"]
    adjusted = annotations["ADJUST_BOX"]
    assert adjusted["original_label"] == adjusted["final_label"] == "Orange"
    assert (
        adjusted["original_x1"], adjusted["original_y1"],
        adjusted["original_x2"], adjusted["original_y2"],
    ) == pytest.approx((90, 10, 125, 55))
    assert (
        adjusted["final_x1"], adjusted["final_y1"],
        adjusted["final_x2"], adjusted["final_y2"],
    ) == pytest.approx((92, 12, 132, 62))
    removed = annotations["REMOVE"]
    assert removed["original_label"] == "Bread"
    assert removed["final_label"] is None
    assert all(removed[field] is None for field in ("final_x1", "final_y1", "final_x2", "final_y2"))
    added = annotations["ADD"]
    assert added["source_detection_id"] is None
    assert added["original_label"] is None
    assert added["original_confidence"] is None
    assert added["final_label"] == "Banana"
    assert (
        added["final_x1"], added["final_y1"], added["final_x2"], added["final_y2"]
    ) == pytest.approx((145, 20, 185, 75))

    detail = test_client.get(f"/annotation-submissions/{submission['id']}")
    assert detail.status_code == 200
    assert detail.json()["submission"]["training_status"] == "not_used"
    assert detail.json()["submission"]["training_usages"] == []
    assert all(annotation["training_usages"] == [] for annotation in detail.json()["annotations"])

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT COUNT(*)
            FROM annotations a
            JOIN annotation_submissions s ON s.id = a.submission_id
            LEFT JOIN scan_detections d ON d.id = a.source_detection_id
            WHERE s.id = %s
              AND a.source_detection_id IS NOT NULL
              AND d.scan_id = s.scan_id;
            """,
            (submission["id"],),
        )
        assert cursor.fetchone()[0] == 4
        cursor.execute(
            """
            SELECT label, confidence, x1, y1, x2, y2
            FROM scan_detections WHERE id = %s;
            """,
            (detections["Milk"],),
        )
        assert cursor.fetchone() == pytest.approx(
            ("Milk", 0.87, 50.0, 10.0, 80.0, 60.0)
        )
        cursor.execute(
            """
            SELECT
                (SELECT COUNT(*) FROM training_run_submission_usage),
                (SELECT COUNT(*) FROM training_run_annotation_usage);
            """
        )
        assert cursor.fetchone() == (0, 0)


def test_annotation_submission_validation_is_atomic(
    test_client, db_connection, scan_factory
):
    scan_id, detections = scan_factory()
    _, foreign_detections = scan_factory()
    invalid_payloads = [
        ([{"action": "CONFIRM", "source_detection_id": foreign_detections["Apple"]}], 400),
        ([{"action": "CONFIRM"}], 400),
        ([{
            "action": "ADD", "source_detection_id": detections["Apple"],
            "final_label": "Pear", "final_x1": 10, "final_y1": 10,
            "final_x2": 40, "final_y2": 40,
        }], 400),
        ([{"action": "RELABEL", "source_detection_id": detections["Apple"], "final_label": "  "}], 400),
        ([{
            "action": "ADJUST_BOX", "source_detection_id": detections["Apple"],
            "final_x1": 20, "final_y1": 10, "final_x2": 20, "final_y2": 40,
        }], 400),
        ([{
            "action": "ADJUST_BOX", "source_detection_id": detections["Apple"],
            "final_x1": 20, "final_y1": 40, "final_x2": 40, "final_y2": 10,
        }], 400),
        ([{
            "action": "ADJUST_BOX", "source_detection_id": detections["Apple"],
            "final_x1": -1, "final_y1": 10, "final_x2": 40, "final_y2": 40,
        }], 400),
        ([{
            "action": "ADJUST_BOX", "source_detection_id": detections["Apple"],
            "final_x1": "invalid", "final_y1": 10, "final_x2": 40, "final_y2": 40,
        }], 400),
        ([{
            "action": "ADJUST_BOX", "source_detection_id": detections["Apple"],
            "final_x1": "NaN", "final_y1": 10, "final_x2": 40, "final_y2": 40,
        }], 400),
        ([{
            "action": "ADD", "final_label": "Pear",
            "final_x1": 10, "final_y1": 10, "final_x2": 14, "final_y2": 14,
        }], 400),
        ([
            {"action": "CONFIRM", "source_detection_id": detections["Apple"]},
            {"action": "ADD", "final_label": "Pear"},
        ], 400),
        ([
            {"action": "CONFIRM", "source_detection_id": detections["Apple"]},
            {"action": "CONFIRM", "source_detection_id": detections["Apple"]},
        ], 409),
    ]

    for annotations, expected_status in invalid_payloads:
        response = _submit(test_client, scan_id, annotations)
        assert response.status_code == expected_status
        assert _database_counts(db_connection) == (0, 0)

    malformed = _submit(test_client, scan_id, ["not an annotation object"])
    assert malformed.status_code == 400
    assert _database_counts(db_connection) == (0, 0)


def test_moderation_listing_stats_and_pretraining_provenance(
    test_client, db_connection, scan_factory
):
    submission_ids = []
    for label in ("Apple", "Milk", "Orange"):
        scan_id, detections = scan_factory([(label, 0.9, 10, 10, 50, 60)])
        response = _submit(
            test_client,
            scan_id,
            [{"action": "CONFIRM", "source_detection_id": detections[label]}],
        )
        assert response.status_code == 200
        submission_ids.append(response.json()["submission"]["id"])

    pending = test_client.get("/annotation-submissions?status=pending")
    assert pending.status_code == 200
    assert {submission["id"] for submission in pending.json()} == set(submission_ids)
    assert all(submission["training_status"] == "not_used" for submission in pending.json())

    approved = test_client.patch(
        f"/annotation-submissions/{submission_ids[0]}", json={"status": "approved"}
    )
    rejected = test_client.patch(
        f"/annotation-submissions/{submission_ids[1]}", json={"status": "rejected"}
    )
    assert approved.status_code == rejected.status_code == 200
    assert approved.json()["submission"]["reviewed_at"] is not None
    assert rejected.json()["submission"]["reviewed_at"] is not None

    for status, expected_id in (
        ("approved", submission_ids[0]),
        ("rejected", submission_ids[1]),
        ("pending", submission_ids[2]),
    ):
        response = test_client.get(f"/annotation-submissions?status={status}")
        assert response.status_code == 200
        assert [submission["id"] for submission in response.json()] == [expected_id]

    invalid_internal_status = test_client.patch(
        f"/annotation-submissions/{submission_ids[2]}", json={"status": "used"}
    )
    assert invalid_internal_status.status_code == 400

    detail = test_client.get(f"/annotation-submissions/{submission_ids[0]}")
    assert detail.status_code == 200
    assert detail.json()["submission"]["scan_id"] is not None
    assert detail.json()["submission"]["training_status"] == "not_used"
    assert detail.json()["submission"]["training_usages"] == []
    assert detail.json()["annotations"][0]["training_usages"] == []
    assert detail.json()["annotations"][0]["source_detection_id"] is not None
    assert detail.json()["annotations"][0]["original_label"] == "Apple"

    stats = test_client.get("/annotation-submissions/stats")
    assert stats.status_code == 200
    assert stats.json()["submissions"] == {
        "total": 3,
        "pending": 1,
        "approved": 1,
        "rejected": 1,
        "used": 0,
    }
    assert stats.json()["annotations_by_action"] == {
        "CONFIRM": 3,
        "RELABEL": 0,
        "ADJUST_BOX": 0,
        "ADD": 0,
        "REMOVE": 0,
    }

    edit_approved = test_client.patch(
        f"/annotations/{detail.json()['annotations'][0]['id']}",
        json={"final_label": "Pear"},
    )
    assert edit_approved.status_code == 409
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
                (SELECT COUNT(*) FROM training_run_submission_usage),
                (SELECT COUNT(*) FROM training_run_annotation_usage);
            """
        )
        assert cursor.fetchone() == (0, 0)


def test_pending_annotation_edits_are_validated_and_isolated(
    test_client, db_connection, scan_factory
):
    scan_id, detections = scan_factory()
    created = _submit(
        test_client,
        scan_id,
        [
            {
                "action": "RELABEL",
                "source_detection_id": detections["Apple"],
                "final_label": "Pear",
            },
            {
                "action": "ADD",
                "final_label": "Banana",
                "final_x1": 120,
                "final_y1": 20,
                "final_x2": 170,
                "final_y2": 70,
            },
        ],
    )
    assert created.status_code == 200
    relabel, added = created.json()["annotations"]

    label_edit = test_client.patch(
        f"/annotations/{relabel['id']}", json={"final_label": "Peach"}
    )
    assert label_edit.status_code == 200
    edited_label = label_edit.json()["annotation"]
    assert edited_label["original_label"] == "Apple"
    assert edited_label["original_confidence"] == pytest.approx(0.91)
    assert edited_label["final_label"] == "Peach"

    box_edit = test_client.patch(
        f"/annotations/{added['id']}",
        json={"final_x1": 110, "final_y1": 15, "final_x2": 180, "final_y2": 80},
    )
    assert box_edit.status_code == 200
    edited_box = box_edit.json()["annotation"]
    assert (
        edited_box["final_x1"], edited_box["final_y1"],
        edited_box["final_x2"], edited_box["final_y2"],
    ) == pytest.approx((110, 15, 180, 80))

    invalid_label = test_client.patch(
        f"/annotations/{relabel['id']}", json={"final_label": " "}
    )
    invalid_box = test_client.patch(
        f"/annotations/{added['id']}",
        json={"final_x1": 110, "final_y1": 15, "final_x2": 210, "final_y2": 80},
    )
    assert invalid_label.status_code == invalid_box.status_code == 400

    _, foreign_detections = scan_factory()
    foreign_source = test_client.patch(
        f"/annotations/{relabel['id']}",
        json={"source_detection_id": foreign_detections["Apple"]},
    )
    assert foreign_source.status_code == 400

    detail = test_client.get(f"/annotation-submissions/{created.json()['submission']['id']}")
    persisted = {annotation["id"]: annotation for annotation in detail.json()["annotations"]}
    assert persisted[relabel["id"]]["final_label"] == "Peach"
    assert persisted[relabel["id"]]["source_detection_id"] == detections["Apple"]
    assert (
        persisted[added["id"]]["final_x1"], persisted[added["id"]]["final_y1"],
        persisted[added["id"]]["final_x2"], persisted[added["id"]]["final_y2"],
    ) == pytest.approx((110, 15, 180, 80))
    assert persisted[added["id"]]["final_label"] == "Banana"

    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT label, confidence, x1, y1, x2, y2 FROM scan_detections WHERE id = %s;",
            (detections["Apple"],),
        )
        detection = cursor.fetchone()
    assert detection[0] == "Apple"
    assert detection[1:] == pytest.approx((0.91, 10, 10, 40, 50))


def test_edit_cannot_bypass_duplicate_correction_rule(test_client, scan_factory):
    scan_id, detections = scan_factory()
    created = _submit(
        test_client,
        scan_id,
        [
            {"action": "CONFIRM", "source_detection_id": detections["Apple"]},
            {
                "action": "RELABEL",
                "source_detection_id": detections["Apple"],
                "final_label": "Pear",
            },
        ],
    )
    assert created.status_code == 200
    relabel = created.json()["annotations"][1]

    duplicate_creation = _submit(
        test_client,
        scan_id,
        [{"action": "CONFIRM", "source_detection_id": detections["Apple"]}],
    )
    assert duplicate_creation.status_code == 409

    duplicate = test_client.patch(
        f"/annotations/{relabel['id']}", json={"action": "CONFIRM"}
    )
    assert duplicate.status_code == 409

    detail = test_client.get(
        f"/annotation-submissions/{created.json()['submission']['id']}"
    )
    persisted = {annotation["id"]: annotation for annotation in detail.json()["annotations"]}
    assert persisted[relabel["id"]]["action"] == "RELABEL"
    assert persisted[relabel["id"]]["final_label"] == "Pear"
