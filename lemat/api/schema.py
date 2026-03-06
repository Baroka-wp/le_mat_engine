"""
LEMAT API — Schema & Data Layer  (Phase 1)
==========================================
Lecture/écriture du schéma, sync DB intelligente (CREATE + ALTER TABLE),
validation, génération du SDK.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

import model_parser
import db_engine
from lemat.runtime.registry import ProjectRegistry

router = APIRouter(prefix="/api/projects", tags=["schema"])


def get_registry(request: Request) -> ProjectRegistry:
    return request.app.state.registry


# ── Pydantic ──────────────────────────────────────────────────────────────────

class SchemaWriteBody(BaseModel):
    content: str
    auto_sync: bool = True   # synchroniser la DB immédiatement après sauvegarde


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{project}/schema")
def get_schema(project: str, reg: ProjectRegistry = Depends(get_registry)):
    """
    Retourne le schéma complet du projet :
    - content    : texte brut du fichier .lemat
    - models     : modèles parsés avec champs enrichis (type, kind, options, relation…)
    - database   : nom du fichier DB
    - tables     : tables existantes en DB avec colonnes et nb de lignes
    - hasSchemaFile : booléen
    """
    rt = reg.require(project)
    sp = rt.schema_path

    if sp is None:
        return {
            "content": "",
            "models": [],
            "database": None,
            "tables": [],
            "hasSchemaFile": False,
        }

    schema = rt.schema
    content = sp.read_text(errors="replace")

    # Tables existantes en DB
    tables_info = []
    db = rt.db_path
    if db and db.exists():
        for t in db_engine.list_tables(db):
            cols = db_engine.table_columns(db, t)
            count = db_engine.row_count(db, t)
            # Enrichir les colonnes avec les infos du schéma si disponibles
            schema_model = schema.get_model(t) if schema else None
            enriched_cols = []
            for col in cols:
                col_dict = dict(col)
                if schema_model:
                    sf = next((f for f in schema_model.fields
                               if f.name.lower() == col["name"].lower()), None)
                    if sf:
                        col_dict["kind"]    = sf.field_kind
                        col_dict["label"]   = model_parser.TYPE_LABEL.get(
                            sf.lemat_type, sf.lemat_type.capitalize()
                        )
                        if sf.select_options:
                            col_dict["options"] = sf.select_options
                        if sf.relation_model:
                            col_dict["relationModel"] = sf.relation_model
                enriched_cols.append(col_dict)
            tables_info.append({
                "name":    t,
                "rows":    count,
                "columns": enriched_cols,
            })

    return {
        "content":       content,
        "models":        schema.to_dict()["models"] if schema else [],
        "database":      schema.database if schema else None,
        "tables":        tables_info,
        "hasSchemaFile": True,
        "simpleTypes":   model_parser.SIMPLE_TYPES,
    }


@router.put("/{project}/schema")
def write_schema(project: str, body: SchemaWriteBody,
                 reg: ProjectRegistry = Depends(get_registry)):
    """
    Écrit schema.lemat, invalide le cache et (optionnellement) sync la DB.
    Retourne le résultat de la migration si auto_sync=True.
    """
    rt = reg.require(project)

    # Validation parse avant écriture
    try:
        parsed = model_parser.parse(body.content)
    except Exception as e:
        raise HTTPException(400, f"Schema parse error: {e}")

    schema_path = rt.project_dir / "schema.lemat"
    schema_path.write_text(body.content, encoding="utf-8")
    rt.reload_schema()

    result: dict = {"saved": True, "models": len(parsed.models)}

    if body.auto_sync and parsed.models:
        try:
            db_path = rt.db_path_or_create
            summary = db_engine.smart_migrate(db_path, parsed)
            result["migration"] = summary
        except Exception as e:
            result["migration_warning"] = str(e)

    return result


@router.post("/{project}/schema/sync")
def sync_schema(project: str, reg: ProjectRegistry = Depends(get_registry)):
    """
    Synchronise la DB avec le schéma courant.
    - Crée les nouvelles tables (CREATE TABLE IF NOT EXISTS)
    - Ajoute les nouvelles colonnes (ALTER TABLE ADD COLUMN)
    - Ne supprime jamais de colonnes (safe migration)
    """
    rt = reg.require(project)

    if rt.schema is None:
        raise HTTPException(404, "No schema found in project")

    try:
        db_path = rt.db_path_or_create
        summary = db_engine.smart_migrate(db_path, rt.schema)
    except Exception as e:
        raise HTTPException(500, f"Schema sync failed: {e}")

    tables = db_engine.list_tables(db_path)
    return {
        "synced":  True,
        "db":      str(db_path.relative_to(rt.project_dir)),
        "tables":  tables,
        "created": summary["created"],
        "altered": summary["altered"],
        "message": _sync_message(summary),
    }


@router.post("/{project}/schema/validate")
def validate_schema(project: str, body: SchemaWriteBody,
                    reg: ProjectRegistry = Depends(get_registry)):
    """Valide un schéma .lemat sans l'écrire — retourne erreurs et warnings."""
    try:
        parsed = model_parser.parse(body.content)
    except Exception as e:
        return {"valid": False, "error": str(e), "models": []}

    warnings = []
    for model in parsed.models:
        if not model.pk_field():
            warnings.append(
                f"Model '{model.name}' has no @id field — "
                "LEMAT will use SQLite rowid, but consider adding an explicit id."
            )
        for f in model.fields:
            if f.field_kind == "relation" and not f.relation_model:
                warnings.append(f"Field '{model.name}.{f.name}': empty Relation()")

    return {
        "valid":    True,
        "models":   [m.to_dict() for m in parsed.models],
        "warnings": warnings,
        "lemat":    model_parser.to_lemat(parsed),   # reformatted source
    }


# ── SDK ───────────────────────────────────────────────────────────────────────

@router.get("/{project}/lemat-sdk.js")
def get_sdk(project: str, reg: ProjectRegistry = Depends(get_registry)):
    """Génère et retourne le SDK JavaScript du projet."""
    rt = reg.require(project)
    from lemat.sdk import generate_sdk
    sdk_content = generate_sdk(project, rt.schema)
    return Response(content=sdk_content, media_type="application/javascript")


@router.get("/{project}/deploy/sdk.js")
def get_deploy_sdk(project: str, reg: ProjectRegistry = Depends(get_registry)):
    return get_sdk(project, reg)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _sync_message(summary: dict) -> str:
    parts = []
    if summary["created"]:
        parts.append(f"Tables créées : {', '.join(summary['created'])}")
    if summary["altered"]:
        parts.append(f"Colonnes ajoutées : {', '.join(summary['altered'])}")
    return " | ".join(parts) if parts else "DB déjà à jour"
