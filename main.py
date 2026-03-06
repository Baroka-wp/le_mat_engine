"""
LEMAT — Main Entry Point  (Phase 0 Runtime)
============================================
Ce fichier est l'orchestrateur. Il :
  1. Instancie le ProjectRegistry (source de vérité pour tous les projets)
  2. Monte les routers LEMAT (projects, files, schema, data, serving)
  3. Garde les sections pas encore migrées en modules : SMTP, Cron, Exec, Deploy
  4. Configure le middleware de routage par domaine personnalisé

Migration vers les modules LEMAT :
  ✅ Projects     → lemat/api/projects.py
  ✅ Files        → lemat/api/files.py
  ✅ Schema/SDK   → lemat/api/schema.py
  ✅ Data CRUD    → lemat/api/data.py
  ✅ Serving      → lemat/router.py
  ✅ SDK generator → lemat/sdk.py
  ✅ Runtime      → lemat/runtime/

  🔄 SMTP        → à migrer en Phase 2 (Services)
  🔄 Cron        → à migrer en Phase 2 (Services)
  🔄 Exec        → à migrer en Phase 2 (Services)
  🔄 Deploy      → à migrer en Phase 6 (Deploy)
"""

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

# ── LEMAT Runtime ──────────────────────────────────────────────────────────────
from lemat.runtime.registry import ProjectRegistry
from lemat.api import projects as api_projects
from lemat.api import files as api_files
from lemat.api import schema as api_schema
from lemat.api import data as api_data
from lemat import router as lemat_router

# ── Base configuration ────────────────────────────────────────────────────────

BASE_DIR = Path(os.environ.get("BASE_DIR", "/data/projects"))
BASE_DIR.mkdir(parents=True, exist_ok=True)

STATIC_DIR = os.environ.get("STATIC_DIR", "/app/static")

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="LEMAT — Data-Centric App Builder")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Static editor UI ──────────────────────────────────────────────────────────

app.mount("/editor", StaticFiles(directory=STATIC_DIR, html=True), name="editor")

# ── LEMAT Routers ─────────────────────────────────────────────────────────────

app.include_router(api_projects.router)
app.include_router(api_files.router)
app.include_router(api_schema.router)
app.include_router(api_data.router)
app.include_router(lemat_router.router)

# ── Startup : initialise le ProjectRegistry ──────────────────────────────────

@app.on_event("startup")
async def startup():
    # Registre central des projets
    registry = ProjectRegistry(BASE_DIR)
    app.state.registry = registry

    # Expose broadcast_reload aux routers (live-reload après écriture de fichier)
    app.state.broadcast_reload = broadcast_reload

    # Scheduler Cron
    _scheduler.start()
    _reload_all_crons()


@app.on_event("shutdown")
async def shutdown():
    _scheduler.shutdown(wait=False)


# ── Root redirect ─────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return HTMLResponse('<meta http-equiv="refresh" content="0; url=/editor/">')


# ── Shared path helper (rétro-compatibilité SMTP/Cron/Exec/Deploy) ────────────

def safe_path(project: str, filepath: str = "") -> Path:
    """Retourne un chemin résolu dans le projet, avec protection path-traversal."""
    project_dir = BASE_DIR / project
    if filepath:
        resolved = (project_dir / filepath).resolve()
        if not str(resolved).startswith(str(project_dir.resolve())):
            raise HTTPException(400, "Path traversal not allowed")
        return resolved
    return project_dir


def _load_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass
    return default


def _save_json(path: Path, data, **kwargs) -> None:
    path.write_text(json.dumps(data, **kwargs))


# ── Deployments ───────────────────────────────────────────────────────────────

DEPLOYMENTS_FILE = BASE_DIR.parent / "deployments.json"
DEPLOYMENTS_FILE.parent.mkdir(parents=True, exist_ok=True)

# Domaines réservés à LEMAT lui-même
_LEMAT_MAIN_DOMAINS: set[str] = {
    h.strip().lower()
    for h in os.environ.get("LEMAT_MAIN_DOMAIN", "").split(",")
    if h.strip()
}


