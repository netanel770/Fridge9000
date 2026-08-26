import pytest


pytestmark = [pytest.mark.integration, pytest.mark.api]


def test_database_schema_and_health_endpoint(db_connection, test_client):
    with db_connection.cursor() as cursor:
        cursor.execute("SELECT current_database(), to_regclass('public.items');")
        database_name, items_table = cursor.fetchone()

    assert database_name.endswith("_test")
    assert items_table == "items"

    response = test_client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"

