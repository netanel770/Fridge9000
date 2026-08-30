import importlib
import uuid
from contextlib import closing
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import psycopg2
import pytest
from psycopg2 import sql


pytestmark = pytest.mark.integration

PROJECT_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = PROJECT_ROOT / "db" / "init.sql"


def _database_url_with_name(database_url: str, database_name: str) -> str:
    parsed = urlparse(database_url)
    return urlunparse(parsed._replace(path=f"/{database_name}"))


def test_init_sql_defines_complete_current_schema(test_database_url, monkeypatch):
    database_name = f"fridge9000_schema_{uuid.uuid4().hex}_test"
    admin_url = _database_url_with_name(test_database_url, "postgres")
    fresh_url = _database_url_with_name(test_database_url, database_name)

    with closing(psycopg2.connect(admin_url)) as admin:
        admin.autocommit = True
        with admin.cursor() as cursor:
            cursor.execute(
                sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database_name))
            )

    try:
        with closing(psycopg2.connect(fresh_url)) as connection:
            with connection:
                with connection.cursor() as cursor:
                    cursor.execute(SCHEMA_PATH.read_text(encoding="utf-8"))

        schema = importlib.import_module("db.schema")
        monkeypatch.setattr(schema, "get_conn", lambda: psycopg2.connect(fresh_url))
        schema.ensure_schema()

        with closing(psycopg2.connect(fresh_url)) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT table_name
                    FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
                    """
                )
                tables = {row[0] for row in cursor.fetchall()}
                assert {
                    "items",
                    "inventory",
                    "inventory_batches",
                    "scans",
                    "events",
                    "scan_detections",
                    "representative_outlines",
                    "detection_reviews",
                    "annotation_submissions",
                    "annotations",
                    "training_runs",
                    "model_versions",
                    "training_run_submission_usage",
                    "training_run_annotation_usage",
                    "model_comparisons",
                    "model_activation_history",
                    "users",
                    "refresh_sessions",
                    "auth_identities",
                    "households",
                    "household_memberships",
                } <= tables

                cursor.execute(
                    """
                    SELECT table_name, column_name, is_nullable, data_type, column_default
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND (table_name, column_name) IN (
                        ('annotation_submissions', 'training_state'),
                        ('annotation_submissions', 'archived_at'),
                        ('training_run_submission_usage', 'is_experimental'),
                        ('training_run_annotation_usage', 'is_experimental'),
                        ('model_comparisons', 'validation_split_sha256'),
                        ('model_comparisons', 'class_comparison'),
                        ('model_comparisons', 'shared_class_comparison'),
                        ('model_comparisons', 'added_class_metrics'),
                        ('inventory_batches', 'open_unit_remaining_percent'),
                        ('representative_outlines', 'style_version')
                      );
                    """
                )
                columns = {
                    (row[0], row[1]): {
                        "nullable": row[2],
                        "type": row[3],
                        "default": row[4],
                    }
                    for row in cursor.fetchall()
                }
                assert set(columns) == {
                    ("annotation_submissions", "training_state"),
                    ("annotation_submissions", "archived_at"),
                    ("training_run_submission_usage", "is_experimental"),
                    ("training_run_annotation_usage", "is_experimental"),
                    ("model_comparisons", "validation_split_sha256"),
                    ("model_comparisons", "class_comparison"),
                    ("model_comparisons", "shared_class_comparison"),
                    ("model_comparisons", "added_class_metrics"),
                    ("inventory_batches", "open_unit_remaining_percent"),
                    ("representative_outlines", "style_version"),
                }
                assert columns[("annotation_submissions", "training_state")]["nullable"] == "NO"
                assert "eligible" in columns[("annotation_submissions", "training_state")]["default"]
                assert columns[("annotation_submissions", "archived_at")] == {
                    "nullable": "YES",
                    "type": "timestamp with time zone",
                    "default": None,
                }
                for usage_table in (
                    "training_run_submission_usage",
                    "training_run_annotation_usage",
                ):
                    metadata = columns[(usage_table, "is_experimental")]
                    assert metadata == {
                        "nullable": "NO",
                        "type": "boolean",
                        "default": "false",
                    }
                assert columns[("model_comparisons", "validation_split_sha256")]["nullable"] == "NO"
                assert columns[("representative_outlines", "style_version")]["default"] == "2"

                cursor.execute(
                    """
                    SELECT conname
                    FROM pg_constraint
                    WHERE connamespace = 'public'::regnamespace;
                    """
                )
                constraints = {row[0] for row in cursor.fetchall()}
                assert {
                    "annotation_submissions_training_state_check",
                    "inventory_batches_remaining_percent_check",
                    "scans_source_check",
                } <= constraints

                cursor.execute(
                    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public';"
                )
                indexes = {row[0] for row in cursor.fetchall()}
                assert {
                    "idx_annotation_submissions_training_state",
                    "idx_model_versions_single_active",
                    "idx_model_versions_single_candidate",
                    "idx_inventory_batches_item_id",
                } <= indexes

                cursor.execute(
                    "SELECT COUNT(*) FROM model_versions WHERE status = 'active';"
                )
                assert cursor.fetchone()[0] == 1
    finally:
        with closing(psycopg2.connect(admin_url)) as admin:
            admin.autocommit = True
            with admin.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s;",
                    (database_name,),
                )
                cursor.execute(
                    sql.SQL("DROP DATABASE IF EXISTS {}").format(
                        sql.Identifier(database_name)
                    )
                )


def test_auth_foundation_tables_have_expected_schema(db_connection):
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT table_name, column_name, is_nullable, data_type, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('users', 'refresh_sessions', 'auth_identities');
            """
        )
        columns = {
            (row[0], row[1]): {
                "nullable": row[2],
                "type": row[3],
                "default": row[4],
            }
            for row in cursor.fetchall()
        }

        assert {name for table, name in columns if table == "users"} == {
            "id",
            "email",
            "display_name",
            "password_hash",
            "is_active",
            "is_system_admin",
            "created_at",
            "updated_at",
        }
        assert {name for table, name in columns if table == "refresh_sessions"} == {
            "id",
            "user_id",
            "token_hash",
            "created_at",
            "expires_at",
            "revoked_at",
        }
        assert {name for table, name in columns if table == "auth_identities"} == {
            "id",
            "user_id",
            "provider",
            "provider_subject",
            "verified_email",
            "created_at",
        }
        assert columns[("users", "email")]["nullable"] == "NO"
        assert columns[("users", "password_hash")]["nullable"] == "YES"
        assert columns[("users", "is_active")]["default"] == "true"
        assert columns[("users", "is_system_admin")]["default"] == "false"
        assert columns[("refresh_sessions", "id")]["type"] == "uuid"
        assert columns[("refresh_sessions", "revoked_at")]["nullable"] == "YES"


