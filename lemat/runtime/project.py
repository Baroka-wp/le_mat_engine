"""
LEMAT — ProjectRuntime
Représente un projet LEMAT en cours d'exécution.

Chaque projet est une entité isolée avec :
  - Son propre répertoire  (project_dir)
  - Sa propre base de données SQLite  (db_path)
  - Son propre schéma  (schema.lemat ou legacy *.lemat)
  - Sa propre configuration  (config.lemat)
  - Ses propres assets statiques  (static/)
  - Sa propre logique custom  (logic/)

Structure standard LEMAT :
  /mon-projet/
    schema.lemat        ← modèle de données (source de vérité)
    config.lemat        ← auth, rôles, services
    logic/
      hooks.py          ← Python hooks (before_create, after_update, …)
      crons.py          ← jobs planifiés
    pages/              ← pages UI LEMAT (futur)
    static/             ← assets statiques (HTML, CSS, JS actuels)
    data/
      db.sqlite         ← base de données isolée
"""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import model_parser
import db_engine

from .config import ProjectConfig


# ── Standard project scaffold ─────────────────────────────────────────────────

STANDARD_DIRS = ["static", "logic", "pages", "data"]

STANDARD_SCHEMA = """\
// schema.lemat — Modèle de données du projet
// Documentation: https://lemat.dev/docs/schema

// Exemple :
// model Task {
//   title       Text     required
//   done        Bool     default false
//   created_at  DateTime auto_now_add
// }
"""

GITIGNORE_CONTENT = """\
# LEMAT
data/*.sqlite
data/*.sqlite-wal
data/*.sqlite-shm
*.db-shm
*.db-wal
__pycache__/
.env
"""


# ── ProjectRuntime ────────────────────────────────────────────────────────────

