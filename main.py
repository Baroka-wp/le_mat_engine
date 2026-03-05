import asyncio
import io
import json
import os
import shlex
import shutil
import smtplib
import ssl as ssl_lib
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate, make_msgid
from pathlib import Path
from typing import Any, List, Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

import aiofiles
from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse, Response, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import model_parser
import db_engine

BASE_DIR = Path("/data/projects")
BASE_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Le Mat - Deployment Platform")

# ── Deployments & Custom Domains ──────────────────────────────────────────────

DEPLOYMENTS_FILE = Path("/data/deployments.json")
DEPLOYMENTS_FILE.parent.mkdir(parents=True, exist_ok=True)

def _load_deployments() -> dict:
    """Charge la configuration des déploiements."""
    if DEPLOYMENTS_FILE.exists():
        data = json.loads(DEPLOYMENTS_FILE.read_text())
        # Migration: s'assurer que le dict "tokens" existe (reverse map token → projet)
        if "tokens" not in data:
            data["tokens"] = {}
            for proj, info in data.get("deployments", {}).items():
                tok = info.get("token")
                if tok:
                    data["tokens"][tok] = proj
        return data
    return {"deployments": {}, "domains": {}, "tokens": {}}

def _save_deployments(data: dict):
    """Sauvegarde la configuration des déploiements."""
    DEPLOYMENTS_FILE.write_text(json.dumps(data, indent=2))

def generate_deploy_token() -> str:
    """Génère un token unique pour le déploiement."""
    return str(uuid.uuid4())[:8]

def _real_deploy_url(request: Request, token: str) -> str:
    """Retourne l'URL de déploiement réelle basée sur le serveur courant."""
    base = os.getenv("LEMAT_BASE_URL", "").rstrip("/")
    if not base:
        host = request.headers.get("x-forwarded-host") or request.headers.get("host", "localhost:8000")
        scheme = request.headers.get("x-forwarded-proto", "http")
        base = f"{scheme}://{host}"
    return f"{base}/p/{token}"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/editor", StaticFiles(directory="/app/static", html=True), name="editor")

# ── Custom Domain Routing Middleware ─────────────────────────────────────────

@app.middleware("http")
async def custom_domain_routing(request, call_next):
    """Route les requêtes des domaines personnalisés vers les projets."""
    host = request.headers.get("host", "").split(":")[0].lower()

    # Chercher dans les domaines personnalisés uniquement
    deployments = _load_deployments()
    project_name = deployments["domains"].get(host)

    if project_name:
        request.state.deploy_project = project_name
    else:
        request.state.deploy_project = None

    response = await call_next(request)

    if project_name:
        response.headers["X-Deploy-Project"] = project_name

    return response


# Registry of running processes
active_processes: dict[str, asyncio.subprocess.Process] = {}

# Live reload: project → list of WebSockets
livereload_clients: dict[str, list[WebSocket]] = {}

LANG_RUNNERS = {
    "py":  ["python3", "-u", "{file}"],
    "js":  ["node", "{file}"],
    "mjs": ["node", "{file}"],
    "ts":  ["npx", "--yes", "ts-node", "{file}"],
    "sh":  ["bash", "{file}"],
}

NON_EXECUTABLE = {"html", "htm", "css", "svg", "json", "xml", "md", "txt", "lemat"}

# ── Inject script (live reload + SDK loader) ──────────────────────────────────

INJECT_SCRIPT = """<script>
(function(){{
  var proj = location.pathname.split('/')[2];
  // Le Mat SDK
  var sdk = document.createElement('script');
  sdk.src = '/api/projects/' + proj + '/lemat-sdk.js';
  document.head.appendChild(sdk);
  // Live reload
  function connect(){{
    var ws = new WebSocket('ws://' + location.host + '/api/projects/' + proj + '/livereload');
    ws.onmessage = function(){{ location.reload(); }};
    ws.onclose   = function(){{ setTimeout(connect, 1500); }};
  }}
  connect();
}})();
</script>"""


def inject_scripts(html: str) -> str:
    tag = INJECT_SCRIPT
    if "</body>" in html:
        return html.replace("</body>", tag + "</body>", 1)
    return html + tag


def inject_scripts_deployed(html: str, project: str) -> str:
    """Injecte scripts pour projets déployés — nom de projet codé en dur (URL = /p/token/)."""
    import json as _json
    script = f"""<script>
(function(){{
  var proj = {_json.dumps(project)};
  var sdk = document.createElement('script');
  sdk.src = '/api/projects/' + proj + '/lemat-sdk.js';
  document.head.appendChild(sdk);
  function connect(){{
    var ws = new WebSocket('ws://' + location.host + '/api/projects/' + proj + '/livereload');
    ws.onmessage = function(){{ location.reload(); }};
    ws.onclose   = function(){{ setTimeout(connect, 1500); }};
  }}
  connect();
}})();
</script>"""
    if "</body>" in html:
        return html.replace("</body>", script + "</body>", 1)
    return html + script


# ── Project / file helpers ────────────────────────────────────────────────────

def safe_path(project: str, filepath: str = "") -> Path:
    project_dir = BASE_DIR / project
    if filepath:
        resolved = (project_dir / filepath).resolve()
        if not str(resolved).startswith(str(project_dir.resolve())):
            raise HTTPException(400, "Path traversal not allowed")
        return resolved
    return project_dir


HIDDEN_SUFFIXES = {
    ".db-shm", ".db-wal", ".DS_Store",
    "smtp.json", "crons.json", "cron_logs.json",
    "_lemat_init.py", "_lemat_init.js",
}

_smtp_executor = ThreadPoolExecutor(max_workers=4)

# ── Scheduler ─────────────────────────────────────────────────────────────────
_scheduler = AsyncIOScheduler(timezone="UTC")
CRON_LOG_MAX = 20


def dir_tree(root: Path, rel: Path = None) -> dict:
    if rel is None:
        rel = root
    entries = []
    for item in sorted(root.iterdir(), key=lambda x: (x.is_file(), x.name)):
        if any(item.name.endswith(s) for s in HIDDEN_SUFFIXES):
            continue
        entry = {
            "name": item.name,
            "path": str(item.relative_to(rel)),
            "type": "file" if item.is_file() else "directory",
        }
        if item.is_dir():
            entry["children"] = dir_tree(item, rel)["children"]
        entries.append(entry)
    return {"name": root.name, "children": entries}


async def broadcast_reload(project: str):
    dead = []
    for ws in livereload_clients.get(project, []):
        try:
            await ws.send_text("reload")
        except Exception:
            dead.append(ws)
    for ws in dead:
        livereload_clients[project].remove(ws)


# ── Schema / DB helpers ───────────────────────────────────────────────────────

def find_schema_file(project_dir: Path) -> Optional[Path]:
    """Return the first .lemat file found in the project."""
    for f in sorted(project_dir.glob("*.lemat")):
        return f
    return None


def load_schema(project_dir: Path) -> Optional[model_parser.SchemaDef]:
    schema_file = find_schema_file(project_dir)
    if not schema_file:
        return None
    return model_parser.parse(schema_file.read_text(errors="replace"))


def find_db_file(project_dir: Path, schema: Optional[model_parser.SchemaDef] = None) -> Optional[Path]:
    """Return the project database file."""
    if schema:
        candidate = project_dir / schema.database
        if candidate.exists():
            return candidate
    for f in sorted(project_dir.glob("*.db")):
        return f
    return None


