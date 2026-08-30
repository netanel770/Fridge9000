from copy import deepcopy

import pytest
from psycopg2.extras import Json

from services import model_lifecycle


pytestmark = [pytest.mark.integration, pytest.mark.api]
_PASSWORD = "correct horse battery staple"


def _register(client, email):
    response = client.post(
        "/auth/register/password",
        json={"email": email, "password": _PASSWORD},
    )
    assert response.status_code == 201
    return response.json()


def _auth(auth_body, fridge_id=None):
    headers = {"Authorization": f"Bearer {auth_body['access_token']}"}
    if fridge_id is not None:
        headers["X-Fridge-ID"] = str(fridge_id)
    return headers


def _create_fridge(client, user, name="Test Fridge"):
    response = client.post(
        "/fridges", json={"name": name}, headers=_auth(user)
    )
    assert response.status_code == 201
    return response.json()


def _make_admin(db_connection, user_id, *, active=True):
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE users SET is_system_admin = TRUE, is_active = %s
            WHERE id = %s;
            """,
            (active, user_id),
        )
    db_connection.commit()


@pytest.mark.parametrize(
    "method,path,payload",
    [
        ("get", "/ai-progress", None),
        ("post", "/model-lifecycle/train", {}),
        ("post", "/model-lifecycle/candidates/unknown/compare", None),
        ("get", "/model-lifecycle/jobs/unknown", None),
        ("get", "/model-lifecycle/rollback-targets/unknown/compare", None),
        ("post", "/models/unknown/promote", {"comparison_id": "none"}),
        ("post", "/models/unknown/reject", None),
        ("post", "/models/unknown/rollback", None),
        ("get", "/annotation-submissions", None),
        ("get", "/annotation-submissions/stats", None),
        ("get", "/annotation-submissions/999999", None),
        ("get", "/system-admins", None),
        ("post", "/system-admins/999999", None),
        ("patch", "/annotation-submissions/999999", {"status": "approved"}),
        (
            "post",
            "/annotation-submissions/999999/quarantine",
            {"action": "quarantine"},
        ),
        ("post", "/outlines/prepare", None),
        ("get", "/outlines/jobs/unknown", None),
    ],
)
def test_normal_household_user_cannot_use_admin_or_moderation_routes(
    test_client, method, path, payload
):
    user = _register(test_client, "normal@example.com")
    fridge = _create_fridge(test_client, user)

    response = test_client.request(
        method.upper(), path, json=payload, headers=_auth(user, fridge["id"])
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "System administrator access required"


def test_household_owner_manager_and_member_have_same_ai_permissions(
    test_client, db_connection
):
    owner = _register(test_client, "owner@example.com")
    manager = _register(test_client, "manager@example.com")
    member = _register(test_client, "member@example.com")
    fridge = _create_fridge(test_client, owner)
    for user in (manager, member):
        assert test_client.post(
            "/fridges/join",
            json={"join_code": fridge["join_code"]},
            headers=_auth(user),
        ).status_code == 200
        assert test_client.post(
            f"/fridges/{fridge['id']}/members/{user['user']['id']}/approve",
            headers=_auth(owner, fridge["id"]),
        ).status_code == 200
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE household_memberships SET role = 'MANAGER'
            WHERE household_id = %s AND user_id = %s;
            """,
            (fridge["id"], manager["user"]["id"]),
        )
    db_connection.commit()

    for user in (owner, manager, member):
        assert test_client.get(
            "/ai-progress", headers=_auth(user, fridge["id"])
        ).status_code == 403
        assert test_client.get(
            "/annotation-submissions/stats",
            headers=_auth(user, fridge["id"]),
        ).status_code == 403