@dataclass
class ProjectRuntime:
    """
    Contexte d'exécution complet d'un projet LEMAT.
    Instance créée et gérée par le ProjectRegistry.
    """

    name: str
    project_dir: Path

    # Cache interne — rechargé à la demande (invalidate())
    _schema: Optional[model_parser.SchemaDef] = field(default=None, repr=False)
    _config: Optional[ProjectConfig] = field(default=None, repr=False)
    _schema_mtime: float = field(default=0.0, repr=False)
    _config_mtime: float = field(default=0.0, repr=False)

    # ── Paths ─────────────────────────────────────────────────────────────────

    @property
    def data_dir(self) -> Path:
        return self.project_dir / "data"

    @property
    def logic_dir(self) -> Path:
        return self.project_dir / "logic"

    @property
    def pages_dir(self) -> Path:
        return self.project_dir / "pages"

    @property
    def static_dir(self) -> Path:
        """Répertoire des assets statiques (HTML/CSS/JS actuels)."""
        explicit = self.project_dir / "static"
        if explicit.exists():
            return explicit
        # Legacy: le projet n'a pas encore de sous-dossier static/
        return self.project_dir

    @property
    def schema_path(self) -> Optional[Path]:
        """schema.lemat (standard) ou premier *.lemat trouvé (legacy)."""
        standard = self.project_dir / "schema.lemat"
        if standard.exists():
            return standard
        for f in sorted(self.project_dir.glob("*.lemat")):
            return f
        return None

    @property
    def config_path(self) -> Path:
        return self.project_dir / "config.lemat"

    @property
    def db_path(self) -> Optional[Path]:
        """Chemin de la base de données SQLite du projet."""
        # Standard LEMAT : data/db.sqlite
        standard = self.data_dir / "db.sqlite"
        if standard.exists():
            return standard

        # Legacy : {schema.database} à la racine du projet
        schema = self.schema  # utilise le cache
        if schema:
            candidate = self.project_dir / schema.database
            if candidate.exists():
                return candidate

        # Legacy fallback : premier *.db à la racine
        for f in sorted(self.project_dir.glob("*.db")):
            return f

        return None

    @property
    def db_path_or_create(self) -> Path:
        """Retourne le chemin DB — crée data/ si nécessaire."""
        if self.db_path:
            return self.db_path
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return self.data_dir / "db.sqlite"

    # ── Schema ────────────────────────────────────────────────────────────────

    @property
    def schema(self) -> Optional[model_parser.SchemaDef]:
        """Schéma parsé, avec cache invalidé si le fichier a changé."""
        sp = self.schema_path
        if sp is None:
            self._schema = None
            return None
        mtime = sp.stat().st_mtime
        if self._schema is None or mtime != self._schema_mtime:
            try:
                self._schema = model_parser.parse(sp.read_text(errors="replace"))
                self._schema_mtime = mtime
            except Exception:
                self._schema = None
        return self._schema

    def reload_schema(self) -> Optional[model_parser.SchemaDef]:
        """Force le rechargement du schéma."""
        self._schema = None
        self._schema_mtime = 0.0
        return self.schema

    # ── Config ────────────────────────────────────────────────────────────────

    @property
    def config(self) -> ProjectConfig:
        """Config du projet, avec cache invalidé si config.lemat a changé."""
        cp = self.config_path
        if cp.exists():
            mtime = cp.stat().st_mtime
            if self._config is None or mtime != self._config_mtime:
                self._config = ProjectConfig.load(self.project_dir)
                self._config_mtime = mtime
        elif self._config is None:
            self._config = ProjectConfig.default()
        return self._config

    def reload_config(self) -> ProjectConfig:
        """Force le rechargement de la config."""
        self._config = None
        self._config_mtime = 0.0
        return self.config

    # ── Isolation & path safety ───────────────────────────────────────────────

    def resolve_path(self, filepath: str) -> Path:
        """
        Résout un chemin relatif dans le répertoire du projet (project_dir).
        Permet d'accéder à tous les fichiers du projet (schema.lemat, config.lemat,
        static/, logic/, pages/, data/…).
        Lève ValueError si le chemin tente de sortir du projet (path traversal).
        """
        resolved = (self.project_dir / filepath).resolve()
        if not str(resolved).startswith(str(self.project_dir.resolve())):
            raise ValueError(f"Path traversal not allowed: {filepath!r}")
        return resolved

    # ── Scaffold ──────────────────────────────────────────────────────────────

    @classmethod
    def create(cls, name: str, base_dir: Path, meta: dict | None = None) -> "ProjectRuntime":
        """
        Crée un nouveau projet LEMAT avec la structure standard.
        Retourne le ProjectRuntime du projet créé.
        """
        project_dir = base_dir / name
        if project_dir.exists():
            raise FileExistsError(f"Project '{name}' already exists")

        # Créer la structure de dossiers
        project_dir.mkdir(parents=True)
        for d in STANDARD_DIRS:
            (project_dir / d).mkdir()

        # Écrire schema.lemat vide
        (project_dir / "schema.lemat").write_text(STANDARD_SCHEMA, encoding="utf-8")

        # Écrire config.lemat par défaut
        config = ProjectConfig.default()
        config.save(project_dir)

        # .gitignore
        (project_dir / ".gitignore").write_text(GITIGNORE_CONTENT)

        # Métadonnées (_meta.json — rétro-compat avec l'ancienne API)
        if meta:
            import json
            (project_dir / "_meta.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2)
            )

        return cls(name=name, project_dir=project_dir)

    # ── State ─────────────────────────────────────────────────────────────────

    def invalidate(self) -> None:
        """Invalide tous les caches (schema, config)."""
        self._schema = None
        self._schema_mtime = 0.0
        self._config = None
        self._config_mtime = 0.0

    def exists(self) -> bool:
        return self.project_dir.exists()

    def to_dict(self) -> dict:
        """Sérialisation pour l'API /api/projects."""
        schema = self.schema
        return {
            "name": self.name,
            "has_schema": schema is not None,
            "has_db": self.db_path is not None,
            "models": [m.name for m in schema.models] if schema else [],
            "config": self.config.to_dict(),
            "structure": self._detect_structure(),
        }

    def _detect_structure(self) -> str:
        """Détecte si le projet utilise la structure standard ou legacy."""
        if (self.project_dir / "schema.lemat").exists():
            return "standard"
        if (self.project_dir / "static").is_dir():
            return "transitional"
        return "legacy"

    # ── DB helpers ────────────────────────────────────────────────────────────

    def sync_db(self) -> Path:
        """
        Synchronise la DB avec le schéma courant (migrate).
        Retourne le chemin de la DB.
        """
        schema = self.schema
        if not schema:
            raise ValueError(f"Project '{self.name}' has no schema")

        db = self.db_path_or_create
        sql_statements = model_parser.to_sql(schema)
        db_engine.migrate(db, sql_statements)
        return db
