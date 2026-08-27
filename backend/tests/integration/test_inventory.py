import importlib
from datetime import date, timedelta

import pytest


pytestmark = [pytest.mark.integration, pytest.mark.api]


def _future_date(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


def _manual_change(
    client,
    item_name: str,
    action: str,
    quantity: int,
    expiry_date: str,
):
    response = client.post(
        "/inventory/manual",
        json={
            "item_name": item_name,
            "action": action,
            "quantity": quantity,
            "expiry_date": expiry_date,
            "expiry_source": "manual",
        },
    )
    return response


def _inventory_by_name(client):
    response = client.get("/inventory")
    assert response.status_code == 200
    return {item["name"]: item for item in response.json()}


def _batches_for(client, item_name: str):
    response = client.get("/inventory/batches")
    assert response.status_code == 200
    return [batch for batch in response.json() if batch["name"] == item_name]


def _assert_persisted_totals(db_connection, expected):
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT i.name,
                   COALESCE(SUM(b.quantity), 0) AS batch_quantity,
                   inv.quantity AS summary_quantity
            FROM items i
            LEFT JOIN inventory_batches b ON b.item_id = i.id
            LEFT JOIN inventory inv ON inv.item_id = i.id
            WHERE i.name = ANY(%s)
            GROUP BY i.id, i.name, inv.quantity
            ORDER BY i.name;
            """,
            (list(expected),),
        )
        rows = cursor.fetchall()

    actual = {
        name: (int(batch_quantity), int(summary_quantity))
        for name, batch_quantity, summary_quantity in rows
    }
    assert actual == {
        name: (quantity, quantity) for name, quantity in expected.items()
    }
    assert all(batch_quantity >= 0 for batch_quantity, _ in actual.values())


def _run_schema_initialization():
    importlib.import_module("backend.services.runtime").ensure_schema()


def test_schema_backfill_does_not_duplicate_existing_dated_batch(db_connection):
    estimated_expiry = _future_date(14)
    with db_connection.cursor() as cursor:
        cursor.execute("INSERT INTO items(name, category) VALUES ('Lemon', 'Fruit') RETURNING id;")
        item_id = cursor.fetchone()[0]
        cursor.execute(
            "INSERT INTO inventory(item_id, quantity, status) VALUES (%s, 1, 'LOW');",
            (item_id,),
        )
        cursor.execute(
            """
            INSERT INTO inventory_batches(item_id, quantity, expiry_estimate_date, expiry_source)
            VALUES (%s, 1, %s, 'estimated');
            """,
            (item_id, estimated_expiry),
        )
    db_connection.commit()

    _run_schema_initialization()
    _run_schema_initialization()

    with db_connection.cursor() as cursor:
        cursor.execute(
            "SELECT COUNT(*), SUM(quantity) FROM inventory_batches WHERE item_id = %s;",
            (item_id,),
        )
        assert cursor.fetchone() == (1, 1)
        cursor.execute("SELECT quantity FROM inventory WHERE item_id = %s;", (item_id,))
        assert cursor.fetchone()[0] == 1


def test_schema_backfill_creates_one_batch_for_genuine_legacy_inventory(db_connection):
    with db_connection.cursor() as cursor:
        cursor.execute("INSERT INTO items(name, category) VALUES ('Legacy Milk', 'Dairy') RETURNING id;")
        item_id = cursor.fetchone()[0]
        cursor.execute(
            "INSERT INTO inventory(item_id, quantity, status) VALUES (%s, 3, 'OK');",
            (item_id,),
        )
    db_connection.commit()

    _run_schema_initialization()
    _run_schema_initialization()

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT COUNT(*), SUM(quantity), MIN(expiry_source),
                   BOOL_AND(expiry_date IS NULL AND expiry_estimate_date IS NULL)
            FROM inventory_batches WHERE item_id = %s;
            """,
            (item_id,),
        )
        assert cursor.fetchone() == (1, 3, "manual", True)
        cursor.execute("SELECT quantity FROM inventory WHERE item_id = %s;", (item_id,))
        assert cursor.fetchone()[0] == 3