def test_runtime_schema_creates_auth_tables_idempotently(db_connection):
    with db_connection.cursor() as cursor:
        cursor.execute("DROP TABLE auth_identities;")
        cursor.execute("DROP TABLE refresh_sessions;")
    db_connection.commit()

    schema = importlib.import_module("db.schema")
    schema.ensure_schema()
    schema.ensure_schema()

    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('users', 'refresh_sessions', 'auth_identities');
            """
        )
        assert {row[0] for row in cursor.fetchall()} == {
            "users",
            "refresh_sessions",
            "auth_identities",
        }


def test_auth_identity_requires_user_and_unique_provider_subject(db_connection):
    with db_connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO users(email) VALUES (%s) RETURNING id;",
            ("person@example.com",),
        )
        user_id = cursor.fetchone()[0]
        cursor.execute(
            """
            INSERT INTO auth_identities(
                user_id, provider, provider_subject, verified_email
            ) VALUES (%s, 'GOOGLE', 'subject-123', %s);
            """,
            (user_id, "person@example.com"),
        )
    db_connection.commit()

    with pytest.raises(psycopg2.errors.UniqueViolation):
        with db_connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO auth_identities(user_id, provider, provider_subject)
                VALUES (%s, 'GOOGLE', 'subject-123');
                """,
                (user_id,),
            )
    db_connection.rollback()

    with pytest.raises(psycopg2.errors.ForeignKeyViolation):
        with db_connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO auth_identities(user_id, provider, provider_subject)
                VALUES (999999, 'GOOGLE', 'missing-user');
                """
            )
    db_connection.rollback()


def test_household_schema_and_legacy_ownership_are_present(db_connection):
    with db_connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT name, join_code, creator_user_id, is_legacy
            FROM households WHERE id = 1;
            """
        )
        assert cursor.fetchone() == (
            "Legacy Fridge Data",
            "LEGACY-DATA",
            None,
            True,
        )
        cursor.execute(
            """
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND (table_name, column_name) IN (
                ('inventory', 'household_id'),
                ('inventory_batches', 'household_id'),
                ('scans', 'household_id'),
                ('scans', 'created_by_user_id'),
                ('events', 'household_id'),
                ('annotation_submissions', 'household_id'),
                ('annotation_submissions', 'created_by_user_id')
              );
            """
        )
        assert set(cursor.fetchall()) == {
            ("inventory", "household_id"),
            ("inventory_batches", "household_id"),
            ("scans", "household_id"),
            ("scans", "created_by_user_id"),
            ("events", "household_id"),
            ("annotation_submissions", "household_id"),
            ("annotation_submissions", "created_by_user_id"),
        }

def test_user_email_uniqueness_is_case_insensitive(db_connection):
    with db_connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO users(email) VALUES (%s);",
            ("Person@example.com",),
        )
    db_connection.commit()

    with pytest.raises(psycopg2.errors.UniqueViolation):
        with db_connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO users(email) VALUES (%s);",
                ("person@EXAMPLE.com",),
            )
    db_connection.rollback()


def test_refresh_session_requires_existing_user(db_connection):
    with pytest.raises(psycopg2.errors.ForeignKeyViolation):
        with db_connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO refresh_sessions(id, user_id, token_hash, expires_at)
                VALUES (%s, %s, %s, NOW() + INTERVAL '30 days');
                """,
                (str(uuid.uuid4()), 999_999, "missing-user-token-hash"),
            )
    db_connection.rollback()
