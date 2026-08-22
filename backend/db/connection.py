import psycopg2

try:
    from core.config import DATABASE_URL
except ModuleNotFoundError:
    from backend.core.config import DATABASE_URL


def get_conn():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg2.connect(DATABASE_URL)
