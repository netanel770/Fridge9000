import importlib
import os
import shutil
import uuid
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote, urlparse

import psycopg2
import pytest
from fastapi.testclient import TestClient
from psycopg2 import sql


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = PROJECT_ROOT / "db" / "init.sql"
DEFAULT_TEST_DATABASE_URL = (
    "postgresql://fridge_test:fridge_test_pass@localhost:5433/fridge9000_test"
)
_ORIGINAL_DATABASE_URL = os.environ.get("DATABASE_URL")
_ORIGINAL_TESTING_FLAG = os.environ.get("FRIDGE9000_TESTING")
_ORIGINAL_TRAINING_PROVIDER = os.environ.get("TRAINING_PROVIDER")
_ORIGINAL_UPLOAD_DIR = os.environ.get("UPLOAD_DIR")


def pytest_configure(config):
    configured_basetemp = getattr(config.option, "basetemp", None)
    if configured_basetemp is None:
        session_temp = (
            PROJECT_ROOT
            / "backend"
            / f".pytest-tmp-{os.getpid()}-{uuid.uuid4().hex}"
        )
        config.option.basetemp = str(session_temp)
        config._fridge9000_session_temp = session_temp
    else:
        session_temp = Path(configured_basetemp)

    test_upload_dir = session_temp / "fridge9000-test-uploads"
    test_upload_dir.mkdir(parents=True, exist_ok=True)
    os.environ["TRAINING_PROVIDER"] = "local"
    os.environ["UPLOAD_DIR"] = str(test_upload_dir)


def pytest_unconfigure(config):
    session_temp = getattr(config, "_fridge9000_session_temp", None)
    if session_temp is not None:
        shutil.rmtree(session_temp, ignore_errors=True)
    if _ORIGINAL_TRAINING_PROVIDER is None:
        os.environ.pop("TRAINING_PROVIDER", None)
    else:
        os.environ["TRAINING_PROVIDER"] = _ORIGINAL_TRAINING_PROVIDER
    if _ORIGINAL_UPLOAD_DIR is None:
        os.environ.pop("UPLOAD_DIR", None)
    else:
        os.environ["UPLOAD_DIR"] = _ORIGINAL_UPLOAD_DIR


def _database_name(database_url: str) -> str:
    parsed = urlparse(database_url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise pytest.UsageError("TEST_DATABASE_URL must be a PostgreSQL URL.")

    database_name = unquote(parsed.path.lstrip("/"))
    if not database_name:
        raise pytest.UsageError("TEST_DATABASE_URL must include a database name.")
    return database_name


def _assert_safe_test_database(database_url: str) -> str:
    database_name = _database_name(database_url)
    if database_name == "fridge9000" or not database_name.endswith("_test"):
        raise pytest.UsageError(
            "Refusing to run database tests against a non-test database. "
            "TEST_DATABASE_URL must name a database ending in '_test'."
        )
    return database_name


CONFIGURED_TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL", DEFAULT_TEST_DATABASE_URL
)
_assert_safe_test_database(CONFIGURED_TEST_DATABASE_URL)
# conftest is imported before test modules, so production configuration can
# never capture the development database URL during test collection.
os.environ["DATABASE_URL"] = CONFIGURED_TEST_DATABASE_URL
os.environ["FRIDGE9000_TESTING"] = "1"


def _connect(database_url: str):
    expected_database = _assert_safe_test_database(database_url)
    connection = psycopg2.connect(database_url)
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_database();")
        connected_database = cursor.fetchone()[0]
    if connected_database != expected_database:
        connection.close()
        raise RuntimeError(
            f"Connected to unexpected database '{connected_database}', expected "
            f"'{expected_database}'."
        )
    connection.rollback()
    return connection


def _initialize_schema(database_url: str) -> None:
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")
    with closing(_connect(database_url)) as connection:
        with connection:
            with connection.cursor() as cursor:
                cursor.execute(schema_sql)