def _load_deployments() -> dict:
    data = _load_json(DEPLOYMENTS_FILE, {"deployments": {}, "domains": {}, "tokens": {}})
    if "tokens" not in data:
        data["tokens"] = {}
        for proj, info in data.get("deployments", {}).items():
            tok = info.get("token")
            if tok:
                data["tokens"][tok] = proj
    if "domains" not in data:
        data["domains"] = {}
    for proj, info in data.get("deployments", {}).items():
        domain = info.get("custom_domain")
        if domain and domain not in data["domains"]:
            data["domains"][domain] = proj
    return data


def _save_deployments(data: dict):
    _save_json(DEPLOYMENTS_FILE, data, indent=2)


def generate_deploy_token() -> str:
    return str(uuid.uuid4())[:8]


def _real_deploy_url(request: Request, token: str) -> str:
    base = os.getenv("LEMAT_BASE_URL", "").rstrip("/")
    if not base:
        host = request.headers.get("x-forwarded-host") or request.headers.get("host", "localhost:8000")
        scheme = request.headers.get("x-forwarded-proto", "http")
        base = f"{scheme}://{host}"
    return f"{base}/p/{token}"


# ── Custom domain routing middleware ─────────────────────────────────────────

@app.middleware("http")
async def custom_domain_routing(request, call_next):
    raw = (
        request.headers.get("x-forwarded-host") or
        request.headers.get("host", "")
    )
    host = raw.split(":")[0].strip().lower()

    if host in _LEMAT_MAIN_DOMAINS:
        request.state.deploy_project = None
        return await call_next(request)

    deployments = _load_deployments()
    project_name = deployments["domains"].get(host)
    request.state.deploy_project = project_name
    return await call_next(request)


# ── Live Reload WebSocket ─────────────────────────────────────────────────────

livereload_clients: dict[str, list[WebSocket]] = {}


async def broadcast_reload(project: str):
    dead = []
    for ws in livereload_clients.get(project, []):
        try:
            await ws.send_text("reload")
        except Exception:
            dead.append(ws)
    for ws in dead:
        livereload_clients[project].remove(ws)


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


# ── SMTP ──────────────────────────────────────────────────────────────────────
# 🔄 À migrer vers lemat/api/services/smtp.py en Phase 2

_smtp_executor = ThreadPoolExecutor(max_workers=4)


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
    to: Any
    subject: str
    html: str = ""
    text: str = ""
    from_name: str = ""
    from_email: str = ""


def _smtp_config_path(project: str) -> Path:
    return safe_path(project) / "smtp.json"


def _load_smtp_config(project: str) -> Optional[dict]:
    return _load_json(_smtp_config_path(project))


def _build_smtp_connection(cfg: dict):
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

    srv = _build_smtp_connection(cfg)
    try:
        srv.sendmail(sender_email.strip(), [to], msg.as_string())
    finally:
        try:
            srv.quit()
        except Exception:
            pass


def _diagnose_smtp_sync(cfg: dict, to: str) -> list[dict]:
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
    srv      = None

    if use_ssl:
        ok = step(f"SSL {host}:{port}", lambda: (
            setattr(_diagnose_smtp_sync, '_srv',
                    smtplib.SMTP_SSL(host, port,
                                     context=ssl_lib.create_default_context(), timeout=10))
            or "OK"
        ))
    else:
        def _conn():
            s = smtplib.SMTP(host, port, timeout=10)
            _diagnose_smtp_sync._srv = s
            return "OK"
        ok = step(f"TCP {host}:{port}", _conn)

    srv = getattr(_diagnose_smtp_sync, '_srv', None)

    if ok and srv and not use_ssl:
        step("EHLO", lambda: srv.ehlo())
        if use_tls:
            ok2 = step("STARTTLS", lambda: srv.starttls())
            if ok2:
                step("EHLO (post-TLS)", lambda: srv.ehlo())

    if srv and username:
        step(f"AUTH {username}", lambda: srv.login(username, password))

    if srv and sender and to:
        step(f"MAIL FROM <{sender}>", lambda: srv.mail(sender))
        step(f"RCPT TO <{to}>",       lambda: srv.rcpt(to))
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
    _save_json(_smtp_config_path(project), data, indent=2)
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
            "[LEMAT] Email de test",
            f"Configuration SMTP fonctionnelle !\n\nServeur : {cfg.get('host')}:{cfg.get('port', 587)}\n",
            f"<p><strong>✓ Configuration SMTP fonctionnelle !</strong></p>"
            f"<p style='color:#666;font-size:12px'>Serveur : {cfg.get('host')}:{cfg.get('port', 587)}</p>",
        )
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"message": f"Email de test envoyé à {to_addr}"}


