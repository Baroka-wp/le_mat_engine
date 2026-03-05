"""
Le Mat — DB Engine
SQLite CRUD wrapper used by the auto-generated data API.
"""

import sqlite3
from pathlib import Path
from typing import Any, Optional


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ── Schema ────────────────────────────────────────────────────────────────────

def migrate(db_path: Path, sql_statements: list[str]) -> None:
    """Apply CREATE TABLE IF NOT EXISTS statements."""
    with _connect(db_path) as conn:
        for stmt in sql_statements:
            conn.execute(stmt)
        conn.commit()


def list_tables(db_path: Path) -> list[str]:
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%' "
            "ORDER BY name"
        ).fetchall()
        return [r["name"] for r in rows]


def table_columns(db_path: Path, table: str) -> list[dict]:
    with _connect(db_path) as conn:
        return [dict(r) for r in conn.execute(f'PRAGMA table_info("{table}")').fetchall()]


def row_count(db_path: Path, table: str) -> int:
    with _connect(db_path) as conn:
        return conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]


# ── CRUD ──────────────────────────────────────────────────────────────────────

def select_all(
    db_path: Path,
    table: str,
    filters: Optional[dict] = None,
    limit: int = 500,
    offset: int = 0,
    order_by: Optional[str] = None,
) -> list[dict]:
    with _connect(db_path) as conn:
        clause, params = _where(filters)
        order = f' ORDER BY "{order_by}"' if order_by else ""
        rows = conn.execute(
            f'SELECT * FROM "{table}"{clause}{order} LIMIT ? OFFSET ?',
            params + [limit, offset],
        ).fetchall()
        return [dict(r) for r in rows]


def select_one(db_path: Path, table: str, pk_col: str, pk_val: Any) -> Optional[dict]:
    with _connect(db_path) as conn:
        row = conn.execute(
            f'SELECT * FROM "{table}" WHERE "{pk_col}" = ?', [pk_val]
        ).fetchone()
        return dict(row) if row else None


def insert(db_path: Path, table: str, data: dict) -> dict:
    with _connect(db_path) as conn:
        cols = ", ".join(f'"{k}"' for k in data)
        vals = ", ".join("?" for _ in data)
        cur = conn.execute(
            f'INSERT INTO "{table}" ({cols}) VALUES ({vals})', list(data.values())
        )
        conn.commit()
        pk_col = _pk(conn, table)
        row = conn.execute(
            f'SELECT * FROM "{table}" WHERE "{pk_col}" = ?', [cur.lastrowid]
        ).fetchone()
        return dict(row) if row else {}


def update(
    db_path: Path, table: str, pk_col: str, pk_val: Any, data: dict
) -> Optional[dict]:
    with _connect(db_path) as conn:
        sets = ", ".join(f'"{k}" = ?' for k in data)
        conn.execute(
            f'UPDATE "{table}" SET {sets} WHERE "{pk_col}" = ?',
            list(data.values()) + [pk_val],
        )
        conn.commit()
        row = conn.execute(
            f'SELECT * FROM "{table}" WHERE "{pk_col}" = ?', [pk_val]
        ).fetchone()
        return dict(row) if row else None


def delete(db_path: Path, table: str, pk_col: str, pk_val: Any) -> bool:
    with _connect(db_path) as conn:
        cur = conn.execute(
            f'DELETE FROM "{table}" WHERE "{pk_col}" = ?', [pk_val]
        )
        conn.commit()
        return cur.rowcount > 0


# ── Helpers ───────────────────────────────────────────────────────────────────

def _where(filters: Optional[dict]) -> tuple[str, list]:
    if not filters:
        return "", []
    clause = " WHERE " + " AND ".join(f'"{k}" = ?' for k in filters)
    return clause, list(filters.values())


def _pk(conn: sqlite3.Connection, table: str) -> str:
    info = conn.execute(f'PRAGMA table_info("{table}")').fetchall()
    for col in info:
        if col["pk"]:
            return col["name"]
    return "rowid"


def get_pk_col(db_path: Path, table: str) -> str:
    with _connect(db_path) as conn:
        return _pk(conn, table)