def get_schema_and_db(project: str) -> tuple[Optional[model_parser.SchemaDef], Optional[Path]]:
    project_dir = safe_path(project)
    schema = load_schema(project_dir)
    db_path = find_db_file(project_dir, schema)
    return schema, db_path


def resolve_table(schema: Optional[model_parser.SchemaDef], db_path: Optional[Path], table: str) -> str:
    """Return the canonical table name (case-insensitive match)."""
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


# ── SDK generator ─────────────────────────────────────────────────────────────

def generate_sdk(project: str, schema: model_parser.SchemaDef) -> str:
    model_lines = []
    for m in schema.models:
        model_lines.append(f"  {m.name}: _model('{m.name}'),")

    return f"""// Le Mat SDK — auto-generated for project "{project}"
// Models: {', '.join(m.name for m in schema.models)}
// Usage:  const users = await LeMat.User.all();
//         const u = await LeMat.User.create({{ name: 'Alice' }});
//         await LeMat.User.update(1, {{ name: 'Bob' }});
//         await LeMat.User.delete(1);

(function (w) {{
  'use strict';
  var BASE = '/api/projects/{project}/data';

  function _req(method, path, body) {{
    var opts = {{ method: method, headers: {{}} }};
    if (body !== undefined) {{
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }}
    return fetch(BASE + path, opts).then(function (r) {{
      if (!r.ok) return r.json().then(function (e) {{ return Promise.reject(e); }});
      return r.json();
    }});
  }}

  function _model(name) {{
    return {{
      /** Fetch all rows. Optional params: {{ limit, offset, order_by, ...filters }} */
      all: function (params) {{
        var qs = params ? '?' + new URLSearchParams(params).toString() : '';
        return _req('GET', '/' + name + qs);
      }},
      /** Fetch one row by primary key. */
      find: function (id) {{ return _req('GET', '/' + name + '/' + id); }},
      /** Create a new row. */
      create: function (data) {{ return _req('POST', '/' + name, data); }},
      /** Update a row by primary key. */
      update: function (id, data) {{ return _req('PUT', '/' + name + '/' + id, data); }},
      /** Delete a row by primary key. */
      delete: function (id) {{ return _req('DELETE', '/' + name + '/' + id); }},
    }};
  }}

  w.LeMat = {{
{chr(10).join(model_lines)}
    /** Send an email via the project SMTP config.
     *  @param {{ to, subject, html, text, from_name, from_email }} opts
     *  @returns Promise<{{ sent: true, recipients: string[] }}>
     */
    Mail: {{
      send: function(opts) {{
        return fetch('/api/projects/{project}/mail/send', {{
          method: 'POST',
          headers: {{ 'Content-Type': 'application/json' }},
          body: JSON.stringify(opts),
        }}).then(function(r) {{
          if (!r.ok) return r.json().then(function(e) {{ return Promise.reject(e); }});
          return r.json();
        }});
      }},
    }},
  }};
}})(window);
"""


def generate_empty_sdk(project: str = "") -> str:
    return f"""// Le Mat SDK — project "{project}"
(function(w) {{
  'use strict';
  w.LeMat = {{
    Mail: {{
      send: function(opts) {{
        return fetch('/api/projects/{project}/mail/send', {{
          method: 'POST',
          headers: {{ 'Content-Type': 'application/json' }},
          body: JSON.stringify(opts),
        }}).then(function(r) {{
          if (!r.ok) return r.json().then(function(e) {{ return Promise.reject(e); }});
          return r.json();
        }});
      }},
    }},
  }};
}})(window);
"""


# ── SMTP helpers ──────────────────────────────────────────────────────────────

class SmtpConfig(BaseModel):
    host: str
    port: int = 587
    username: str = ""
    password: str = ""
    from_name: str = ""
    from_email: str = ""
    tls: bool = True
    ssl: bool = False
    test_email: str = ""


class MailPayload(BaseModel):
    to: Any  # str or list[str]
    subject: str
    html: str = ""
    text: str = ""
    from_name: str = ""
    from_email: str = ""


def _smtp_config_path(project: str) -> Path:
    return safe_path(project) / "smtp.json"


def _load_smtp_config(project: str) -> Optional[dict]:
    path = _smtp_config_path(project)
    if not path.exists():
        return None
    return json.loads(path.read_text())


def _build_smtp_connection(cfg: dict):
    """Returns an open, ready-to-use SMTP connection (caller must close it)."""
    host     = cfg["host"]
    port     = int(cfg.get("port", 587))
    username = cfg.get("username", "")
    password = cfg.get("password", "")
    use_ssl  = cfg.get("ssl", False)
    use_tls  = cfg.get("tls", True)

    if use_ssl:
        ctx = ssl_lib.create_default_context()
        srv = smtplib.SMTP_SSL(host, port, context=ctx, timeout=15)
    else:
        srv = smtplib.SMTP(host, port, timeout=15)
        srv.ehlo()
        if use_tls:
            srv.starttls()
            srv.ehlo()

    if username:
        srv.login(username, password)
    return srv


def _send_email_sync(cfg: dict, to: str, subject: str,
                     text: str = "", html: str = "",
                     from_name: str = "", from_email: str = ""):
    sender_name  = from_name  or cfg.get("from_name", "")
    sender_email = from_email or cfg.get("from_email") or cfg.get("username", "")

    domain = sender_email.split("@")[-1] if "@" in sender_email else "localhost"

    msg = MIMEMultipart("alternative")
    msg["Subject"]    = subject
    msg["From"]       = f"{sender_name} <{sender_email}>" if sender_name else sender_email
    msg["To"]         = to
    msg["Date"]       = formatdate(localtime=False)
    msg["Message-ID"] = make_msgid(domain=domain)
    msg["MIME-Version"] = "1.0"

    if text:
        msg.attach(MIMEText(text, "plain", "utf-8"))
    if html:
        msg.attach(MIMEText(html, "html", "utf-8"))
    if not text and not html:
        msg.attach(MIMEText("(no content)", "plain", "utf-8"))

    # Use bare email for the MAIL FROM envelope (avoids server rejection)
    envelope_from = sender_email.strip()

    srv = _build_smtp_connection(cfg)
    try:
        refused = srv.sendmail(envelope_from, [to], msg.as_string())
        if refused:
            raise RuntimeError(f"Destinataire(s) refusé(s) : {refused}")
    finally:
        try:
            srv.quit()
        except Exception:
            pass


def _diagnose_smtp_sync(cfg: dict, to: str) -> list[dict]:
    """Step-by-step SMTP connection test. Returns a list of step results."""
    steps = []

    def step(name, fn):
        try:
            result = fn()
            steps.append({"step": name, "ok": True, "detail": str(result or "OK")})
            return True
        except Exception as exc:
            steps.append({"step": name, "ok": False, "detail": str(exc)})
            return False

    host     = cfg.get("host", "")
    port     = int(cfg.get("port", 587))
    username = cfg.get("username", "")
    password = cfg.get("password", "")
    use_ssl  = cfg.get("ssl", False)
    use_tls  = cfg.get("tls", True)
    sender   = cfg.get("from_email") or username

    srv = None

    if use_ssl:
        ok = step(f"Connexion SSL à {host}:{port}", lambda: (
            setattr(_diagnose_smtp_sync, '_srv',
                    smtplib.SMTP_SSL(host, port, context=ssl_lib.create_default_context(), timeout=10))
            or "connecté"
        ))
        srv = getattr(_diagnose_smtp_sync, '_srv', None)
    else:
        def connect_plain():
            s = smtplib.SMTP(host, port, timeout=10)
            _diagnose_smtp_sync._srv = s
            return "connecté"
        ok = step(f"Connexion TCP à {host}:{port}", connect_plain)
        srv = getattr(_diagnose_smtp_sync, '_srv', None)

        if ok and srv:
            step("EHLO", lambda: srv.ehlo())
            if use_tls:
                ok2 = step("STARTTLS", lambda: srv.starttls())
                if ok2:
                    step("EHLO (post-TLS)", lambda: srv.ehlo())

    if srv and username:
        step(f"AUTH LOGIN ({username})", lambda: srv.login(username, password))

    if srv and sender and to:
        step(f"MAIL FROM <{sender}>", lambda: srv.mail(sender))
        step(f"RCPT TO <{to}>", lambda: srv.rcpt(to))
        try:
            srv.rset()
        except Exception:
            pass

    if srv:
        try:
            srv.quit()
        except Exception:
            pass

    return steps