@app.post("/api/projects/{project}/smtp/diagnose")
async def diagnose_smtp(project: str, body: dict):
    cfg = _load_smtp_config(project)
    if not cfg:
        raise HTTPException(400, "Pas de configuration SMTP pour ce projet")
    to_addr = body.get("to") or cfg.get("from_email") or cfg.get("username", "")
    loop = asyncio.get_event_loop()
    steps = await loop.run_in_executor(_smtp_executor, _diagnose_smtp_sync, cfg, to_addr)
    return {"steps": steps, "all_ok": all(s["ok"] for s in steps)}


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


# ── Cron / Scheduler ──────────────────────────────────────────────────────────
# 🔄 À migrer vers lemat/api/services/cron.py en Phase 2

_scheduler = AsyncIOScheduler(timezone="UTC")
CRON_LOG_MAX = 20


class CronJob(BaseModel):
    id: Optional[str] = None
    name: str
    script: str
    schedule: dict
    enabled: bool = True


def _crons_path(project: str) -> Path:
    return safe_path(project) / "crons.json"


def _cron_logs_path(project: str) -> Path:
    return safe_path(project) / "cron_logs.json"


def _load_crons(project: str) -> list:
    return _load_json(_crons_path(project), default=[])


def _save_crons(project: str, crons: list):
    _save_json(_crons_path(project), crons, indent=2, default=str)


def _log_cron_run(project: str, job_id: str, job_name: str,
                  status: str, exit_code: int, output: str, ran_at: str):
    logs_path = _cron_logs_path(project)
    logs = _load_json(logs_path, default=[])
    job_logs   = [l for l in logs if l["job_id"] == job_id]
    other_logs = [l for l in logs if l["job_id"] != job_id]
    job_logs.insert(0, {
        "job_id": job_id, "job_name": job_name,
        "ran_at": ran_at, "status": status,
        "exit_code": exit_code, "output": output[-8000:],
    })
    _save_json(logs_path, other_logs + job_logs[:CRON_LOG_MAX], indent=2, default=str)


def _generate_python_lemat_init(project: str) -> str:
    project_dir = safe_path(project)
    rt = ProjectRegistry(BASE_DIR).get(project)
    db_path = rt.db_path if rt else None
    db_path_lit = f'_Path("{db_path}")' if db_path else "None"
    return (
        "# _lemat_init.py — auto-generated by LEMAT\n"
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
        "    try:\n"
        "        with _urllib_req.urlopen(req, timeout=30) as r:\n"
        "            return _json.loads(r.read())\n"
        "    except _urllib_err.HTTPError as e:\n"
        "        body_txt = e.read().decode('utf-8', errors='replace')\n"
        "        raise RuntimeError(f'API HTTP {e.code}: {body_txt}') from e\n"
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
        "        return _api_call('POST', '/mail/send',\n"
        "            {'to': to, 'subject': subject, 'html': html, 'text': text})\n"
        "\n"
        "class _LeMat:\n"
        "    db   = _DBHelper()\n"
        "    mail = _MailHelper()\n"
        "\n"
        "lemat = _LeMat()\n"
    )


