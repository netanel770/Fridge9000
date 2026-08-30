import pytest


pytestmark = [pytest.mark.integration, pytest.mark.api, pytest.mark.e2e]

PASSWORD = "correct horse battery staple"


def register(client, email, display_name):
    response = client.post(
        "/auth/register/password",
        json={"email": email, "password": PASSWORD, "display_name": display_name},
    )
    assert response.status_code == 201
    return response.json()


def auth(session, fridge_id=None):
    headers = {"Authorization": f"Bearer {session['access_token']}"}
    if fridge_id is not None:
        headers["X-Fridge-ID"] = str(fridge_id)
    return headers


def create_fridge(client, session, name):
    response = client.post("/fridges", json={"name": name}, headers=auth(session))
    assert response.status_code == 201
    return response.json()


def test_member_correction_moderation_and_household_isolation(test_client, db_connection):
    """Exercise identity, membership, data ownership, contribution, and moderation via HTTP."""
    system_admin_headers = dict(test_client.headers)
    owner = register(test_client, "e2e-owner@example.com", "E2E Owner")
    member = register(test_client, "e2e-member@example.com", "E2E Member")
    outsider = register(test_client, "e2e-outsider@example.com", "E2E Outsider")
    fridge = create_fridge(test_client, owner, "Shared E2E Fridge")
    outsider_fridge = create_fridge(test_client, outsider, "Isolated E2E Fridge")

    joined = test_client.post(
        "/fridges/join",
        json={"join_code": fridge["join_code"]},
        headers=auth(member),
    )
    assert joined.status_code == 200
    assert joined.json()["status"] == "PENDING"
    assert test_client.get("/inventory", headers=auth(member, fridge["id"])).status_code == 403

    approved_member = test_client.post(
        f"/fridges/{fridge['id']}/members/{member['user']['id']}/approve",
        headers=auth(owner, fridge["id"]),
    )
    assert approved_member.status_code == 200
    assert approved_member.json()["status"] == "ACTIVE"

    inventory_update = test_client.post(
        "/inventory/manual",
        json={"item_name": "Milk", "action": "Added", "quantity": 2},
        headers=auth(member, fridge["id"]),
    )
    assert inventory_update.status_code == 200
    assert test_client.get("/inventory", headers=auth(member, fridge["id"])).json()[0]["name"] == "Milk"
    assert test_client.get("/inventory", headers=auth(outsider, outsider_fridge["id"])).json() == []

    scan_response = test_client.post(
        "/scans",
        json={"image_ref": "e2e-member-scan.jpg"},
        headers=auth(member, fridge["id"]),
    )
    assert scan_response.status_code == 200
    scan_id = scan_response.json()["scan_id"]
    with db_connection.cursor() as cursor:
        cursor.execute(
            "UPDATE scans SET image_width = 100, image_height = 80 WHERE id = %s;",
            (scan_id,),
        )
    db_connection.commit()

    created = test_client.post(
        f"/scans/{scan_id}/annotation-submissions",
        json={"annotations": [{
            "action": "ADD",
            "source_detection_id": None,
            "final_label": "Milk",
            "final_x1": 10,
            "final_y1": 10,
            "final_x2": 60,
            "final_y2": 55,
        }]},
        headers=auth(member, fridge["id"]),
    )
    assert created.status_code == 200
    submission_id = created.json()["submission"]["id"]

    member_history = test_client.get(
        "/annotation-submissions/mine", headers=auth(member, fridge["id"])
    )
    assert member_history.status_code == 200
    assert member_history.json()[0]["id"] == submission_id
    assert member_history.json()[0]["submitter_display_name"] == "E2E Member"

    assert test_client.get(
        f"/scans/{scan_id}", headers=auth(outsider, outsider_fridge["id"])
    ).status_code == 404
    assert test_client.get(
        f"/annotation-submissions/mine/{submission_id}",
        headers=auth(outsider, outsider_fridge["id"]),
    ).status_code == 404
    assert test_client.get(
        "/annotation-submissions", headers=auth(owner, fridge["id"])
    ).status_code == 403

    moderation_queue = test_client.get(
        "/annotation-submissions", headers=system_admin_headers
    )
    assert moderation_queue.status_code == 200
    assert [row["id"] for row in moderation_queue.json()] == [submission_id]
    moderated = test_client.patch(
        f"/annotation-submissions/{submission_id}",
        json={"status": "approved"},
        headers=system_admin_headers,
    )
    assert moderated.status_code == 200
    assert moderated.json()["submission"]["status"] == "approved"

    member_detail = test_client.get(
        f"/annotation-submissions/mine/{submission_id}",
        headers=auth(member, fridge["id"]),
    )
    assert member_detail.status_code == 200
    assert member_detail.json()["submission"]["status"] == "approved"
    assert member_detail.json()["annotations"][0]["final_label"] == "Milk"