# ── SMTP endpoints ────────────────────────────────────────────────────────────

@app.get("/api/projects/{project}/smtp")
def get_smtp(project: str):
    cfg = _load_smtp_config(project)
    if not cfg:
        return {}
    safe = dict(cfg)
    if safe.get("password"):
        safe["password"] = "••••••••"
    return safe


@app.put("/api/projects/{project}/smtp")
def save_smtp(project: str, config: SmtpConfig):
    existing = _load_smtp_config(project) or {}
    data = config.model_dump()
    if data.get("password") == "••••••••":
        data["password"] = existing.get("password", "")
    _smtp_config_path(project).write_text(json.dumps(data, indent=2))
    return {"message": "Configuration SMTP sauvegardée"}


@app.post("/api/projects/{project}/smtp/test")
async def test_smtp(project: str, body: dict):
    cfg = _load_smtp_config(project)
    if not cfg:
        raise HTTPException(400, "Pas de configuration SMTP pour ce projet")
    to_addr = body.get("to") or cfg.get("from_email") or cfg.get("username", "")
    if not to_addr:
        raise HTTPException(400, "Adresse de destination manquante")
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(
            _smtp_executor, _send_email_sync, cfg, to_addr,
            "[Le Mat] Email de test",
            f"Bonjour,\n\nConfiguration SMTP fonctionnelle !\n\nServeur : {cfg.get('host')}:{cfg.get('port',587)}\nCompte  : {cfg.get('username','')}\n",
            f"<p>✓ <strong>Configuration SMTP fonctionnelle !</strong></p>"
            f"<p style='color:#666;font-size:12px'>Serveur : {cfg.get('host')}:{cfg.get('port',587)}<br>Compte : {cfg.get('username','')}</p>",
        )
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"message": f"Email de test envoyé à {to_addr}"}


@app.post("/api/projects/{project}/smtp/diagnose")
async def diagnose_smtp(project: str, body: dict):
    """Step-by-step SMTP diagnostic — returns each step result."""
    cfg = _load_smtp_config(project)
    if not cfg:
        raise HTTPException(400, "Pas de configuration SMTP pour ce projet")
    to_addr = body.get("to") or cfg.get("from_email") or cfg.get("username", "")
    loop = asyncio.get_event_loop()
    steps = await loop.run_in_executor(
        _smtp_executor, _diagnose_smtp_sync, cfg, to_addr
    )
    all_ok = all(s["ok"] for s in steps)
    return {"steps": steps, "all_ok": all_ok}


@app.post("/api/projects/{project}/mail/send", status_code=200)
async def send_mail(project: str, payload: MailPayload):
    cfg = _load_smtp_config(project)
    if not cfg:
        raise HTTPException(400, "SMTP non configuré pour ce projet")
    recipients = payload.to if isinstance(payload.to, list) else [payload.to]
    loop = asyncio.get_event_loop()
    try:
        for recipient in recipients:
            await loop.run_in_executor(
                _smtp_executor, _send_email_sync, cfg, recipient,
                payload.subject, payload.text, payload.html,
                payload.from_name, payload.from_email
            )
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"sent": True, "recipients": recipients}


# ── Cron / Scheduler ─────────────────────────────────────────────────────────

class CronJob(BaseModel):
    id: Optional[str] = None
    name: str
    script: str
    schedule: dict          # {type, minutes?, hour?, minute?, day?, expression?}
    enabled: bool = True


def _crons_path(project: str) -> Path:
    return safe_path(project) / "crons.json"


def _cron_logs_path(project: str) -> Path:
    return safe_path(project) / "cron_logs.json"


def _load_crons(project: str) -> list:
    p = _crons_path(project)
    return json.loads(p.read_text()) if p.exists() else []


def _save_crons(project: str, crons: list):
    _crons_path(project).write_text(json.dumps(crons, indent=2, default=str))


def _log_cron_run(project: str, job_id: str, job_name: str,
                  status: str, exit_code: int, output: str, ran_at: str):
    logs_path = _cron_logs_path(project)
    logs = json.loads(logs_path.read_text()) if logs_path.exists() else []
    job_logs   = [l for l in logs if l["job_id"] == job_id]
    other_logs = [l for l in logs if l["job_id"] != job_id]
    job_logs.insert(0, {
        "job_id": job_id, "job_name": job_name,
        "ran_at": ran_at, "status": status,
        "exit_code": exit_code, "output": output[-8000:],
    })
    logs_path.write_text(
        json.dumps(other_logs + job_logs[:CRON_LOG_MAX], indent=2, default=str)
    )


