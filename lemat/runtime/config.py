"""
LEMAT — ProjectConfig
Parses and holds a project's config.lemat file.

Format (JSON for Phase 0 — évoluera vers un DSL haut-niveau):

{
  "auth": {
    "enabled": false,
    "providers": ["email"],          // "email" | "magic_link" | "oauth_google"
    "session_ttl": 3600
  },
  "roles": {
    "admin":  { "description": "Full access" },
    "member": { "description": "Read + write own data" },
    "guest":  { "description": "Read-only public data" }
  },
  "services": {
    "smtp":    { "enabled": false },
    "cron":    { "enabled": true  },
    "llm":     { "enabled": false },
    "payment": { "enabled": false },
    "storage": { "enabled": false }
  },
  "env": {
    "MY_API_KEY": "..."
  }
}
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


CONFIG_FILENAME = "config.lemat"

# ── Default config ─────────────────────────────────────────────────────────────

_DEFAULT_CONFIG: dict = {
    "auth": {
        "enabled": False,
        "providers": ["email"],
        "session_ttl": 3600,
    },
    "roles": {
        "admin":  {"description": "Full access"},
        "member": {"description": "Read + write"},
        "guest":  {"description": "Read-only"},
    },
    "services": {
        "smtp":    {"enabled": False},
        "cron":    {"enabled": True},
        "llm":     {"enabled": False},
        "payment": {"enabled": False},
        "storage": {"enabled": False},
    },
    "env": {},
}


@dataclass
class AuthConfig:
    enabled: bool = False
    providers: list[str] = field(default_factory=lambda: ["email"])
    session_ttl: int = 3600


@dataclass
class ServiceConfig:
    enabled: bool = False
    options: dict[str, Any] = field(default_factory=dict)


@dataclass
class ProjectConfig:
    """Configuration complète d'un projet LEMAT."""

    auth: AuthConfig = field(default_factory=AuthConfig)
    roles: dict[str, dict] = field(default_factory=lambda: {
        "admin":  {"description": "Full access"},
        "member": {"description": "Read + write"},
        "guest":  {"description": "Read-only"},
    })
    services: dict[str, ServiceConfig] = field(default_factory=dict)
    env: dict[str, str] = field(default_factory=dict)

    # ── Factories ─────────────────────────────────────────────────────────────

    @classmethod
    def default(cls) -> "ProjectConfig":
        return cls._from_dict(_DEFAULT_CONFIG)

    @classmethod
    def load(cls, project_dir: Path) -> "ProjectConfig":
        """Charge le config.lemat du projet (JSON). Retourne les défauts si absent."""
        config_path = project_dir / CONFIG_FILENAME
        if not config_path.exists():
            return cls.default()
        try:
            raw = json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            return cls.default()
        return cls._from_dict(raw)

    @classmethod
    def _from_dict(cls, raw: dict) -> "ProjectConfig":
        auth_raw = raw.get("auth", {})
        auth = AuthConfig(
            enabled=auth_raw.get("enabled", False),
            providers=auth_raw.get("providers", ["email"]),
            session_ttl=auth_raw.get("session_ttl", 3600),
        )

        services_raw = raw.get("services", {})
        services: dict[str, ServiceConfig] = {}
        for svc_name, svc_data in services_raw.items():
            if isinstance(svc_data, dict):
                enabled = svc_data.pop("enabled", False)
                services[svc_name] = ServiceConfig(enabled=enabled, options=svc_data)
            else:
                services[svc_name] = ServiceConfig(enabled=bool(svc_data))

        return cls(
            auth=auth,
            roles=raw.get("roles", _DEFAULT_CONFIG["roles"]),
            services=services,
            env=raw.get("env", {}),
        )

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self, project_dir: Path) -> None:
        """Écrit le config.lemat dans le répertoire du projet."""
        config_path = project_dir / CONFIG_FILENAME
        data = {
            "auth": {
                "enabled": self.auth.enabled,
                "providers": self.auth.providers,
                "session_ttl": self.auth.session_ttl,
            },
            "roles": self.roles,
            "services": {
                name: {"enabled": svc.enabled, **svc.options}
                for name, svc in self.services.items()
            },
            "env": self.env,
        }
        config_path.write_text(json.dumps(data, indent=2, ensure_ascii=False))

    # ── Helpers ───────────────────────────────────────────────────────────────

    def service_enabled(self, name: str) -> bool:
        svc = self.services.get(name)
        return svc.enabled if svc else False

    def to_dict(self) -> dict:
        return {
            "auth": {
                "enabled": self.auth.enabled,
                "providers": self.auth.providers,
                "session_ttl": self.auth.session_ttl,
            },
            "roles": self.roles,
            "services": {
                name: {"enabled": svc.enabled, **svc.options}
                for name, svc in self.services.items()
            },
            "env": list(self.env.keys()),  # On n'expose pas les valeurs
        }