def _generate_js_lemat_init(project: str) -> str:
    return (
        "// _lemat_init.js — auto-generated by LEMAT\n"
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
            _log_cron_run(project, job_id, job["name"], "error", -1, "Timeout (300s)", ran_at)
            return

        output = stdout.decode("utf-8", errors="replace") if stdout else ""
        status = "ok" if proc.returncode == 0 else "error"
        _log_cron_run(project, job_id, job["name"], status, proc.returncode, output, ran_at)

    except Exception as e:
        _log_cron_run(project, job_id, job["name"], "error", -1, str(e), ran_at)
        status = "error"

    for c in crons:
        if c["id"] == job_id:
            c["last_run"] = ran_at
            c["last_status"] = status
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
                    print(f"[cron] Erreur {pdir.name}/{job.get('id')}: {e}")


@app.get("/api/projects/{project}/crons")
def list_crons(project: str):
    crons = _load_crons(project)
    for job in crons:
        sj = _scheduler.get_job(_sched_id(project, job["id"]))
        job["next_run"] = sj.next_run_time.isoformat() if sj and sj.next_run_time else None
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
    logs = _load_json(_cron_logs_path(project), default=[])
    return [l for l in logs if l["job_id"] == job_id]


# ── Code Execution ────────────────────────────────────────────────────────────
# 🔄 À migrer vers lemat/api/services/exec.py en Phase 2

LANG_RUNNERS = {
    "py":   ["python3", "-u", "{file}"],
    "js":   ["node", "{file}"],
    "mjs":  ["node", "{file}"],
    "ts":   ["npx", "ts-node", "{file}"],
    "sh":   ["bash", "{file}"],
    "rb":   ["ruby", "{file}"],
    "php":  ["php", "{file}"],
    "go":   ["go", "run", "{file}"],
    "rs":   ["cargo", "script", "{file}"],
    "r":    ["Rscript", "{file}"],
    "lua":  ["lua", "{file}"],
    "java": ["java", "{file}"],
}
NON_EXECUTABLE = {"html", "css", "json", "md", "txt", "csv", "xml", "yaml", "yml", "svg"}
active_processes: dict[str, Any] = {}


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
        command = [c.replace("{file}", filepath) for c in shlex.split(cmd)]
    elif ext in LANG_RUNNERS:
        command = [c.replace("{file}", filepath) for c in LANG_RUNNERS[ext]]
    else:
        raise HTTPException(422, f"Aucun runner pour .{ext}")

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
                    _timeout_msg = json.dumps({'type': 'error', 'data': 'Timeout (60s)\n'})
                    yield f"data: {_timeout_msg}\n\n"
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


# ── Deploy ────────────────────────────────────────────────────────────────────
# 🔄 À migrer vers lemat/api/deploy.py en Phase 6

@app.get("/api/projects/{project}/deploy")
def get_deployment(project: str, request: Request):
    deployments = _load_deployments()
    deploy_info = deployments["deployments"].get(project)
    if not deploy_info:
        return {"deployed": False}
    token = deploy_info["token"]
    stored_url = deploy_info.get("deploy_url", "")
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
    if not (BASE_DIR / project).exists():
        raise HTTPException(404, "Project not found")
    deployments = _load_deployments()
    if project in deployments["deployments"]:
        existing = deployments["deployments"][project]
        token = existing["token"]
        deploy_url = _real_deploy_url(request, token)
        existing["deploy_url"] = deploy_url
        deployments["deployments"][project] = existing
        deployments["tokens"][token] = project
        _save_deployments(deployments)
        return {"deployed": True, "deploy_url": deploy_url, "token": token}
    token = generate_deploy_token()
    deploy_url = _real_deploy_url(request, token)
    deployments["deployments"][project] = {
        "token": token, "deploy_url": deploy_url,
        "custom_domain": None, "dns_configured": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    deployments["tokens"][token] = project
    _save_deployments(deployments)
    return {"deployed": True, "deploy_url": deploy_url, "token": token}


@app.post("/api/projects/{project}/deploy/domain")
def set_custom_domain(project: str, body: dict):
    import re
    from urllib.parse import urlparse as _urlparse
    domain = body.get("domain", "").strip().lower()
    if not domain:
        raise HTTPException(400, "Domaine requis")
    if not re.match(r'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$', domain):
        raise HTTPException(400, "Nom de domaine invalide")
    deployments = _load_deployments()
    if project not in deployments["deployments"]:
        raise HTTPException(404, "Projet non déployé")
    for proj, info in deployments["deployments"].items():
        if proj != project and info.get("custom_domain") == domain:
            raise HTTPException(409, f"Domaine déjà utilisé par '{proj}'")
    deploy_info = deployments["deployments"][project]
    from urllib.parse import urlparse as _up
    server_host = _up(deploy_info.get("deploy_url", "")).hostname or "votre-serveur"
    dns_records = {"type": "A", "name": domain, "value": server_host, "ttl": 3600}
    deploy_info.update({"custom_domain": domain, "dns_records": dns_records, "dns_configured": False})
    deployments["domains"][domain] = project
    _save_deployments(deployments)
    return {"domain": domain, "dns_records": dns_records}


@app.get("/api/projects/{project}/deploy/verify")
def verify_domain(project: str):
    deployments = _load_deployments()
    if project not in deployments["deployments"]:
        raise HTTPException(404, "Projet non déployé")
    deploy_info = deployments["deployments"][project]
    if not deploy_info.get("custom_domain"):
        raise HTTPException(400, "Aucun domaine configuré")
    deployments["deployments"][project]["dns_configured"] = True
    _save_deployments(deployments)
    return {"domain": deploy_info["custom_domain"], "dns_configured": True}


@app.delete("/api/projects/{project}/deploy/domain")
def remove_custom_domain(project: str):
    deployments = _load_deployments()
    if project not in deployments["deployments"]:
        raise HTTPException(404, "Projet non déployé")
    deploy_info = deployments["deployments"][project]
    if not deploy_info.get("custom_domain"):
        raise HTTPException(400, "Aucun domaine configuré")
    domain = deploy_info["custom_domain"]
    deployments["domains"].pop(domain, None)
    deploy_info.update({"custom_domain": None, "dns_records": None, "dns_configured": False})
    _save_deployments(deployments)
    return {"deleted": True, "domain": domain}


@app.delete("/api/projects/{project}/deploy")
def undeploy_project(project: str):
    deployments = _load_deployments()
    if project not in deployments["deployments"]:
        raise HTTPException(404, "Projet non déployé")
    deploy_info = deployments["deployments"][project]
    if deploy_info.get("custom_domain"):
        deployments["domains"].pop(deploy_info["custom_domain"], None)
    if deploy_info.get("token"):
        deployments["tokens"].pop(deploy_info["token"], None)
    del deployments["deployments"][project]
    _save_deployments(deployments)
    return {"deleted": True}


@app.get("/api/deployments")
def list_deployments():
    return _load_deployments()["deployments"]


# ── Import ────────────────────────────────────────────────────────────────────
# (Export est géré par lemat/api/projects.py)

@app.post("/api/projects-import", status_code=201)
async def import_project(
    file: UploadFile = File(...),
    name: str = Form(...),
):
    name = name.strip()
    if not name or "/" in name or ".." in name or name.startswith("."):
        raise HTTPException(400, "Nom de projet invalide")
    project_dir = BASE_DIR / name
    if project_dir.exists():
        raise HTTPException(409, f"Projet '{name}' existe déjà")
    content = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Fichier ZIP invalide")
    resolved_base = str(project_dir.resolve())
    for member in zf.namelist():
        if not str((project_dir / member).resolve()).startswith(resolved_base):
            raise HTTPException(400, "Path traversal détecté dans le ZIP")
    project_dir.mkdir(parents=True)
    zf.extractall(project_dir)
    zf.close()
    try:
        for job in _load_json(project_dir / "crons.json", default=[]):
            if job.get("enabled", True):
                _register_cron(name, job)
    except Exception:
        pass
    return {"project": name, "imported": True}


# ── Catch-all : custom domain serving ────────────────────────────────────────

@app.api_route("/{filepath:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
async def serve_deployed_project(request: Request, filepath: str = ""):
    from lemat.router import serve_deployed_project as _serve
    result = await _serve(request, filepath)
    if result is not None:
        return result
    if not filepath:
        return RedirectResponse(url="/editor/", status_code=302)
    raise HTTPException(404, "Not found")