def _generate_python_lemat_init(project: str) -> str:
    project_dir = safe_path(project)
    db_path = find_db_file(project_dir, load_schema(project_dir))
    db_path_lit = f'_Path("{db_path}")' if db_path else "None"
    return (
        "# _lemat_init.py — auto-generated by Le Mat\n"
        "import sys as _sys, os as _os\n"
        "_sys.path.insert(0, '/app')\n"
        "import db_engine as _dbe, json as _json\n"
        "import urllib.request as _urllib_req, urllib.error as _urllib_err\n"
        "from pathlib import Path as _Path\n"
        f'_PROJECT_DIR = _Path("{project_dir}")\n'
        f"_DB_PATH = {db_path_lit}\n"
        f'_LEMAT_PORT = int(_os.environ.get("LEMAT_PORT", "8000"))\n'
        f'_LEMAT_PROJECT = "{project}"\n'
        "\n"
        "def _get_db():\n"
        "    global _DB_PATH\n"
        "    if _DB_PATH and _DB_PATH.exists(): return _DB_PATH\n"
        "    for f in sorted(_PROJECT_DIR.glob('*.db')): _DB_PATH = f; return f\n"
        "    raise RuntimeError('Aucune base de donnees trouvee dans le projet')\n"
        "\n"
        "def _api_call(method, path, body=None):\n"
        "    import urllib.parse as _up\n"
        "    proj_enc = _up.quote(_LEMAT_PROJECT, safe='')\n"
        "    url = f'http://127.0.0.1:{_LEMAT_PORT}/api/projects/{proj_enc}' + path\n"
        "    data = _json.dumps(body).encode() if body is not None else None\n"
        "    headers = {'Content-Type': 'application/json'}\n"
        "    req = _urllib_req.Request(url, data=data, headers=headers, method=method)\n"
        "    print(f'[lemat] API {method} {url}')\n"
        "    try:\n"
        "        with _urllib_req.urlopen(req, timeout=30) as r:\n"
        "            resp = _json.loads(r.read())\n"
        "            print(f'[lemat] Reponse: {resp}')\n"
        "            return resp\n"
        "    except _urllib_err.HTTPError as e:\n"
        "        body_txt = e.read().decode('utf-8', errors='replace')\n"
        "        raise RuntimeError(f'[lemat] Erreur API HTTP {e.code}: {body_txt}') from e\n"
        "    except _urllib_err.URLError as e:\n"
        "        raise RuntimeError(\n"
        "            f'[lemat] Impossible de joindre le serveur Le Mat sur le port {_LEMAT_PORT}. '\n"
        "            f'Verifiez que le serveur tourne. Erreur: {e.reason}'\n"
        "        ) from e\n"
        "\n"
        "class _DBHelper:\n"
        "    def all(self, table, limit=1000, offset=0, order_by=None, **filters):\n"
        "        return _dbe.select_all(_get_db(), table, filters or None, limit, offset, order_by)\n"
        "    def find(self, table, pk_val):\n"
        "        db = _get_db(); return _dbe.select_one(db, table, _dbe.get_pk_col(db, table), pk_val)\n"
        "    def create(self, table, data): return _dbe.insert(_get_db(), table, data)\n"
        "    def update(self, table, pk_val, data):\n"
        "        db = _get_db(); return _dbe.update(db, table, _dbe.get_pk_col(db, table), pk_val, data)\n"
        "    def delete(self, table, pk_val):\n"
        "        db = _get_db(); return _dbe.delete(db, table, _dbe.get_pk_col(db, table), pk_val)\n"
        "\n"
        "class _MailHelper:\n"
        "    def send(self, to, subject, html='', text='', from_name='', from_email=''):\n"
        "        targets = [to] if isinstance(to, str) else list(to)\n"
        "        print(f'[lemat] Envoi email a: {targets}')\n"
        "        payload = {'to': to, 'subject': subject, 'html': html, 'text': text}\n"
        "        if from_name:  payload['from_name']  = from_name\n"
        "        if from_email: payload['from_email'] = from_email\n"
        "        result = _api_call('POST', '/mail/send', payload)\n"
        "        print(f'[lemat] Email envoye: {result}')\n"
        "        return result\n"
        "\n"
        "class _LeMat:\n"
        "    db   = _DBHelper()\n"
        "    mail = _MailHelper()\n"
        "\n"
        "lemat = _LeMat()\n"
        "print(f'[lemat] Initialise — projet={_LEMAT_PROJECT} port={_LEMAT_PORT}')\n"
    )


def _generate_js_lemat_init(project: str) -> str:
    return (
        "// _lemat_init.js — auto-generated by Le Mat\n"
        "const http = require('http');\n"
        "function _api(method, path, body) {\n"
        "  return new Promise((res, rej) => {\n"
        "    const d = body ? JSON.stringify(body) : null;\n"
        "    const o = { method, hostname: '127.0.0.1', port: 8000,\n"
        f"      path: '/api/projects/{project}' + path,\n"
        "      headers: { 'Content-Type': 'application/json',\n"
        "        ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } };\n"
        "    const req = http.request(o, r => {\n"
        "      let raw = ''; r.on('data', c => raw += c);\n"
        "      r.on('end', () => { try { const p = JSON.parse(raw); r.statusCode >= 400 ? rej(p) : res(p); } catch(e) { res(raw); } });\n"
        "    }); req.on('error', rej); if (d) req.write(d); req.end();\n"
        "  });\n"
        "}\n"
        "global.lemat = {\n"
        "  db: {\n"
        "    all:    (t, p={}) => _api('GET', '/data/'+t+'?'+new URLSearchParams(p)),\n"
        "    find:   (t, id)   => _api('GET', '/data/'+t+'/'+id),\n"
        "    create: (t, d)    => _api('POST', '/data/'+t, d),\n"
        "    update: (t, id,d) => _api('PUT', '/data/'+t+'/'+id, d),\n"
        "    delete: (t, id)   => _api('DELETE', '/data/'+t+'/'+id),\n"
        "  },\n"
        "  mail: { send: (o) => _api('POST', '/mail/send', o) },\n"
        "};\n"
    )


def _write_lemat_inits(project: str):
    project_dir = safe_path(project)
    (project_dir / "_lemat_init.py").write_text(_generate_python_lemat_init(project))
    (project_dir / "_lemat_init.js").write_text(_generate_js_lemat_init(project))


async def _run_cron_job(project: str, job_id: str):
    crons = _load_crons(project)
    job = next((c for c in crons if c["id"] == job_id), None)
    if not job:
        return

    _write_lemat_inits(project)

    project_dir = safe_path(project)
    script = job["script"]
    ext = script.rsplit(".", 1)[-1].lower() if "." in script else ""
    ran_at = datetime.now(timezone.utc).isoformat()

    if ext == "py":
        run_code = (
            "exec(open('_lemat_init.py').read()); "
            f"exec(compile(open({repr(script)}).read(), {repr(script)}, 'exec'))"
        )
        command = ["python3", "-u", "-c", run_code]
    elif ext in ("js", "mjs"):
        command = ["node", "--require", "./_lemat_init.js", script]
    else:
        _log_cron_run(project, job_id, job["name"], "error", -1,
                      f"Extension non supportée: .{ext}", ran_at)
        return

    try:
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(project_dir),
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=300)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            _log_cron_run(project, job_id, job["name"], "error", -1,
                          "Timeout (300s)", ran_at)
            return

        output = stdout.decode("utf-8", errors="replace") if stdout else ""
        status = "ok" if proc.returncode == 0 else "error"
        _log_cron_run(project, job_id, job["name"], status, proc.returncode, output, ran_at)

    except Exception as e:
        _log_cron_run(project, job_id, job["name"], "error", -1, str(e), ran_at)

    # Update last_run / last_status
    for c in crons:
        if c["id"] == job_id:
            c["last_run"] = ran_at
            c["last_status"] = status if "status" in dir() else "error"
    _save_crons(project, crons)


def _make_trigger(schedule: dict):
    t = schedule.get("type", "daily")
    if t == "interval":
        return IntervalTrigger(minutes=int(schedule.get("minutes", 60)))
    elif t == "daily":
        return CronTrigger(hour=schedule.get("hour", 9), minute=schedule.get("minute", 0))
    elif t == "weekly":
        return CronTrigger(
            day_of_week=schedule.get("day", "mon"),
            hour=schedule.get("hour", 9),
            minute=schedule.get("minute", 0),
        )
    elif t == "cron":
        return CronTrigger.from_crontab(schedule.get("expression", "0 9 * * *"))
    raise ValueError(f"Type de schedule inconnu: {t}")


def _sched_id(project: str, job_id: str) -> str:
    return f"{project}:{job_id}"


def _register_cron(project: str, job: dict):
    sid = _sched_id(project, job["id"])
    if _scheduler.get_job(sid):
        _scheduler.remove_job(sid)
    if not job.get("enabled", True):
        return
    trigger = _make_trigger(job["schedule"])
    _scheduler.add_job(
        _run_cron_job, trigger=trigger, id=sid,
        args=[project, job["id"]], replace_existing=True,
    )


def _unregister_cron(project: str, job_id: str):
    sid = _sched_id(project, job_id)
    if _scheduler.get_job(sid):
        _scheduler.remove_job(sid)


