"""
LEMAT API — File Management
Arbre de fichiers, lecture, écriture, suppression, upload, mkdir.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from lemat.runtime.registry import ProjectRegistry
from lemat.runtime.project import ProjectRuntime

router = APIRouter(prefix="/api/projects", tags=["files"])

HIDDEN_SUFFIXES = {
    ".db-shm", ".db-wal", ".DS_Store",
    "smtp.json", "crons.json", "cron_logs.json",
    "_lemat_init.py", "_lemat_init.js", "_meta.json",
}


def get_registry(request: Request) -> ProjectRegistry:
    return request.app.state.registry


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class FileWriteBody(BaseModel):
    content: str


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{project}/tree")
def get_tree(project: str, reg: ProjectRegistry = Depends(get_registry)):
    rt = reg.require(project)
    return _dir_tree(rt.project_dir, rt.project_dir)


@router.get("/{project}/files/{filepath:path}")
def read_file(project: str, filepath: str,
              reg: ProjectRegistry = Depends(get_registry)):
    rt = reg.require(project)
    try:
        path = rt.resolve_path(filepath)
    except ValueError:
        raise HTTPException(400, "Path traversal not allowed")

    if not path.exists():
        raise HTTPException(404, "File not found")

    if path.is_dir():
        raise HTTPException(400, "Path is a directory")

    # Le frontend Monaco attend {"path": ..., "content": ...}
    # Les fichiers binaires (images, fonts…) sont servis en FileResponse
    _TEXT_EXTS = {
        ".html", ".htm", ".css", ".js", ".mjs", ".ts", ".jsx", ".tsx",
        ".json", ".md", ".txt", ".py", ".lemat", ".sh", ".yaml", ".yml",
        ".xml", ".svg", ".csv", ".sql", ".env", ".gitignore", ".toml",
        ".ini", ".cfg", ".conf", ".rb", ".php", ".go", ".rs", ".java",
        ".c", ".cpp", ".h", ".cs", ".swift",
    }
    if path.suffix.lower() in _TEXT_EXTS or path.suffix == "":
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
            return {"path": filepath, "content": content}
        except Exception:
            pass

    return FileResponse(path)


@router.put("/{project}/files/{filepath:path}")
async def write_file(project: str, filepath: str,
                     body: FileWriteBody,
                     request: Request,
                     reg: ProjectRegistry = Depends(get_registry)):
    rt = reg.require(project)
    try:
        path = rt.resolve_path(filepath)
    except ValueError:
        raise HTTPException(400, "Path traversal not allowed")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body.content, encoding="utf-8")

    # Invalider le cache si c'est un fichier LEMAT
    if path.suffix == ".lemat":
        rt.reload_schema()
        if path.name == "config.lemat":
            rt.reload_config()

    # Déclencher le live-reload dans le navigateur
    _broadcast = getattr(request.app.state, "broadcast_reload", None)
    if _broadcast:
        await _broadcast(project)

    return {"saved": True, "path": filepath}


@router.delete("/{project}/files/{filepath:path}")
def delete_file(project: str, filepath: str,
                reg: ProjectRegistry = Depends(get_registry)):
    rt = reg.require(project)
    try:
        path = rt.resolve_path(filepath)
    except ValueError:
        raise HTTPException(400, "Path traversal not allowed")

    if not path.exists():
        raise HTTPException(404, "File not found")

    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()

    return {"deleted": True, "path": filepath}


@router.post("/{project}/mkdir/{folderpath:path}", status_code=201)
def make_dir(project: str, folderpath: str,
             reg: ProjectRegistry = Depends(get_registry)):
    rt = reg.require(project)
    try:
        path = rt.resolve_path(folderpath)
    except ValueError:
        raise HTTPException(400, "Path traversal not allowed")

    path.mkdir(parents=True, exist_ok=True)
    return {"created": True, "path": folderpath}


@router.post("/{project}/upload")
async def upload_file(project: str, reg: ProjectRegistry = Depends(get_registry),
                      file: UploadFile = File(...), path: str = ""):
    rt = reg.require(project)

    dest_dir = rt.static_dir
    if path:
        try:
            dest_dir = rt.resolve_path(path)
        except ValueError:
            raise HTTPException(400, "Path traversal not allowed")
        dest_dir.mkdir(parents=True, exist_ok=True)

    dest = dest_dir / file.filename
    content = await file.read()
    dest.write_bytes(content)

    return {
        "uploaded": True,
        "filename": file.filename,
        "size": len(content),
        "path": str(dest.relative_to(rt.project_dir)),
    }


# ── Helpers privés ────────────────────────────────────────────────────────────

def _dir_tree(root: Path, base: Path) -> dict:
    entries = []
    try:
        items = sorted(root.iterdir(), key=lambda x: (x.is_file(), x.name))
    except PermissionError:
        items = []

    for item in items:
        if any(item.name.endswith(s) for s in HIDDEN_SUFFIXES):
            continue
        if item.name.startswith("."):
            continue

        entry = {
            "name": item.name,
            "path": str(item.relative_to(base)),
            "type": "file" if item.is_file() else "directory",
        }
        if item.is_dir():
            entry["children"] = _dir_tree(item, base)["children"]
        entries.append(entry)

    return {"name": root.name, "children": entries}
