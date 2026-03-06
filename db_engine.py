"""
LEMAT — DB Engine  (v3 — Phase 1: Data Layer)
=============================================
SQLite CRUD wrapper + full migration (CREATE / ALTER / DROP TABLE / rebuild columns).
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
    Full schema sync — migration destructive incluse :
    1. DROP TABLE pour les tables absentes du schéma
    2. CREATE TABLE IF NOT EXISTS pour les nouveaux modèles
    3. ALTER TABLE ADD COLUMN pour les nouveaux champs
    4. Reconstruction de la table (copie des données) si des colonnes ont été supprimées
    Retourne un dict résumé avec created / altered / dropped / rebuilt.
    """
    import model_parser as mp  # local import to avoid circular at module level

    db_path.parent.mkdir(parents=True, exist_ok=True)
    created, altered, dropped, rebuilt = [], [], [], []

    # Noms des modèles valides (non vides) du schéma
    schema_model_names = {m.name for m in schema.models if m.fields}

    with _connect(db_path) as conn:
        # Tables existantes → {name: [colname_lower, ...]}
        existing_tables: dict[str, list[str]] = {
            row["name"]: [
                c["name"].lower()
                for c in conn.execute(f'PRAGMA table_info("{row["name"]}")').fetchall()
            ]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }

        # ── 1. DROP tables absentes du schéma ─────────────────────────────────
        for table_name in list(existing_tables.keys()):
            if table_name not in schema_model_names:
                conn.execute(f'DROP TABLE IF EXISTS "{table_name}"')
                dropped.append(table_name)

        # ── 2 & 3 & 4. CREATE / ALTER / REBUILD ───────────────────────────────
        for model in schema.models:
            if not model.fields:
                continue  # modèle vide → SQL invalide, on ignore

            table_sql = mp._model_to_sql(model)
            schema_cols_lower = {f.name.lower() for f in model.fields}

            if model.name not in existing_tables:
                # Nouvelle table
                conn.execute(table_sql)
                created.append(model.name)

            else:
                existing_cols = set(existing_tables[model.name])

                # Colonnes supprimées (présentes en DB mais absentes du schéma)
                # On exclut 'rowid' qui est implicite
                removed_cols = existing_cols - schema_cols_lower - {"rowid"}

                if removed_cols:
                    # Reconstruction : nouvelle table avec le bon schéma,
                    # copie des données des colonnes survivantes, puis swap
                    surviving = [
                        f.name for f in model.fields
                        if f.name.lower() in existing_cols
                    ]
                    tmp = f"_lemat_tmp_{model.name}"

                    # Créer la table temporaire avec le nouveau schéma
                    tmp_sql = table_sql.replace(
                        f'CREATE TABLE IF NOT EXISTS "{model.name}"',
                        f'CREATE TABLE "{tmp}"',
                        1,
                    )
                    conn.execute(tmp_sql)

                    # Copier les données des colonnes communes
                    if surviving:
                        cols_sql = ", ".join(f'"{c}"' for c in surviving)
                        conn.execute(
                            f'INSERT INTO "{tmp}" ({cols_sql}) '
                            f'SELECT {cols_sql} FROM "{model.name}"'
                        )

                    conn.execute(f'DROP TABLE "{model.name}"')
                    conn.execute(f'ALTER TABLE "{tmp}" RENAME TO "{model.name}"')
                    rebuilt.append(model.name)

                else:
                    # Ajout de nouvelles colonnes uniquement
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
                                pass  # colonne déjà existante

        conn.commit()

    return {"created": created, "altered": altered, "dropped": dropped, "rebuilt": rebuilt}


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
