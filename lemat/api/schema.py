"""
LEMAT API — Schema & Data Layer
Lecture/écriture du schéma, sync DB, génération du SDK.
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


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{project}/schema")
def get_schema(project: str, reg: ProjectRegistry = Depends(get_registry)):
    """Retourne le schéma du projet (texte brut + modèles parsés)."""
    rt = reg.require(project)

    sp = rt.schema_path
    if sp is None:
        return {"content": "", "models": [], "database": None}

    schema = rt.schema
    return {
        "content": sp.read_text(errors="replace"),
        "models": [
            {
                "name": m.name,
                "fields": [
                    {"name": f.name, "type": f.field_type, "options": f.options}
                    for f in m.fields
                ]
            }
            for m in schema.models
        ] if schema else [],
        "database": schema.database if schema else None,
    }


@router.put("/{project}/schema")
def write_schema(project: str, body: SchemaWriteBody,
                 reg: ProjectRegistry = Depends(get_registry)):
    """Écrit le contenu du schema.lemat et invalide le cache."""
    rt = reg.require(project)

    # Valider que le schéma est parsable avant de l'écrire
    try:
        model_parser.parse(body.content)
    except Exception as e:
        raise HTTPException(400, f"Schema parse error: {e}")

    schema_path = rt.project_dir / "schema.lemat"
    schema_path.write_text(body.content, encoding="utf-8")
    rt.reload_schema()

    return {"saved": True}


@router.post("/{project}/schema/sync")
def sync_schema(project: str, reg: ProjectRegistry = Depends(get_registry)):
    """
    Synchronise la DB avec le schéma courant (CREATE TABLE IF NOT EXISTS).
    Idempotent — sûr à appeler plusieurs fois.
    """
    rt = reg.require(project)

    if rt.schema is None:
        raise HTTPException(404, "No schema found in project")

    try:
        db_path = rt.sync_db()
    except Exception as e:
        raise HTTPException(500, f"Schema sync failed: {e}")

    tables = db_engine.list_tables(db_path)
    return {
        "synced": True,
        "db": str(db_path.relative_to(rt.project_dir)),
        "tables": tables,
    }


@router.get("/{project}/lemat-sdk.js")
def get_sdk(project: str, reg: ProjectRegistry = Depends(get_registry)):
    """Génère et retourne le SDK JavaScript du projet."""
    rt = reg.require(project)
    schema = rt.schema

    from lemat.sdk import generate_sdk
    sdk_content = generate_sdk(project, schema)

    return Response(content=sdk_content, media_type="application/javascript")


@router.get("/{project}/deploy/sdk.js")
def get_deploy_sdk(project: str, reg: ProjectRegistry = Depends(get_registry)):
    """SDK pour les projets déployés (même contenu, chemin différent)."""
    return get_sdk(project, reg)
