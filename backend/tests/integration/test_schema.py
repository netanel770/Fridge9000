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

        runtime = importlib.import_module("backend.services.runtime")
        monkeypatch.setattr(runtime, "get_conn", lambda: psycopg2.connect(fresh_url))
        runtime.ensure_schema()

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
                } <= tables

                cursor.execute(
                    """
                    SELECT table_name, column_name, is_nullable, data_type, column_default
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND (table_name, column_name) IN (
                        ('annotation_submissions', 'training_state'),
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