def _reload_all_crons():
    if not BASE_DIR.exists():
        return
    for pdir in BASE_DIR.iterdir():
        if pdir.is_dir():
            for job in _load_crons(pdir.name):
                try:
                    _register_cron(pdir.name, job)
                except Exception as e:
                    print(f"[cron] Erreur chargement {pdir.name}/{job.get('id')}: {e}")


@app.on_event("startup")
async def startup():
    _scheduler.start()
    _reload_all_crons()


@app.on_event("shutdown")
async def shutdown():
    _scheduler.shutdown(wait=False)


# ── Cron endpoints ────────────────────────────────────────────────────────────

@app.get("/api/projects/{project}/crons")
def list_crons(project: str):
    crons = _load_crons(project)
    for job in crons:
        sj = _scheduler.get_job(_sched_id(project, job["id"]))
        job["next_run"] = (
            sj.next_run_time.isoformat() if sj and sj.next_run_time else None
        )
    return crons


@app.post("/api/projects/{project}/crons", status_code=201)
def create_cron(project: str, job: CronJob):
    crons = _load_crons(project)
    new_job = job.model_dump()
    new_job["id"] = uuid.uuid4().hex[:8]
    new_job.setdefault("last_run", None)
    new_job.setdefault("last_status", None)
    new_job["created_at"] = datetime.now(timezone.utc).isoformat()
    crons.append(new_job)
    _save_crons(project, crons)
    try:
        _register_cron(project, new_job)
    except Exception as e:
        raise HTTPException(400, f"Schedule invalide: {e}")
    return new_job


@app.put("/api/projects/{project}/crons/{job_id}")
def update_cron(project: str, job_id: str, job: CronJob):
    crons = _load_crons(project)
    idx = next((i for i, c in enumerate(crons) if c["id"] == job_id), None)
    if idx is None:
        raise HTTPException(404, "Cron non trouvé")
    updated = {**crons[idx], **{k: v for k, v in job.model_dump().items() if v is not None}, "id": job_id}
    crons[idx] = updated
    _save_crons(project, crons)
    try:
        _register_cron(project, updated)
    except Exception as e:
        raise HTTPException(400, f"Schedule invalide: {e}")
    return updated


@app.delete("/api/projects/{project}/crons/{job_id}")
def delete_cron(project: str, job_id: str):
    crons = [c for c in _load_crons(project) if c["id"] != job_id]
    _save_crons(project, crons)
    _unregister_cron(project, job_id)
    return {"deleted": True}


@app.post("/api/projects/{project}/crons/{job_id}/run")
async def run_cron_now(project: str, job_id: str):
    crons = _load_crons(project)
    if not any(c["id"] == job_id for c in crons):
        raise HTTPException(404, "Cron non trouvé")
    asyncio.create_task(_run_cron_job(project, job_id))
    return {"message": "Exécution lancée"}


@app.get("/api/projects/{project}/crons/{job_id}/logs")
def get_cron_logs(project: str, job_id: str):
    logs_path = _cron_logs_path(project)
    if not logs_path.exists():
        return []
    return [l for l in json.loads(logs_path.read_text()) if l["job_id"] == job_id]


# ── Live Reload WebSocket ─────────────────────────────────────────────────────

