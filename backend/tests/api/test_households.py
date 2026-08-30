import pytest


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


def _create_fridge(client, auth_body, name):
    response = client.post(
        "/fridges", json={"name": name}, headers=_auth(auth_body)
    )
    assert response.status_code == 201
    return response.json()


def _join_and_approve(client, owner, member, fridge):
    joined = client.post(
        "/fridges/join",
        json={"join_code": fridge["join_code"]},
        headers=_auth(member),
    )
    assert joined.status_code == 200
    assert joined.json()["status"] == "PENDING"
    approved = client.post(
        f"/fridges/{fridge['id']}/members/{member['user']['id']}/approve",
        headers=_auth(owner, fridge["id"]),
    )
    assert approved.status_code == 200


def test_create_join_approve_reject_remove_and_visibility(test_client):
    owner = _register(test_client, "owner@example.com")
    member = _register(test_client, "member@example.com")
    rejected = _register(test_client, "rejected@example.com")
    fridge = _create_fridge(test_client, owner, "Home Fridge")
    second = _create_fridge(test_client, owner, "Garage Fridge")

    assert fridge["role"] == "OWNER"
    assert fridge["status"] == "ACTIVE"
    assert fridge["join_code"] != second["join_code"]

    pending = test_client.post(
        "/fridges/join",
        json={"join_code": fridge["join_code"]},
        headers=_auth(member),
    )
    assert pending.status_code == 200
    assert pending.json()["status"] == "PENDING"
    assert test_client.get(
        "/inventory", headers=_auth(member, fridge["id"])
    ).status_code == 403

    assert test_client.post(
        f"/fridges/{fridge['id']}/members/{member['user']['id']}/approve",
        headers=_auth(owner, fridge["id"]),
    ).status_code == 200
    mine = test_client.get("/fridges/mine", headers=_auth(member)).json()
    assert mine == [
        {
            "fridge_id": fridge["id"],
            "fridge_name": "Home Fridge",
            "role": "MEMBER",
            "status": "ACTIVE",
        }
    ]
    assert "join_code" not in str(mine)
    assert test_client.get(
        f"/fridges/{fridge['id']}/members",
        headers=_auth(member, fridge["id"]),
    ).status_code == 403

    assert test_client.post(
        "/fridges/join",
        json={"join_code": fridge["join_code"]},
        headers=_auth(rejected),
    ).status_code == 200
    assert test_client.post(
        f"/fridges/{fridge['id']}/members/{rejected['user']['id']}/reject",
        headers=_auth(owner, fridge["id"]),
    ).json()["status"] == "REJECTED"
    assert test_client.post(
        "/fridges/join",
        json={"join_code": fridge["join_code"]},
        headers=_auth(rejected),
    ).json()["status"] == "PENDING"

    assert test_client.post(
        f"/fridges/{fridge['id']}/members/{member['user']['id']}/remove",
        headers=_auth(owner, fridge["id"]),
    ).json()["status"] == "REMOVED"
    assert test_client.get(
        "/inventory", headers=_auth(member, fridge["id"])
    ).status_code == 403
    owner_removal = test_client.post(
        f"/fridges/{fridge['id']}/members/{owner['user']['id']}/remove",
        headers=_auth(owner, fridge["id"]),
    )
    assert owner_removal.status_code == 409


def test_household_inventory_and_scan_isolation(test_client, db_connection):
    user_a = _register(test_client, "a@example.com")
    user_b = _register(test_client, "b@example.com")
    fridge_a = _create_fridge(test_client, user_a, "Fridge A")
    fridge_b = _create_fridge(test_client, user_b, "Fridge B")

    added = test_client.post(
        "/inventory/manual",
        json={"item_name": "Milk", "action": "Added", "quantity": 2},
        headers=_auth(user_b, fridge_b["id"]),
    )
    assert added.status_code == 200
    batches_b = test_client.get(
        "/inventory/batches", headers=_auth(user_b, fridge_b["id"])
    ).json()
    assert len(batches_b) == 1
    assert test_client.get(
        "/inventory", headers=_auth(user_a, fridge_a["id"])
    ).json() == []
    guessed_batch = test_client.post(
        f"/inventory/batches/{batches_b[0]['id']}/remove",
        headers=_auth(user_a, fridge_a["id"]),
    )
    assert guessed_batch.status_code == 404

    scan_b = test_client.post(
        "/scans",
        json={"image_ref": "private-b.jpg"},
        headers=_auth(user_b, fridge_b["id"]),
    ).json()
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE scans SET image_width = 100, image_height = 100 WHERE id = %s;",
            (scan_b["scan_id"],),
        )
    db_connection.commit()
    assert test_client.get(
        f"/scans/{scan_b['scan_id']}",
        headers=_auth(user_a, fridge_a["id"]),
    ).status_code == 404