def test_manual_add_creates_and_accumulates_inventory(test_client, db_connection):
    expiry = _future_date(14)

    first = _manual_change(test_client, "Milk", "Added", 2, expiry)
    assert first.status_code == 200
    assert first.json()["new_quantity"] == 2

    second = _manual_change(test_client, "Milk", "Added", 3, expiry)
    assert second.status_code == 200
    assert second.json()["new_quantity"] == 5

    inventory = _inventory_by_name(test_client)
    assert inventory["Milk"]["quantity"] == 5
    batches = _batches_for(test_client, "Milk")
    assert len(batches) == 1
    assert batches[0]["quantity"] == 5
    assert batches[0]["expiry_date"] == expiry
    _assert_persisted_totals(db_connection, {"Milk": 5})

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT action, quantity_change
            FROM events e JOIN items i ON i.id = e.item_id
            WHERE i.name = 'Milk'
            ORDER BY e.id;
            """
        )
        assert cursor.fetchall() == [("Added", 2), ("Added", 3)]


def test_manual_removal_is_atomic_and_never_negative(test_client, db_connection):
    expiry = _future_date(21)
    assert _manual_change(test_client, "Apple", "Added", 3, expiry).status_code == 200

    partial = _manual_change(test_client, "Apple", "Removed", 1, expiry)
    assert partial.status_code == 200
    assert partial.json()["new_quantity"] == 2

    over_removal = _manual_change(test_client, "Apple", "Removed", 3, expiry)
    assert over_removal.status_code == 400
    assert _inventory_by_name(test_client)["Apple"]["quantity"] == 2
    _assert_persisted_totals(db_connection, {"Apple": 2})

    complete = _manual_change(test_client, "Apple", "Removed", 2, expiry)
    assert complete.status_code == 200
    assert complete.json()["new_quantity"] == 0
    assert "Apple" not in _inventory_by_name(test_client)
    assert _batches_for(test_client, "Apple") == []
    _assert_persisted_totals(db_connection, {"Apple": 0})

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT action, quantity_change
            FROM events e JOIN items i ON i.id = e.item_id
            WHERE i.name = 'Apple'
            ORDER BY e.id;
            """
        )
        assert cursor.fetchall() == [("Added", 3), ("Removed", 1), ("Removed", 2)]
        cursor.execute("SELECT MIN(quantity) FROM inventory_batches;")
        assert cursor.fetchone()[0] == 0


