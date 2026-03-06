"""
LEMAT — Project Router
Sert les fichiers d'un projet de manière isolée.

Chaque projet est accessible via :
  /projects/{project}/            → static_dir/index.html
  /projects/{project}/{filepath}  → static_dir/{filepath}
  /p/{token}/                     → projet déployé (via token)
  Domaine custom                  → projet déployé (via middleware)

Le router injecte automatiquement le SDK LEMAT dans les pages HTML servies.
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse

from lemat.runtime.registry import ProjectRegistry

router = APIRouter(tags=["serving"])

# Script injecté dans chaque page HTML en mode dev (live reload)
_INJECT_SCRIPT = """
<script>
(function() {
  var _lm = new EventSource('/api/livereload');
  _lm.onmessage = function(e) { if (e.data === 'reload') location.reload(); };
  _lm.onerror = function() { _lm.close(); };
})();
</script>
"""


def _registry(request: Request) -> ProjectRegistry:
    return request.app.state.registry


def _inject(html: str, script: str) -> str:
    """Insère `script` avant </body> ou en fin de document."""
    if "</body>" in html:
        return html.replace("</body>", script + "</body>", 1)
    return html + script


def _inject_sdk_tag(html: str, project: str) -> str:
    """Injecte la balise SDK dans <head>."""
    tag = f'<script src="/api/projects/{project}/lemat-sdk.js"></script>'
    if "</head>" in html:
        return html.replace("</head>", tag + "</head>", 1)
    return tag + html


def _serve_html(html: str, project: str, deployed: bool = False) -> HTMLResponse:
    """Pipeline d'injection HTML (SDK + live reload si dev)."""
    html = _inject_sdk_tag(html, project)
    if not deployed:
        html = _inject(html, _INJECT_SCRIPT)
    return HTMLResponse(html)


def _serve_file(path: Path, project: str, deployed: bool = False):
    """Sert un fichier — avec injection si HTML."""
    if path.suffix.lower() in (".html", ".htm"):
        return _serve_html(path.read_text(errors="replace"), project, deployed)
    return FileResponse(path)


# ── Dev serving (/projects/{project}/) ───────────────────────────────────────

@router.get("/projects/{project}")
def serve_project_index(project: str, request: Request):
    reg = _registry(request)
    rt = reg.require(project)

    static = rt.static_dir
    index = static / "index.html"
    if not index.exists():
        raise HTTPException(404, "No index.html found in project")
    return _serve_html(index.read_text(errors="replace"), project)


@router.get("/projects/{project}/{filepath:path}")
def serve_project_file(project: str, filepath: str, request: Request):
    reg = _registry(request)
    rt = reg.require(project)

    try:
        path = rt.resolve_path(filepath)
    except ValueError:
        raise HTTPException(400, "Path traversal not allowed")

    if not path.exists():
        raise HTTPException(404, "File not found")

    if path.is_dir():
        index = path / "index.html"
        if not index.exists():
            raise HTTPException(404, "No index.html in directory")
        return _serve_html(index.read_text(errors="replace"), project)

    return _serve_file(path, project)


# ── Deployed serving (/p/{token}/) ───────────────────────────────────────────

def _load_deployments(base_dir: Path) -> dict:
    """Charge deployments.json (chemin standard)."""
    dep_file = base_dir.parent / "deployments.json"
    if not dep_file.exists():
        return {"deployments": {}, "domains": {}, "tokens": {}}
    import json
    try:
        return json.loads(dep_file.read_text())
    except Exception:
        return {"deployments": {}, "domains": {}, "tokens": {}}


@router.get("/p/{token}")
def serve_token_redirect(token: str, request: Request):
    """Redirige /p/{token} → /p/{token}/ pour la résolution des URLs relatives."""
    reg = _registry(request)
    deps = _load_deployments(reg.base_dir)
    if token not in deps.get("tokens", {}):
        raise HTTPException(404, "Deployment not found — expired or invalid link")
    return RedirectResponse(url=f"/p/{token}/", status_code=301)


@router.get("/p/{token}/{filepath:path}")
def serve_token_file(token: str, filepath: str, request: Request):
    """Sert un projet déployé via son token."""
    reg = _registry(request)
    deps = _load_deployments(reg.base_dir)
    project_name = deps.get("tokens", {}).get(token)
    if not project_name:
        raise HTTPException(404, "Deployment not found — expired or invalid link")

    rt = reg.require(project_name)
    static = rt.static_dir

    if not filepath:
        index = static / "index.html"
        if not index.exists():
            raise HTTPException(404, "No index.html found")
        return _serve_html(index.read_text(errors="replace"), project_name, deployed=True)

    try:
        path = rt.resolve_path(filepath)
    except ValueError:
        raise HTTPException(400, "Path traversal not allowed")

    if not path.exists():
        raise HTTPException(404, "File not found")

    if path.is_dir():
        index = path / "index.html"
        if not index.exists():
            raise HTTPException(404, "No index.html in directory")
        return _serve_html(index.read_text(errors="replace"), project_name, deployed=True)

    return _serve_file(path, project_name, deployed=True)


# ── Custom domain serving (wildcard catch-all) ────────────────────────────────

async def serve_deployed_project(request: Request, filepath: str = ""):
    """
    Sert les fichiers d'un projet déployé via domaine personnalisé.
    Appelé depuis le middleware de routing de domaine dans main.py.
    Cette fonction N'EST PAS un router — elle est appelée manuellement
    depuis la route catch-all de main.py.
    """
    project_name = getattr(request.state, "deploy_project", None)
    if not project_name:
        return None  # Aucun projet routé → laisser main.py décider

    reg = _registry(request)
    rt = reg.require(project_name)
    static = rt.static_dir

    if not filepath or filepath == "/":
        index = static / "index.html"
        if not index.exists():
            raise HTTPException(404, "No index.html found")
        return _serve_html(index.read_text(errors="replace"), project_name, deployed=True)

    try:
        path = rt.resolve_path(filepath)
    except ValueError:
        raise HTTPException(400, "Path traversal not allowed")

    if not path.exists():
        raise HTTPException(404, "File not found")

    if path.is_dir():
        index = path / "index.html"
        if not index.exists():
            raise HTTPException(404, "No index.html in directory")
        return _serve_html(index.read_text(errors="replace"), project_name, deployed=True)

    return _serve_file(path, project_name, deployed=True)