def test_system_admin_can_manage_admins_and_moderate(
    test_client, db_connection, tmp_path
):
    admin = _register(test_client, "admin@example.com")
    target = _register(test_client, "target@example.com")
    _make_admin(db_connection, admin["user"]["id"])
    submission_image = tmp_path / "moderation.jpg"
    submission_image.write_bytes(b"moderation-image")
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO scans(image_ref, image_width, image_height, source)
            VALUES (%s, 100, 100, 'manual_annotation') RETURNING id;
            """,
            (str(submission_image),),
        )
        scan_id = cursor.fetchone()[0]
        cursor.execute(
            """
            INSERT INTO annotation_submissions(scan_id, image_width, image_height)
            VALUES (%s, 100, 100) RETURNING id;
            """,
            (scan_id,),
        )
        submission_id = cursor.fetchone()[0]
    db_connection.commit()

    assert test_client.get("/ai-progress", headers=_auth(admin)).status_code == 200
    assert test_client.get(
        "/annotation-submissions", headers=_auth(admin)
    ).status_code == 200
    moderated = test_client.patch(
        f"/annotation-submissions/{submission_id}",
        json={"status": "approved"},
        headers=_auth(admin),
    )
    assert moderated.status_code == 200
    image = test_client.get(
        f"/annotation-submissions/{submission_id}/image",
        headers=_auth(admin),
    )
    assert image.status_code == 200
    assert image.content == b"moderation-image"
    assert test_client.get(
        f"/annotation-submissions/{submission_id}/image",
        headers=_auth(target),
    ).status_code == 403
    assert test_client.get(
        f"/scans/{scan_id}/image", headers=_auth(admin)
    ).status_code == 403

    granted = test_client.post(
        f"/system-admins/{target['user']['id']}", headers=_auth(admin)
    )
    assert granted.status_code == 200
    assert granted.json()["is_system_admin"] is True
    admins = test_client.get("/system-admins", headers=_auth(admin))
    assert admins.status_code == 200
    assert {row["email"] for row in admins.json()} == {
        "admin@example.com",
        "target@example.com",
    }
    assert "password_hash" not in str(admins.json())


def test_inactive_admin_is_rejected_as_unauthenticated(test_client, db_connection):
    admin = _register(test_client, "inactive@example.com")
    _make_admin(db_connection, admin["user"]["id"], active=False)

    response = test_client.get("/system-admins", headers=_auth(admin))

    assert response.status_code == 401


def test_missing_authentication_is_rejected_before_admin_authorization(test_client):
    response = test_client.get("/ai-progress")

    assert response.status_code == 401


def test_system_admin_does_not_bypass_household_isolation(
    test_client, db_connection
):
    admin = _register(test_client, "admin@example.com")
    owner = _register(test_client, "owner@example.com")
    _make_admin(db_connection, admin["user"]["id"])
    fridge = _create_fridge(test_client, owner, "Private Fridge")
    scan = test_client.post(
        "/scans",
        json={"image_ref": "private.jpg"},
        headers=_auth(owner, fridge["id"]),
    ).json()
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE scans SET image_width = 100, image_height = 100 WHERE id = %s;",
            (scan["scan_id"],),
        )
    db_connection.commit()

    assert test_client.get(
        "/inventory", headers=_auth(admin, fridge["id"])
    ).status_code == 403
    assert test_client.get(
        f"/scans/{scan['scan_id']}", headers=_auth(admin, fridge["id"])
    ).status_code == 403
    assert test_client.get(
        f"/fridges/{fridge['id']}/members",
        headers=_auth(admin, fridge["id"]),
    ).status_code == 403


def test_user_model_overview_handles_no_previous_without_mutation(test_client):
    user = _register(test_client, "user@example.com")
    fridge = _create_fridge(test_client, user)
    before = deepcopy(model_lifecycle._LIFECYCLE_JOBS)

    response = test_client.get(
        "/models/user-overview", headers=_auth(user, fridge["id"])
    )

    assert response.status_code == 200
    assert response.json()["active_model"] is not None
    assert response.json()["previous_model"] is None
    assert response.json()["comparison"] is None
    assert model_lifecycle._LIFECYCLE_JOBS == before


def test_user_model_overview_handles_previous_without_comparison(
    test_client, db_connection
):
    user = _register(test_client, "user@example.com")
    fridge = _create_fridge(test_client, user)
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE model_versions SET status = 'archived'
            WHERE status = 'active' RETURNING id, version;
            """
        )
        previous_id, previous_version = cursor.fetchone()
        cursor.execute(
            """
            INSERT INTO model_versions(version, model_path, status)
            VALUES ('rollback-current', 'rollback.pt', 'active') RETURNING id;
            """
        )
        current_id = cursor.fetchone()[0]
        cursor.execute(
            """
            INSERT INTO model_activation_history(action, from_model_id, to_model_id)
            VALUES ('ROLLBACK', %s, %s);
            """,
            (previous_id, current_id),
        )
    db_connection.commit()

    response = test_client.get(
        "/models/user-overview", headers=_auth(user, fridge["id"])
    )

    assert response.status_code == 200
    assert response.json()["previous_model"]["version"] == previous_version
    assert response.json()["comparison"] is None


