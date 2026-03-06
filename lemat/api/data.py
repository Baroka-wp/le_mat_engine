"""
LEMAT API — Data CRUD
Endpoints de manipulation des données (list, get, create, update, delete).
Tous les accès passent par le ProjectRuntime pour l'isolation.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

import db_engine
from lemat.runtime.registry import ProjectRegistry

router = APIRouter(prefix="/api/projects", tags=["data"])


def get_registry(request: Request) -> ProjectRegistry:
    return request.app.state.registry


# ── Helpers ───────────────────────────────────────────────────────────────────

def _require_db(rt):
    """Retourne db_path ou lève HTTP 404."""
    db = rt.db_path
    if not db or not db.exists():
        raise HTTPException(404, "No database found — run schema sync first")
    return db


def _resolve_table(db_path, schema, table: str) -> str:
    """Résolution insensible à la casse du nom de table."""
    if db_path and db_path.exists():
        tables = db_engine.list_tables(db_path)
        for t in tables:
            if t.lower() == table.lower():
                return t
    if schema:
        m = schema.get_model(table)
        if m:
            return m.name
    raise HTTPException(404, f"Table '{table}' not found")


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{project}/data")
def data_list_tables(project: str, reg: ProjectRegistry = Depends(get_registry)):
    """Liste les tables disponibles avec leur nombre de lignes."""
    rt = reg.require(project)
    db = _require_db(rt)

    tables = db_engine.list_tables(db)
    return [
        {
            "table": t,
            "count": db_engine.row_count(db, t),
            "columns": db_engine.table_columns(db, t),
        }
        for t in tables
    ]


@router.get("/{project}/data/{table}")
def data_list(
    project: str,
    table: str,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    order_by: Optional[str] = Query(None),
    reg: ProjectRegistry = Depends(get_registry),
):
    rt = reg.require(project)
    db = _require_db(rt)
    t = _resolve_table(db, rt.schema, table)

    rows = db_engine.select_all(db, t, limit=limit, offset=offset, order_by=order_by)
    total = db_engine.row_count(db, t)
    return {"rows": rows, "total": total, "limit": limit, "offset": offset}


@router.get("/{project}/data/{table}/{pk}")
def data_get_one(
    project: str, table: str, pk: str,
    reg: ProjectRegistry = Depends(get_registry),
):
    rt = reg.require(project)
    db = _require_db(rt)
    t = _resolve_table(db, rt.schema, table)

    pk_col = db_engine.get_pk_col(db, t)
    pk_val: Any = int(pk) if pk.isdigit() else pk
    row = db_engine.select_one(db, t, pk_col, pk_val)
    if row is None:
        raise HTTPException(404, "Record not found")
    return row


@router.post("/{project}/data/{table}", status_code=201)
def data_create(
    project: str, table: str,
    body: dict[str, Any],
    reg: ProjectRegistry = Depends(get_registry),
):
    rt = reg.require(project)
    db = _require_db(rt)
    t = _resolve_table(db, rt.schema, table)

    row = db_engine.insert(db, t, body)
    return row


@router.put("/{project}/data/{table}/{pk}")
def data_update(
    project: str, table: str, pk: str,
    body: dict[str, Any],
    reg: ProjectRegistry = Depends(get_registry),
):
    rt = reg.require(project)
    db = _require_db(rt)
    t = _resolve_table(db, rt.schema, table)

    pk_col = db_engine.get_pk_col(db, t)
    pk_val: Any = int(pk) if pk.isdigit() else pk
    row = db_engine.update(db, t, pk_col, pk_val, body)
    if row is None:
        raise HTTPException(404, "Record not found")
    return row


@router.delete("/{project}/data/{table}/{pk}")
def data_delete(
    project: str, table: str, pk: str,
    reg: ProjectRegistry = Depends(get_registry),
):
    rt = reg.require(project)
    db = _require_db(rt)
    t = _resolve_table(db, rt.schema, table)

    pk_col = db_engine.get_pk_col(db, t)
    pk_val: Any = int(pk) if pk.isdigit() else pk
    if not db_engine.delete(db, t, pk_col, pk_val):
        raise HTTPException(404, "Record not found")
    return {"deleted": True, "id": pk}