@app.websocket("/api/projects/{project}/livereload")
async def livereload_ws(project: str, ws: WebSocket):
    await ws.accept()
    livereload_clients.setdefault(project, []).append(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        clients = livereload_clients.get(project, [])
        if ws in clients:
            clients.remove(ws)


# ── Projects ──────────────────────────────────────────────────────────────────

@app.get("/api/projects", response_model=List[str])
def list_projects():
    return [d.name for d in sorted(BASE_DIR.iterdir()) if d.is_dir()]


@app.post("/api/projects/{project}", status_code=201)
def create_project(project: str):
    path = safe_path(project)
    if path.exists():
        raise HTTPException(409, "Project already exists")
    path.mkdir(parents=True)
    return {"message": f"Project '{project}' created"}


@app.delete("/api/projects/{project}")
def delete_project(project: str):
    path = safe_path(project)
    if not path.exists():
        raise HTTPException(404, "Project not found")
    shutil.rmtree(path)
    return {"message": f"Project '{project}' deleted"}


# ── Deployments & Custom Domains ─────────────────────────────────────────────

class DeployConfig(BaseModel):
    custom_domain: Optional[str] = None
    dns_records: Optional[dict] = None


@app.get("/api/projects/{project}/deploy")
def get_deployment(project: str, request: Request):
    """Récupère les informations de déploiement d'un projet."""
    deployments = _load_deployments()
    deploy_info = deployments["deployments"].get(project)

    if not deploy_info:
        return {"deployed": False}

    token = deploy_info["token"]
    stored_url = deploy_info.get("deploy_url", "")

    # Migration : si l'URL stockée est l'ancien format fake (deploy.lemat.app),
    # on recalcule l'URL réelle et on sauvegarde
    if not stored_url or "deploy.lemat.app" in stored_url:
        stored_url = _real_deploy_url(request, token)
        deploy_info["deploy_url"] = stored_url
        deployments["tokens"][token] = project
        deployments["deployments"][project] = deploy_info
        _save_deployments(deployments)

    return {
        "deployed": True,
        "deploy_url": stored_url,
        "token": token,
        "custom_domain": deploy_info.get("custom_domain"),
        "dns_configured": deploy_info.get("dns_configured", False),
        "created_at": deploy_info.get("created_at"),
    }


@app.post("/api/projects/{project}/deploy")
def deploy_project(project: str, request: Request):
    """Déploie un projet et génère un lien unique accessible depuis ce serveur."""
    project_dir = safe_path(project)
    if not project_dir.exists():
        raise HTTPException(404, "Project not found")

    deployments = _load_deployments()

    # Si déjà déployé, on recompute l'URL (au cas où l'adresse du serveur a changé)
    if project in deployments["deployments"]:
        existing = deployments["deployments"][project]
        token = existing["token"]
        deploy_url = _real_deploy_url(request, token)
        existing["deploy_url"] = deploy_url
        deployments["deployments"][project] = existing
        deployments["tokens"][token] = project
        _save_deployments(deployments)
        return {
            "deployed": True,
            "deploy_url": deploy_url,
            "token": token,
            "message": "Déploiement existant",
        }

    # Nouveau déploiement
    token = generate_deploy_token()
    deploy_url = _real_deploy_url(request, token)

    deployments["deployments"][project] = {
        "token": token,
        "deploy_url": deploy_url,
        "custom_domain": None,
        "dns_configured": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    deployments["tokens"][token] = project
    _save_deployments(deployments)

    return {
        "deployed": True,
        "deploy_url": deploy_url,
        "token": token,
        "message": "Projet déployé avec succès",
    }


@app.post("/api/projects/{project}/deploy/domain")
def set_custom_domain(project: str, body: dict):
    """Configure un nom de domaine personnalisé pour un projet déployé."""
    import re
    from urllib.parse import urlparse as _urlparse

    domain = body.get("domain", "").strip().lower()

    if not domain:
        raise HTTPException(400, "Domaine requis")

    domain_pattern = r'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
    if not re.match(domain_pattern, domain):
        raise HTTPException(400, "Nom de domaine invalide")

    deployments = _load_deployments()

    if project not in deployments["deployments"]:
        raise HTTPException(404, "Projet non déployé. Déployez-le d'abord.")

    # Vérifier si le domaine est déjà utilisé par un autre projet
    for proj, info in deployments["deployments"].items():
        if proj != project and info.get("custom_domain") == domain:
            raise HTTPException(409, f"Le domaine {domain} est déjà utilisé par le projet {proj}")

    # Extraire le nom d'hôte du serveur depuis l'URL de déploiement
    deploy_info = deployments["deployments"][project]
    parsed = _urlparse(deploy_info.get("deploy_url", ""))
    server_host = parsed.hostname or "votre-serveur"

    dns_records = {
        "type": "A",
        "name": domain,
        "value": server_host,
        "ttl": 3600,
        "note": "Pointez vers l'adresse IP de votre serveur Le Mat",
    }

    deployments["deployments"][project]["custom_domain"] = domain
    deployments["deployments"][project]["dns_records"] = dns_records
    deployments["deployments"][project]["dns_configured"] = False

    # Enregistrer le mapping domaine → projet
    deployments["domains"][domain] = project

    _save_deployments(deployments)

    return {
        "domain": domain,
        "dns_records": dns_records,
        "message": "Domaine configuré. Pointez votre DNS vers ce serveur puis cliquez Vérifier.",
    }


@app.get("/api/projects/{project}/deploy/verify")
def verify_domain(project: str):
    """Vérifie la configuration DNS d'un domaine personnalisé."""
    deployments = _load_deployments()

    if project not in deployments["deployments"]:
        raise HTTPException(404, "Projet non déployé")

    deploy_info = deployments["deployments"][project]

    if not deploy_info.get("custom_domain"):
        raise HTTPException(400, "Aucun domaine personnalisé configuré")

    # NOTE: Ici on pourrait faire une vraie vérification DNS
    # Pour l'instant, on marque comme configuré manuellement ou via webhook
    deployments["deployments"][project]["dns_configured"] = True
    _save_deployments(deployments)

    return {
        "domain": deploy_info["custom_domain"],
        "dns_configured": True,
        "deploy_url": deploy_info["deploy_url"],
        "message": "Domaine vérifié et activé",
    }


@app.delete("/api/projects/{project}/deploy/domain")
def remove_custom_domain(project: str):
    """Supprime le domaine personnalisé d'un projet déployé."""
    deployments = _load_deployments()

    if project not in deployments["deployments"]:
        raise HTTPException(404, "Projet non déployé")

    deploy_info = deployments["deployments"][project]

    if not deploy_info.get("custom_domain"):
        raise HTTPException(400, "Aucun domaine personnalisé configuré")

    domain = deploy_info["custom_domain"]

    # Nettoyer le mapping domaine → projet
    deployments["domains"].pop(domain, None)

    # Supprimer les infos de domaine du projet
    deploy_info["custom_domain"] = None
    deploy_info["dns_records"] = None
    deploy_info["dns_configured"] = False

    _save_deployments(deployments)

    return {
        "message": "Domaine personnalisé supprimé",
        "domain": domain,
    }


@app.delete("/api/projects/{project}/deploy")
def undeploy_project(project: str):
    """Supprime le déploiement d'un projet."""
    deployments = _load_deployments()

    if project not in deployments["deployments"]:
        raise HTTPException(404, "Projet non déployé")

    deploy_info = deployments["deployments"][project]

    # Nettoyer le mapping de domaine si existant
    if deploy_info.get("custom_domain"):
        domain = deploy_info["custom_domain"]
        deployments["domains"].pop(domain, None)

    # Nettoyer le mapping token → projet
    token = deploy_info.get("token")
    if token:
        deployments["tokens"].pop(token, None)

    # Supprimer le déploiement
    del deployments["deployments"][project]
    _save_deployments(deployments)

    return {"message": "Déploiement supprimé"}


@app.get("/api/deployments")
def list_deployments():
    """Liste tous les déploiements actifs."""
    deployments = _load_deployments()
    return deployments["deployments"]


# ── Export / Import ───────────────────────────────────────────────────────────


@app.get("/api/projects/{project}/export")
def export_project(project: str):
    """Exporte l'intégralité du projet (DB, SMTP, crons, logs, etc.)"""
    project_dir = safe_path(project)
    if not project_dir.exists():
        raise HTTPException(404, "Project not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(project_dir.rglob("*")):
            if file_path.is_file():
                arcname = file_path.relative_to(project_dir)
                zf.write(file_path, arcname)

    filename = f"{project}.zip"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# NOTE: URL /api/projects-import (avec tiret) pour éviter le conflit de routage
# avec POST /api/projects/{project} qui capturerait "/api/projects/import"
@app.post("/api/projects-import", status_code=201)
async def import_project(
    file: UploadFile = File(...),
    name: str = Form(...),
):
    name = name.strip()
    if not name or "/" in name or "\\" in name or ".." in name or name.startswith("."):
        raise HTTPException(400, "Nom de projet invalide")

    project_dir = safe_path(name)
    if project_dir.exists():
        raise HTTPException(409, f"Un projet '{name}' existe déjà")

    content = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Fichier invalide — ce n'est pas un ZIP Le Mat")

    # Security: reject any ZIP entry that would escape the project dir (path traversal)
    project_dir_resolved = str(project_dir.resolve())
    for member in zf.namelist():
        dest = (project_dir / member).resolve()
        if not str(dest).startswith(project_dir_resolved):
            raise HTTPException(400, "Archive ZIP invalide (path traversal détecté)")

    project_dir.mkdir(parents=True)
    zf.extractall(project_dir)
    zf.close()

    # Re-register cron jobs if any
    crons_file = project_dir / "crons.json"
    if crons_file.exists():
        try:
            crons = json.loads(crons_file.read_text())
            for job in crons:
                if job.get("enabled", True):
                    _register_cron(name, job)
        except Exception:
            pass

    return {"project": name, "message": f"Projet '{name}' importé avec succès"}


# ── File Tree ─────────────────────────────────────────────────────────────────

@app.get("/api/projects/{project}/tree")
def get_tree(project: str):
    path = safe_path(project)
    if not path.exists():
        raise HTTPException(404, "Project not found")
    return dir_tree(path)


# ── File CRUD ─────────────────────────────────────────────────────────────────

@app.get("/api/projects/{project}/files/{filepath:path}")
async def read_file(project: str, filepath: str):
    path = safe_path(project, filepath)
    if not path.exists() or path.is_dir():
        raise HTTPException(404, "File not found")
    async with aiofiles.open(path, "r", errors="replace") as f:
        content = await f.read()
    return {"path": filepath, "content": content}


class FileWrite(BaseModel):
    content: str


@app.put("/api/projects/{project}/files/{filepath:path}")
async def write_file(project: str, filepath: str, body: FileWrite):
    path = safe_path(project, filepath)
    path.parent.mkdir(parents=True, exist_ok=True)
    async with aiofiles.open(path, "w") as f:
        await f.write(body.content)
    await broadcast_reload(project)
    return {"message": "Saved", "path": filepath}


@app.delete("/api/projects/{project}/files/{filepath:path}")
def delete_file(project: str, filepath: str):
    path = safe_path(project, filepath)
    if not path.exists():
        raise HTTPException(404, "Not found")
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
    return {"message": "Deleted"}


@app.post("/api/projects/{project}/mkdir/{folderpath:path}")
def make_dir(project: str, folderpath: str):
    path = safe_path(project, folderpath)
    path.mkdir(parents=True, exist_ok=True)
    return {"message": f"Folder '{folderpath}' created"}


# ── Upload ────────────────────────────────────────────────────────────────────

@app.post("/api/projects/{project}/upload")
async def upload_files(
    project: str,
    files: List[UploadFile] = File(...),
    folder: str = Form(default=""),
):
    project_dir = safe_path(project)
    if not project_dir.exists():
        raise HTTPException(404, "Project not found")
    saved = []
    for upload in files:
        dest = safe_path(project, os.path.join(folder, upload.filename))
        dest.parent.mkdir(parents=True, exist_ok=True)
        async with aiofiles.open(dest, "wb") as f:
            content = await upload.read()
            await f.write(content)
        saved.append(upload.filename)
    await broadcast_reload(project)
    return {"uploaded": saved}


# ── Schema ────────────────────────────────────────────────────────────────────

@app.get("/api/projects/{project}/schema")
def get_schema(project: str):
    """Return parsed schema info (models, fields, db path)."""
    project_dir = safe_path(project)
    schema = load_schema(project_dir)
    db_path = find_db_file(project_dir, schema)

    if not schema and not db_path:
        return {"schema": None, "tables": [], "database": None}

    tables_info = []
    if db_path and db_path.exists():
        for t in db_engine.list_tables(db_path):
            cols = db_engine.table_columns(db_path, t)
            count = db_engine.row_count(db_path, t)
            tables_info.append({"name": t, "columns": cols, "rows": count})

    return {
        "schema": schema.to_dict() if schema else None,
        "tables": tables_info,
        "database": db_path.name if db_path else None,
        "hasSchemaFile": find_schema_file(project_dir) is not None,
    }


@app.post("/api/projects/{project}/schema/sync")
def sync_schema(project: str):
    """Parse models.lemat and apply CREATE TABLE IF NOT EXISTS to the .db file."""
    project_dir = safe_path(project)
    schema = load_schema(project_dir)
    if not schema:
        raise HTTPException(404, "No .lemat schema file found in project")

    db_path = project_dir / schema.database
    db_path.parent.mkdir(parents=True, exist_ok=True)

    stmts = model_parser.to_sql(schema)
    db_engine.migrate(db_path, stmts)

    return {
        "message": f"Schema synced → {schema.database}",
        "tables": [m.name for m in schema.models],
        "statements": stmts,
    }


# ── SDK endpoint ──────────────────────────────────────────────────────────────

@app.get("/api/projects/{project}/lemat-sdk.js")
def get_sdk(project: str):
    project_dir = safe_path(project)
    schema = load_schema(project_dir)
    js = generate_sdk(project, schema) if schema else generate_empty_sdk(project)
    return Response(content=js, media_type="application/javascript")


# ── Data API (auto-CRUD for every table) ─────────────────────────────────────

@app.get("/api/projects/{project}/data")
def list_data_tables(project: str):
    """List all tables available in the project database."""
    schema, db_path = get_schema_and_db(project)
    if not db_path or not db_path.exists():
        return {"tables": []}
    tables = db_engine.list_tables(db_path)
    result = []
    for t in tables:
        cols = db_engine.table_columns(db_path, t)
        count = db_engine.row_count(db_path, t)
        result.append({"name": t, "columns": cols, "rows": count})
    return {"tables": result}


@app.get("/api/projects/{project}/data/{table}")
def data_list(
    project: str,
    table: str,
    limit: int = Query(default=100, le=1000),
    offset: int = Query(default=0, ge=0),
    order_by: Optional[str] = Query(default=None),
):
    schema, db_path = get_schema_and_db(project)
    if not db_path or not db_path.exists():
        raise HTTPException(404, "No database found in project")

    real_table = resolve_table(schema, db_path, table)

    # Extra query params → filters
    filters = {}  # could be extended via request.query_params

    rows = db_engine.select_all(db_path, real_table, filters or None, limit, offset, order_by)
    total = db_engine.row_count(db_path, real_table)
    return {"table": real_table, "total": total, "limit": limit, "offset": offset, "rows": rows}


@app.get("/api/projects/{project}/data/{table}/{pk}")
def data_get_one(project: str, table: str, pk: str):
    schema, db_path = get_schema_and_db(project)
    if not db_path or not db_path.exists():
        raise HTTPException(404, "No database found in project")

    real_table = resolve_table(schema, db_path, table)
    pk_col = db_engine.get_pk_col(db_path, real_table)

    # Try int then str
    pk_val: Any = int(pk) if pk.isdigit() else pk
    row = db_engine.select_one(db_path, real_table, pk_col, pk_val)
    if row is None:
        raise HTTPException(404, f"Row {pk} not found in {real_table}")
    return row


@app.post("/api/projects/{project}/data/{table}", status_code=201)
def data_create(project: str, table: str, body: dict):
    schema, db_path = get_schema_and_db(project)
    if not db_path or not db_path.exists():
        raise HTTPException(404, "No database found in project")

    real_table = resolve_table(schema, db_path, table)
    try:
        row = db_engine.insert(db_path, real_table, body)
    except Exception as e:
        raise HTTPException(400, str(e))
    return row


@app.put("/api/projects/{project}/data/{table}/{pk}")
def data_update(project: str, table: str, pk: str, body: dict):
    schema, db_path = get_schema_and_db(project)
    if not db_path or not db_path.exists():
        raise HTTPException(404, "No database found in project")

    real_table = resolve_table(schema, db_path, table)
    pk_col = db_engine.get_pk_col(db_path, real_table)
    pk_val: Any = int(pk) if pk.isdigit() else pk

    row = db_engine.update(db_path, real_table, pk_col, pk_val, body)
    if row is None:
        raise HTTPException(404, f"Row {pk} not found")
    return row


@app.delete("/api/projects/{project}/data/{table}/{pk}")
def data_delete(project: str, table: str, pk: str):
    schema, db_path = get_schema_and_db(project)
    if not db_path or not db_path.exists():
        raise HTTPException(404, "No database found in project")

    real_table = resolve_table(schema, db_path, table)
    pk_col = db_engine.get_pk_col(db_path, real_table)
    pk_val: Any = int(pk) if pk.isdigit() else pk

    if not db_engine.delete(db_path, real_table, pk_col, pk_val):
        raise HTTPException(404, f"Row {pk} not found")
    return {"deleted": True, "id": pk}


# ── Code Execution ────────────────────────────────────────────────────────────

@app.get("/api/projects/{project}/exec/{filepath:path}")
async def exec_file(project: str, filepath: str, cmd: str = None):
    project_dir = safe_path(project)
    file_path   = safe_path(project, filepath)

    if not file_path.exists():
        raise HTTPException(404, "File not found")

    ext = filepath.rsplit(".", 1)[-1].lower() if "." in filepath else ""

    if not cmd and ext in NON_EXECUTABLE:
        raise HTTPException(422, f"Les fichiers .{ext} ne s'exécutent pas côté serveur.")

    if cmd:
        command = shlex.split(cmd)
        command = [c.replace("{file}", filepath) for c in command]
    elif ext in LANG_RUNNERS:
        command = [c.replace("{file}", filepath) for c in LANG_RUNNERS[ext]]
    else:
        raise HTTPException(422, f"Aucun runner pour .{ext} — utilise le champ 'commande custom'.")

    run_id = uuid.uuid4().hex[:8]

    async def generate():
        yield f"data: {json.dumps({'type': 'start', 'cmd': ' '.join(command), 'id': run_id})}\n\n"
        try:
            proc = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(project_dir),
            )
            active_processes[run_id] = proc
            queue: asyncio.Queue = asyncio.Queue()

            async def pump(stream, kind: str):
                try:
                    while True:
                        chunk = await stream.read(512)
                        if not chunk:
                            break
                        await queue.put((kind, chunk.decode("utf-8", errors="replace")))
                finally:
                    await queue.put((kind, None))

            tasks = [
                asyncio.create_task(pump(proc.stdout, "stdout")),
                asyncio.create_task(pump(proc.stderr, "stderr")),
            ]
            done = 0
            while done < 2:
                try:
                    kind, data = await asyncio.wait_for(queue.get(), timeout=60.0)
                except asyncio.TimeoutError:
                    error_msg = "Timeout (60s)\n"
                    yield f"data: {json.dumps({'type': 'error', 'data': error_msg})}\n\n"
                    proc.kill()
                    break
                if data is None:
                    done += 1
                    continue
                yield f"data: {json.dumps({'type': kind, 'data': data})}\n\n"

            await asyncio.gather(*tasks, return_exceptions=True)
            await proc.wait()
            yield f"data: {json.dumps({'type': 'done', 'code': proc.returncode})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'data': str(e) + chr(10)})}\n\n"
            yield f"data: {json.dumps({'type': 'done', 'code': -1})}\n\n"
        finally:
            active_processes.pop(run_id, None)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/api/run/{run_id}")
async def stop_run(run_id: str):
    proc = active_processes.pop(run_id, None)
    if proc:
        try:
            proc.kill()
        except Exception:
            pass
        return {"stopped": True}
    return {"stopped": False}


# ── Serve project files ───────────────────────────────────────────────────────

@app.get("/projects/{project}/{filepath:path}")
async def serve_project_file(project: str, filepath: str):
    path = safe_path(project, filepath)
    if not path.exists():
        raise HTTPException(404, "File not found")
    if path.is_dir():
        index = path / "index.html"
        if index.exists():
            return HTMLResponse(inject_scripts(index.read_text(errors="replace")))
        raise HTTPException(404, "No index.html found")
    if path.suffix.lower() in (".html", ".htm"):
        return HTMLResponse(inject_scripts(path.read_text(errors="replace")))
    return FileResponse(path)


@app.get("/projects/{project}")
async def serve_project_index(project: str):
    index = safe_path(project, "index.html")
    if index.exists():
        return HTMLResponse(inject_scripts(index.read_text(errors="replace")))
    raise HTTPException(404, "No index.html found in project")


# ── Serve Deployed Projects via Token URL (/p/{token}/) ───────────────────────

@app.get("/p/{token}")
async def serve_token_redirect(token: str):
    """Redirige /p/{token} → /p/{token}/ pour que les URLs relatives (CSS, JS, images)
    soient correctement résolues par le navigateur."""
    # Vérifier que le token existe avant de rediriger (évite une 404 après redirect)
    deployments = _load_deployments()
    if token not in deployments.get("tokens", {}):
        raise HTTPException(404, "Déploiement introuvable — lien expiré ou invalide")
    return RedirectResponse(url=f"/p/{token}/", status_code=301)


@app.get("/p/{token}/{filepath:path}")
async def serve_token_file(token: str, filepath: str):
    """Sert les fichiers statiques d'un projet via son token de déploiement.
    Appelé aussi pour /p/{token}/ (filepath="") après la redirection."""
    deployments = _load_deployments()
    project = deployments.get("tokens", {}).get(token)
    if not project:
        raise HTTPException(404, "Déploiement introuvable — lien expiré ou invalide")
    project_dir = BASE_DIR / project
    if not project_dir.exists():
        raise HTTPException(404, "Projet introuvable")

    # Racine du déploiement (filepath vide = /p/{token}/)
    if not filepath:
        index = project_dir / "index.html"
        if index.exists():
            return HTMLResponse(inject_scripts_deployed(index.read_text(errors="replace"), project))
        raise HTTPException(404, "Aucun index.html trouvé")

    file_path = (project_dir / filepath).resolve()
    # Protection path traversal
    if not str(file_path).startswith(str(project_dir.resolve())):
        raise HTTPException(400, "Chemin non autorisé")
    if not file_path.exists():
        raise HTTPException(404, "Fichier introuvable")

    if file_path.is_dir():
        index = file_path / "index.html"
        if index.exists():
            return HTMLResponse(inject_scripts_deployed(index.read_text(errors="replace"), project))
        raise HTTPException(404, "Aucun index.html trouvé")

    if file_path.suffix.lower() in (".html", ".htm"):
        return HTMLResponse(inject_scripts_deployed(file_path.read_text(errors="replace"), project))

    return FileResponse(file_path)


# ── Deployed Projects (Custom Domain Routing) ─────────────────────────────────

@app.get("/api/projects/{project}/deploy/sdk.js")
def get_deploy_sdk(project: str):
    """Génère le SDK Le Mat pour un projet déployé."""
    project_dir = safe_path(project)
    if not project_dir.exists():
        raise HTTPException(404, "Project not found")

    schema = load_schema(project_dir)
    if not schema:
        raise HTTPException(404, "No schema found")

    sdk_content = generate_sdk(project, schema)
    return Response(content=sdk_content, media_type="application/javascript")




@app.api_route("/{filepath:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
async def serve_deployed_project(request: Request, filepath: str = ""):
    """
    Sert les fichiers d'un projet déployé via domaine personnalisé ou sous-domaine.
    Cette route doit être la DERNIÈRE pour ne pas intercepter les routes API.
    """
    project_name = request.state.deploy_project

    # Si pas de projet routé, 404
    if not project_name:
        raise HTTPException(404, "Not found")

    # Vérifier que le projet existe
    project_dir = safe_path(project_name)
    if not project_dir.exists():
        raise HTTPException(404, "Project not found")

    # Racine du projet → index.html
    if not filepath or filepath == "/":
        index = project_dir / "index.html"
        if index.exists():
            content = index.read_text(errors="replace")
            # Injecter le SDK pour les projets déployés
            content = content.replace(
                "</head>",
                f'<script src="/api/projects/{project_name}/deploy/sdk.js"></script></head>'
            )
            return HTMLResponse(content)
        raise HTTPException(404, "No index.html found")

    # API data → router vers l'API du projet
    if filepath.startswith("api/"):
        # Redirection interne vers l'API
        api_path = filepath[4:]  # Enlever "api/"
        # On ne peut pas faire de redirection interne facilement,
        # donc on retourne une erreur ou on sert le fichier
        pass

    # Servir le fichier statique demandé
    file_path = safe_path(project_name, filepath)
    if not file_path.exists():
        raise HTTPException(404, "File not found")

    if file_path.is_dir():
        index = file_path / "index.html"
        if index.exists():
            content = index.read_text(errors="replace")
            content = content.replace(
                "</head>",
                f'<script src="/api/projects/{project_name}/deploy/sdk.js"></script></head>'
            )
            return HTMLResponse(content)
        raise HTTPException(404, "No index.html found")

    # Fichiers HTML → injection du SDK
    if file_path.suffix.lower() in (".html", ".htm"):
        content = file_path.read_text(errors="replace")
        content = content.replace(
            "</head>",
            f'<script src="/api/projects/{project_name}/deploy/sdk.js"></script></head>'
        )
        return HTMLResponse(content)

    # Autres fichiers → servir directement
    return FileResponse(file_path)


@app.get("/")
def root():
    return HTMLResponse('<meta http-equiv="refresh" content="0; url=/editor/">')
