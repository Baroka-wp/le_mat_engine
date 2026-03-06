"""
LEMAT API — Projects
Gestion du cycle de vie des projets : création, liste, meta, rename, delete, export/import.
"""
from __future__ import annotations

import io
import json
import shutil
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from lemat.runtime.registry import ProjectRegistry
from lemat.runtime.project import ProjectRuntime


router = APIRouter(prefix="/api/projects", tags=["projects"])

# ── Dependency ────────────────────────────────────────────────────────────────

def get_registry(request: Request) -> ProjectRegistry:
    return request.app.state.registry


# ── Schemas Pydantic ──────────────────────────────────────────────────────────

class CreateProjectRequest(BaseModel):
    name: str
    description: str = ""
    icon: str = "📦"


class RenameProjectRequest(BaseModel):
    new_name: str


class MetaUpdateRequest(BaseModel):
    description: Optional[str] = None
    icon: Optional[str] = None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_projects(reg: ProjectRegistry = Depends(get_registry)):
    """Liste tous les projets avec leur meta."""
    projects = []
    for name in reg.list_projects():
        rt = reg.get(name)
        if rt is None:
            continue
        meta = _load_meta(rt)
        projects.append({
            "name": name,
            "description": meta.get("description", ""),
            "icon": meta.get("icon", "📦"),
            "has_schema": rt.schema is not None,
            "has_db": rt.db_path is not None,
            "structure": rt._detect_structure(),
        })
    return projects


@router.post("/{project}", status_code=201)
def create_project(project: str, reg: ProjectRegistry = Depends(get_registry)):
    """Crée un nouveau projet LEMAT avec la structure standard."""
    # Validation du nom
    if not project or "/" in project or project.startswith("."):
        raise HTTPException(400, "Invalid project name")

    if reg.get(project) is not None:
        raise HTTPException(409, f"Project '{project}' already exists")

    try:
        rt = reg.create(project, meta={"description": "", "icon": "📦"})
    except FileExistsError as e:
        raise HTTPException(409, str(e))

    return {"name": project, "created": True, "structure": rt._detect_structure()}


@router.get("/{project}/meta")
def get_meta(project: str, reg: ProjectRegistry = Depends(get_registry)):
    rt = reg.require(project)
    return _load_meta(rt)


@router.put("/{project}/meta")
def update_meta(project: str, body: MetaUpdateRequest,
                reg: ProjectRegistry = Depends(get_registry)):
    rt = reg.require(project)
    meta = _load_meta(rt)
    if body.description is not None:
        meta["description"] = body.description
    if body.icon is not None:
        meta["icon"] = body.icon
    _save_meta(rt, meta)
    return meta


@router.post("/{project}/rename")
def rename_project(project: str, body: RenameProjectRequest,
                   reg: ProjectRegistry = Depends(get_registry)):
    rt = reg.require(project)
    new_name = body.new_name.strip()

    if not new_name or "/" in new_name or new_name.startswith("."):
        raise HTTPException(400, "Invalid project name")
    if new_name == project:
        raise HTTPException(400, "New name is the same as current name")

    new_path = reg.base_dir / new_name
    if new_path.exists():
        raise HTTPException(409, f"Project '{new_name}' already exists")

    rt.project_dir.rename(new_path)
    reg.remove(project)

    return {"renamed": True, "old": project, "new": new_name}


@router.delete("/{project}")
def delete_project(project: str, reg: ProjectRegistry = Depends(get_registry)):
    rt = reg.require(project)
    shutil.rmtree(rt.project_dir)
    reg.remove(project)
    return {"deleted": True, "name": project}


# ── Config ────────────────────────────────────────────────────────────────────

@router.get("/{project}/config")
def get_config(project: str, reg: ProjectRegistry = Depends(get_registry)):
    rt = reg.require(project)
    return rt.config.to_dict()


@router.put("/{project}/config")
def update_config(project: str, body: dict, reg: ProjectRegistry = Depends(get_registry)):
    """
    Met à jour config.lemat (merge partiel).
    Le corps peut ne contenir que les clés à mettre à jour.
    """
    rt = reg.require(project)
    # Recharge, fusionne, sauvegarde
    existing = json.loads(
        (rt.config_path).read_text() if rt.config_path.exists()
        else "{}"
    )
    _deep_merge(existing, body)
    rt.config_path.write_text(
        json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    rt.reload_config()
    return rt.config.to_dict()


# ── Export / Import ───────────────────────────────────────────────────────────

@router.get("/{project}/export")
def export_project(project: str, reg: ProjectRegistry = Depends(get_registry)):
    rt = reg.require(project)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in rt.project_dir.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(rt.project_dir))
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{project}.zip"'},
    )


@router.post("/import", status_code=201)
async def import_project(
    file: UploadFile = File(...),
    name: str = Form(...),
    reg: ProjectRegistry = Depends(get_registry),
):
    if reg.get(name) is not None:
        raise HTTPException(409, f"Project '{name}' already exists")

    project_dir = reg.base_dir / name
    project_dir.mkdir(parents=True, exist_ok=True)

    content = await file.read()
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            zf.extractall(project_dir)
    except zipfile.BadZipFile:
        shutil.rmtree(project_dir, ignore_errors=True)
        raise HTTPException(400, "Invalid ZIP file")

    return {"name": name, "imported": True}


# ── Helpers privés ────────────────────────────────────────────────────────────

def _meta_path(rt: ProjectRuntime) -> Path:
    return rt.project_dir / "_meta.json"


def _load_meta(rt: ProjectRuntime) -> dict:
    p = _meta_path(rt)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return {"description": "", "icon": "📦"}


def _save_meta(rt: ProjectRuntime, meta: dict) -> None:
    _meta_path(rt).write_text(json.dumps(meta, indent=2, ensure_ascii=False))


def _deep_merge(base: dict, override: dict) -> None:
    """Merge récursif de `override` dans `base` (modifie `base` in-place)."""
    for k, v in override.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v