def test_specific_batch_changes_preserve_other_batches_and_products(
    test_client, db_connection
):
    early = _future_date(10)
    late = _future_date(30)
    bread_expiry = _future_date(7)
    assert _manual_change(test_client, "Yogurt", "Added", 3, early).status_code == 200
    assert _manual_change(test_client, "Yogurt", "Added", 2, late).status_code == 200
    assert _manual_change(test_client, "Bread", "Added", 4, bread_expiry).status_code == 200

    yogurt_batches = {batch["expiry_date"]: batch for batch in _batches_for(test_client, "Yogurt")}
    early_batch = yogurt_batches[early]
    late_batch = yogurt_batches[late]

    partial = test_client.post(
        f"/inventory/batches/{early_batch['id']}/remove-quantity",
        json={"quantity": 2},
    )
    assert partial.status_code == 200
    assert partial.json()["remaining_quantity"] == 1

    rejected = test_client.post(
        f"/inventory/batches/{early_batch['id']}/remove-quantity",
        json={"quantity": 2},
    )
    assert rejected.status_code == 409

    removed = test_client.post(f"/inventory/batches/{late_batch['id']}/remove")
    assert removed.status_code == 200
    assert removed.json()["removed_quantity"] == 2

    inventory = _inventory_by_name(test_client)
    assert inventory["Yogurt"]["quantity"] == 1
    assert inventory["Bread"]["quantity"] == 4
    remaining_yogurt = _batches_for(test_client, "Yogurt")
    assert [(batch["id"], batch["quantity"]) for batch in remaining_yogurt] == [
        (early_batch["id"], 1)
    ]
    _assert_persisted_totals(db_connection, {"Bread": 4, "Yogurt": 1})

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT e.quantity_change
            FROM events e JOIN items i ON i.id = e.item_id
            WHERE i.name = 'Yogurt' AND e.action = 'Removed'
            ORDER BY e.id;
            """
        )
        assert cursor.fetchall() == [(2,), (2,)]


def test_remaining_percentage_boundaries_and_validation(test_client, db_connection):
    expiry = _future_date(20)
    assert _manual_change(test_client, "Juice", "Added", 2, expiry).status_code == 200
    original_batch = _batches_for(test_client, "Juice")[0]

    halfway = test_client.patch(
        f"/inventory/batches/{original_batch['id']}/remaining",
        json={"remaining_percent": 50},
    )
    assert halfway.status_code == 200
    partial_batch_id = halfway.json()["batch"]["id"]
    batches = _batches_for(test_client, "Juice")
    assert sorted(batch["quantity"] for batch in batches) == [1, 1]
    assert sorted(
        batch["open_unit_remaining_percent"] or 100 for batch in batches
    ) == [50, 100]
    inventory = _inventory_by_name(test_client)["Juice"]
    assert inventory["quantity"] == 2
    assert float(inventory["estimated_quantity"]) == pytest.approx(1.5)

    full = test_client.patch(
        f"/inventory/batches/{partial_batch_id}/remaining",
        json={"remaining_percent": 100},
    )
    assert full.status_code == 200
    assert full.json()["batch"]["open_unit_remaining_percent"] is None
    assert float(
        _inventory_by_name(test_client)["Juice"]["estimated_quantity"]
    ) == pytest.approx(2)

    for invalid in (-1, 101):
        response = test_client.patch(
            f"/inventory/batches/{partial_batch_id}/remaining",
            json={"remaining_percent": invalid},
        )
        assert response.status_code == 400
    assert _inventory_by_name(test_client)["Juice"]["quantity"] == 2

    empty_one = test_client.patch(
        f"/inventory/batches/{partial_batch_id}/remaining",
        json={"remaining_percent": 0},
    )
    assert empty_one.status_code == 200
    assert empty_one.json()["batch"]["quantity"] == 0
    assert _inventory_by_name(test_client)["Juice"]["quantity"] == 1
    _assert_persisted_totals(db_connection, {"Juice": 1})

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT quantity, open_unit_remaining_percent
            FROM inventory_batches b JOIN items i ON i.id = b.item_id
            WHERE i.name = 'Juice';
            """
        )
        persisted_batches = cursor.fetchall()
    assert all(quantity >= 0 for quantity, _ in persisted_batches)
    assert all(percent is None or 1 <= percent <= 99 for _, percent in persisted_batches)
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT e.quantity_change
            FROM events e JOIN items i ON i.id = e.item_id
            WHERE i.name = 'Juice' AND e.action = 'Removed';
            """
        )
        assert cursor.fetchall() == [(1,)]


def test_expiry_update_targets_only_the_selected_batch(test_client, db_connection):
    first_expiry = _future_date(8)
    second_expiry = _future_date(18)
    replacement_expiry = _future_date(28)
    assert _manual_change(test_client, "Eggs", "Added", 1, first_expiry).status_code == 200
    assert _manual_change(test_client, "Eggs", "Added", 1, second_expiry).status_code == 200
    batches = {batch["expiry_date"]: batch for batch in _batches_for(test_client, "Eggs")}

    response = test_client.patch(
        f"/inventory/batches/{batches[first_expiry]['id']}/expiry",
        json={"expiry_date": replacement_expiry},
    )
    assert response.status_code == 200
    assert response.json()["batch"]["expiry_date"] == replacement_expiry

    updated = {batch["id"]: batch for batch in _batches_for(test_client, "Eggs")}
    assert updated[batches[first_expiry]["id"]]["expiry_date"] == replacement_expiry
    assert updated[batches[second_expiry]["id"]]["expiry_date"] == second_expiry
    assert all(batch["expiry_source"] == "manual" for batch in updated.values())
    assert _inventory_by_name(test_client)["Eggs"]["quantity"] == 2
    _assert_persisted_totals(db_connection, {"Eggs": 2})


def test_legacy_event_mutations_keep_batches_and_summary_consistent(
    test_client, db_connection
):
    expiry = _future_date(12)
    assert _manual_change(test_client, "Cheese", "Added", 1, expiry).status_code == 200

    added = test_client.post(
        "/events",
        json={"item_name": "Cheese", "action": "Added", "confidence": 1.0},
    )
    assert added.status_code == 200
    assert added.json()["ok"] is True
    assert _inventory_by_name(test_client)["Cheese"]["quantity"] == 2
    _assert_persisted_totals(db_connection, {"Cheese": 2})

    removed = test_client.post(
        "/events",
        json={"item_name": "Cheese", "action": "Removed", "confidence": 1.0},
    )
    assert removed.status_code == 200
    assert removed.json()["ok"] is True
    assert _inventory_by_name(test_client)["Cheese"]["quantity"] == 1
    _assert_persisted_totals(db_connection, {"Cheese": 1})


def test_reset_clears_authoritative_inventory_state(test_client, db_connection):
    assert _manual_change(
        test_client, "Tomatoes", "Added", 2, _future_date(6)
    ).status_code == 200
    assert _manual_change(
        test_client, "Cucumber", "Added", 1, _future_date(9)
    ).status_code == 200
    assert len(_inventory_by_name(test_client)) == 2

    response = test_client.post("/inventory/reset")
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert _inventory_by_name(test_client) == {}
    assert test_client.get("/inventory/batches").json() == []

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
                (SELECT COUNT(*) FROM inventory_batches),
                (SELECT COUNT(*) FROM inventory),
                (SELECT COUNT(*) FROM events);
            """
        )
        assert cursor.fetchone() == (0, 0, 0)
