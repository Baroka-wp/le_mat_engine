"""
LEMAT — ProjectRegistry
Singleton qui gère tous les ProjectRuntime actifs.

Responsabilités :
  - Charger / mettre en cache les runtimes des projets
  - Fournir un point d'accès unique pour toutes les routes API
  - Invalider le cache d'un projet (après une modification de fichier)
  - Lister les projets disponibles

Usage (dans les routes FastAPI) :
    from fastapi import Depends
    from lemat.runtime import ProjectRegistry

    def get_registry() -> ProjectRegistry:
        return ProjectRegistry.instance()

    @router.get("/api/projects/{project}")
    def get_project(project: str, reg: ProjectRegistry = Depends(get_registry)):
        runtime = reg.require(project)   # lève HTTP 404 si absent
        ...
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from .project import ProjectRuntime


# ── ProjectRegistry ───────────────────────────────────────────────────────────

class ProjectRegistry:
    """
    Registre global des projets LEMAT.
    Un seul registre par process — créé une fois dans main.py et partagé via
    la fonction get_registry() injectée dans les dépendances FastAPI.
    """

    def __init__(self, base_dir: Path) -> None:
        self._base_dir = base_dir
        self._cache: dict[str, ProjectRuntime] = {}

    # ── Accès ─────────────────────────────────────────────────────────────────

    def get(self, name: str) -> Optional[ProjectRuntime]:
        """Retourne le runtime du projet (depuis le cache ou créé à la demande)."""
        if name in self._cache:
            rt = self._cache[name]
            if rt.exists():
                return rt
            # Le dossier a été supprimé entre-temps
            del self._cache[name]
            return None

        project_dir = self._base_dir / name
        if not project_dir.exists():
            return None

        rt = ProjectRuntime(name=name, project_dir=project_dir)
        self._cache[name] = rt
        return rt

    def require(self, name: str) -> ProjectRuntime:
        """Retourne le runtime ou lève HTTP 404."""
        rt = self.get(name)
        if rt is None:
            raise HTTPException(404, f"Project '{name}' not found")
        return rt

    # ── Création ──────────────────────────────────────────────────────────────

    def create(self, name: str, meta: dict | None = None) -> ProjectRuntime:
        """
        Crée un nouveau projet LEMAT avec la structure standard.
        Lève FileExistsError si le projet existe déjà.
        """
        rt = ProjectRuntime.create(name, self._base_dir, meta=meta)
        self._cache[name] = rt
        return rt

    # ── Invalidation & suppression ─────────────────────────────────────────────

    def invalidate(self, name: str) -> None:
        """Invalide le cache d'un projet (forçant le rechargement au prochain accès)."""
        rt = self._cache.get(name)
        if rt:
            rt.invalidate()

    def remove(self, name: str) -> None:
        """Retire le projet du registre (ne supprime pas les fichiers)."""
        self._cache.pop(name, None)

    # ── Liste ─────────────────────────────────────────────────────────────────

    def list_projects(self) -> list[str]:
        """Retourne les noms de tous les projets existants, triés."""
        if not self._base_dir.exists():
            return []
        names = []
        for d in sorted(self._base_dir.iterdir()):
            if d.is_dir() and not d.name.startswith("."):
                names.append(d.name)
        return names

    def list_runtimes(self) -> list[ProjectRuntime]:
        """Retourne les runtimes de tous les projets (chargés à la demande)."""
        return [self.get(name) for name in self.list_projects() if self.get(name)]

    # ── Utilitaires ───────────────────────────────────────────────────────────

    @property
    def base_dir(self) -> Path:
        return self._base_dir

    def __repr__(self) -> str:
        return f"<ProjectRegistry base={self._base_dir} cached={len(self._cache)}>"