def _reset_database(database_url: str) -> None:
    with closing(_connect(database_url)) as connection:
        with connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT tablename FROM pg_tables WHERE schemaname = 'public';"
                )
                table_names = [row[0] for row in cursor.fetchall()]
                if table_names:
                    tables = sql.SQL(", ").join(
                        sql.Identifier("public", table_name)
                        for table_name in table_names
                    )
                    cursor.execute(
                        sql.SQL(
                            "TRUNCATE TABLE {} RESTART IDENTITY CASCADE;"
                        ).format(tables)
                    )
    _initialize_schema(database_url)


@pytest.fixture(scope="session")
def test_database_url() -> str:
    return CONFIGURED_TEST_DATABASE_URL


@pytest.fixture(scope="session", autouse=True)
def test_environment(test_database_url):
    test_upload_dir = Path(os.environ["UPLOAD_DIR"])
    test_upload_dir.mkdir(parents=True, exist_ok=True)
    replacements = {
        "DATABASE_URL": test_database_url,
        "FRIDGE9000_TESTING": "1",
        "TRAINING_PROVIDER": "local",
        "UPLOAD_DIR": str(test_upload_dir),
    }
    previous = {name: os.environ.get(name) for name in replacements}
    os.environ.update(replacements)
    try:
        yield replacements
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        if _ORIGINAL_DATABASE_URL is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = _ORIGINAL_DATABASE_URL
        if _ORIGINAL_TESTING_FLAG is None:
            os.environ.pop("FRIDGE9000_TESTING", None)
        else:
            os.environ["FRIDGE9000_TESTING"] = _ORIGINAL_TESTING_FLAG


@pytest.fixture(scope="session")
def initialized_test_database(test_database_url, test_environment):
    try:
        _initialize_schema(test_database_url)
    except psycopg2.OperationalError as exc:
        pytest.skip(
            "Test PostgreSQL is unavailable. Start it with "
            "'docker compose -f docker-compose.test.yml up -d --wait'. "
            f"Connection error: {exc}"
        )
    return test_database_url


@pytest.fixture
def isolated_database(initialized_test_database):
    _reset_database(initialized_test_database)
    try:
        yield initialized_test_database
    finally:
        _reset_database(initialized_test_database)


@pytest.fixture
def db_connection(isolated_database):
    connection = _connect(isolated_database)
    try:
        yield connection
    finally:
        connection.rollback()
        connection.close()


@pytest.fixture
def fastapi_app(isolated_database):
    main_module = importlib.import_module("backend.main")
    with patch.object(
        main_module.runtime, "get_detection_model", return_value=None
    ):
        yield main_module.app


@pytest.fixture
def test_client(fastapi_app, initialized_test_database, request):
    upload_dir = Path(os.environ["UPLOAD_DIR"])
    upload_dir.mkdir(parents=True, exist_ok=True)
    (upload_dir / "freshness").mkdir(parents=True, exist_ok=True)
    (upload_dir / "outlines").mkdir(parents=True, exist_ok=True)
    with TestClient(fastapi_app) as client:
        auth_test_files = {
            "test_auth.py",
            "test_google_auth_api.py",
            "test_households.py",
            "test_admin_permissions.py",
        }
        if request.node.path.name not in auth_test_files:
            registered = client.post(
                "/auth/register/password",
                json={
                    "email": "legacy-test-user@example.com",
                    "password": "legacy test password",
                },
            ).json()
            with closing(_connect(initialized_test_database)) as connection:
                with connection:
                    with connection.cursor() as cursor:
                        cursor.execute(
                            "UPDATE users SET is_system_admin = TRUE WHERE id = %s;",
                            (registered["user"]["id"],),
                        )
                        cursor.execute(
                            """
                            INSERT INTO household_memberships(
                                household_id, user_id, role, status
                            ) VALUES (1, %s, 'OWNER', 'ACTIVE');
                            """,
                            (registered["user"]["id"],),
                        )
            client.headers.update(
                {
                    "Authorization": f"Bearer {registered['access_token']}",
                    "X-Fridge-ID": "1",
                }
            )
        yield client