def test_user_model_overview_uses_immediately_previous_activation_and_pair_comparison(
    test_client, db_connection
):
    user = _register(test_client, "user@example.com")
    fridge = _create_fridge(test_client, user)
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE model_versions SET status = 'archived'
            WHERE status = 'active'
            RETURNING id, version;
            """
        )
        previous_id, previous_version = cursor.fetchone()
        cursor.execute(
            """
            INSERT INTO model_versions(
                version, model_path, status, precision, recall, map50, map50_95
            ) VALUES ('current-user-visible', 'current.pt', 'active', 0.8, 0.7, 0.75, 0.6)
            RETURNING id;
            """
        )
        current_id = cursor.fetchone()[0]
        cursor.execute(
            """
            INSERT INTO model_comparisons(
                id, dataset_version, dataset_content_sha256,
                validation_split_sha256, active_model_id, candidate_model_id,
                active_metrics, candidate_metrics, metric_differences,
                class_comparison, shared_class_comparison, added_class_metrics,
                comparison_rule, candidate_outperforms_active
            ) VALUES (
                'user-overview-comparison', 'dataset-user', %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s, 'stored rule', TRUE
            );
            """,
            (
                "a" * 64,
                "b" * 64,
                previous_id,
                current_id,
                Json({"map50_95": 0.5}),
                Json({"map50_95": 0.6}),
                Json({"map50_95": 0.1}),
                Json(
                    {
                        "active_classes": ["Apple"],
                        "candidate_classes": ["Apple", "Milk"],
                        "shared_classes": ["Apple"],
                        "added_classes": ["Milk"],
                        "removed_classes": [],
                    }
                ),
                Json({"available": True, "classes": ["Apple"]}),
                Json({"available": True, "classes": ["Milk"]}),
            ),
        )
        cursor.execute(
            """
            INSERT INTO model_activation_history(
                action, from_model_id, to_model_id, comparison_id
            ) VALUES ('PROMOTE', %s, %s, 'user-overview-comparison');
            """,
            (previous_id, current_id),
        )
    db_connection.commit()
    before = deepcopy(model_lifecycle._LIFECYCLE_JOBS)

    response = test_client.get(
        "/models/user-overview", headers=_auth(user, fridge["id"])
    )

    assert response.status_code == 200
    body = response.json()
    assert body["active_model"]["version"] == "current-user-visible"
    assert body["previous_model"]["version"] == previous_version
    assert body["comparison"]["id"] == "user-overview-comparison"
    assert body["comparison"]["current_metrics"] == {"map50_95": 0.6}
    assert body["comparison"]["previous_metrics"] == {"map50_95": 0.5}
    assert body["comparison"]["class_comparison"] == {
        "current_classes": ["Apple", "Milk"],
        "previous_classes": ["Apple"],
        "shared_classes": ["Apple"],
        "only_in_current": ["Milk"],
        "only_in_previous": [],
    }
    assert model_lifecycle._LIFECYCLE_JOBS == before
