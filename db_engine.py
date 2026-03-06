"""
LEMAT — DB Engine  (v2 — Phase 1: Data Layer)
=============================================
SQLite CRUD wrapper + smart migration (CREATE + ALTER TABLE).
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
    """
    Apply CREATE TABLE IF NOT EXISTS statements.
    Also runs ALTER TABLE ADD COLUMN for any new columns on existing tables.
    Safe by default: never drops or renames columns.
    """
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _connect(db_path) as conn:
        for stmt in sql_statements:
            stmt = stmt.strip()
            if not stmt:
                continue
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError as e:
                err = str(e)
                # ALTER TABLE … ADD COLUMN fails if column already exists
                if "duplicate column name" in err.lower():
                    continue
                # Any other error on an existing table → skip gracefully
                if "already exists" in err.lower():
                    continue
                raise
        conn.commit()


def smart_migrate(db_path: Path, schema: "model_parser.SchemaDef") -> dict:
    """
    Full schema sync:
    1. CREATE TABLE IF NOT EXISTS for each model (new tables)
    2. ALTER TABLE ADD COLUMN for new fields on existing tables
    Returns a summary dict.
    """
    import model_parser as mp  # local import to avoid circular at module level

    db_path.parent.mkdir(parents=True, exist_ok=True)
    created, altered = [], []

    with _connect(db_path) as conn:
        # Existing tables + their columns
        existing_tables = {
            row["name"]: [
                c["name"].lower()
                for c in conn.execute(f'PRAGMA table_info("{row["name"]}")').fetchall()
            ]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }

        for model in schema.models:
            table_sql = mp._model_to_sql(model)

            if model.name not in existing_tables:
                # New table
                conn.execute(table_sql)
                created.append(model.name)
            else:
                # Existing table — add missing columns only
                existing_cols = set(existing_tables[model.name])
                for f in model.fields:
                    if f.name.lower() not in existing_cols:
                        col_def = f'"{f.name}" {f.sql_type}'
                        if f.default is not None:
                            col_def += f" DEFAULT {f.default}"
                        try:
                            conn.execute(
                                f'ALTER TABLE "{model.name}" ADD COLUMN {col_def}'
                            )
                            altered.append(f"{model.name}.{f.name}")
                        except sqlite3.OperationalError:
                            pass  # column already exists

        conn.commit()

    return {"created": created, "altered": altered}


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
    limit: int = 100,
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
    # Remove keys with None values to let DB defaults apply
    data = {k: v for k, v in data.items() if v is not None}
    with _connect(db_path) as conn:
        if data:
            cols = ", ".join(f'"{k}"' for k in data)
            vals = ", ".join("?" for _ in data)
            cur = conn.execute(
                f'INSERT INTO "{table}" ({cols}) VALUES ({vals})', list(data.values())
            )
        else:
            cur = conn.execute(f'INSERT INTO "{table}" DEFAULT VALUES')
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