def test_manager_restrictions_and_explicit_multi_fridge_selection(
    test_client, db_connection
):
    owner = _register(test_client, "owner@example.com")
    manager = _register(test_client, "manager@example.com")
    fridge = _create_fridge(test_client, owner, "First")
    _create_fridge(test_client, owner, "Second")
    _join_and_approve(test_client, owner, manager, fridge)
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE household_memberships SET role = 'MANAGER'
            WHERE household_id = %s AND user_id = %s;
            """,
            (fridge["id"], manager["user"]["id"]),
        )
    db_connection.commit()

    assert test_client.get("/inventory", headers=_auth(owner)).status_code == 400
    management = test_client.get(
        f"/fridges/{fridge['id']}/members",
        headers=_auth(manager, fridge["id"]),
    )
    assert management.status_code == 200
    assert management.json()["join_code"] == fridge["join_code"]
    cannot_remove_owner = test_client.post(
        f"/fridges/{fridge['id']}/members/{owner['user']['id']}/remove",
        headers=_auth(manager, fridge["id"]),
    )
    assert cannot_remove_owner.status_code == 409


def test_scan_and_contribution_ownership_within_household(
    test_client, db_connection
):
    owner = _register(test_client, "owner@example.com")
    member = _register(test_client, "member@example.com")
    fridge = _create_fridge(test_client, owner, "Shared Fridge")
    _join_and_approve(test_client, owner, member, fridge)

    owner_scan = test_client.post(
        "/scans",
        json={"image_ref": "owner.jpg"},
        headers=_auth(owner, fridge["id"]),
    ).json()["scan_id"]
    member_scan = test_client.post(
        "/scans",
        json={"image_ref": "member.jpg"},
        headers=_auth(member, fridge["id"]),
    ).json()["scan_id"]
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE scans SET image_width = 100, image_height = 100 WHERE id IN (%s, %s);",
            (owner_scan, member_scan),
        )
    db_connection.commit()

    owner_recent = test_client.get(
        "/scans/recent", headers=_auth(owner, fridge["id"])
    ).json()
    member_recent = test_client.get(
        "/scans/recent", headers=_auth(member, fridge["id"])
    ).json()
    assert [row["id"] for row in owner_recent] == [owner_scan]
    assert [row["id"] for row in member_recent] == [member_scan]

    annotation = {
        "annotations": [
            {
                "action": "ADD",
                "final_label": "Milk",
                "final_x1": 10,
                "final_y1": 10,
                "final_x2": 50,
                "final_y2": 50,
            }
        ]
    }
    own = test_client.post(
        f"/scans/{owner_scan}/annotation-submissions",
        json=annotation,
        headers=_auth(owner, fridge["id"]),
    )
    assert own.status_code == 200
    annotation_id = own.json()["annotations"][0]["id"]
    other = test_client.post(
        f"/scans/{owner_scan}/annotation-submissions",
        json=annotation,
        headers=_auth(member, fridge["id"]),
    )
    assert other.status_code == 404
    assert test_client.patch(
        f"/annotations/{annotation_id}",
        json={"final_label": "Stolen edit"},
        headers=_auth(member, fridge["id"]),
    ).status_code == 404
    assert len(
        test_client.get(
            "/annotation-submissions/mine",
            headers=_auth(owner, fridge["id"]),
        ).json()
    ) == 1
    submission_id = own.json()["submission"]["id"]
    own_detail = test_client.get(
        f"/annotation-submissions/mine/{submission_id}",
        headers=_auth(owner, fridge["id"]),
    )
    assert own_detail.status_code == 200
    assert own_detail.json()["annotations"][0]["id"] == annotation_id
    assert test_client.get(
        f"/annotation-submissions/mine/{submission_id}",
        headers=_auth(member, fridge["id"]),
    ).status_code == 404
    assert test_client.get(
        "/annotation-submissions/mine",
        headers=_auth(member, fridge["id"]),
    ).json() == []
