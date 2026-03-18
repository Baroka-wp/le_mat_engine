# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Le Mat / LEMAT

LEMAT is a self-hosted, data-centric app builder. Developers define a schema (`.lemat` files), and the platform auto-generates a SQLite database, REST API, JavaScript SDK, and serves the project files from a built-in Monaco editor. Projects support cron jobs, email (SMTP), live reload, and custom domain deployments.

## Commands

### Development
```bash
./dev.sh
```
Creates venv if needed, installs deps, and starts uvicorn with hot-reload on `http://localhost:8000`.

### Production
```bash
docker-compose up -d
```
Runs behind nginx on localhost:8000 (see `nginx.conf`).

### Dependencies
```bash
pip install -r requirements.txt
```

No test runner, no linter configuration exists in the project.

## Architecture

### Backend: `main.py` (single-file FastAPI, ~1900 lines)

All server logic lives in `main.py`. Key areas:

- **Middleware** (`custom_domain_routing`): Routes requests by `Host` header to the correct project.
- **Project serving** (`/projects/{project}/...` and `/p/{token}/...`): Serves project files with live reload script + lemat-sdk injected into HTML responses.
- **API routes** (`/api/projects/...`): Full CRUD for projects, files, database, cron, SMTP, exec, deploy.
- **WebSocket** (`/api/projects/{project}/livereload`): Pushes reload signals to connected browsers on file save.
- **Code execution** (`/api/projects/{project}/exec/{filepath}`): Runs Python, Node, TypeScript, or Bash files as subprocesses. Active processes tracked in `active_processes` dict.
- **Scheduler**: APScheduler (`_scheduler`) manages cron jobs per project, persisted via `db_engine.py`.

### Schema Parser: `model_parser.py`

Parses `.lemat` schema files into table/column definitions. Schema decorators: `@id`, `@required`, `@unique`, `@default(value)`, `@ref(OtherTable)`. Types: `integer`, `text`, `real`, `boolean`, `datetime`, `blob`, `json`.

### Database Layer: `db_engine.py`

Thin SQLite wrapper with WAL mode and foreign key constraints. Each project has its own `.db` file at `data/projects/{name}/.lemat/db.sqlite3`.

### Frontend: `static/`

- `index.html` + `app.js` (62 KB vanilla JS) + `style.css` (41 KB): Monaco-based editor and project dashboard. No framework.
- Communicates with the backend via fetch + WebSocket.

### Project Data Layout

Each project lives in `data/projects/{project_name}/`:
```
schema.lemat        # Database schema definition
config.lemat        # Project configuration
pages/              # HTML pages served at /projects/{name}/...
logic/              # Server-side scripts (Python/Node/Bash)
static/             # Static assets
.lemat/             # Internal: db.sqlite3, smtp.json, crons.json
```

`data/deployments.json` maps deployment tokens and custom domains to project names.

### Deployment & Routing

- Each deployed project gets a URL: `https://{project}-{token}.engine.irotoribaroka.com`
- Custom domains via CNAME DNS → nginx passes `Host` header → middleware resolves project
- Environment variables in `docker-compose.yml`: `LEMAT_MAIN_DOMAIN`, `LEMAT_BASE_URL`

### Security

- `safe_path()` in `main.py` prevents path traversal for all file operations.
- CORS is fully open (no auth — projects are name-based only).
- Hidden files (`.lemat/`, etc.) are excluded from the file tree via `HIDDEN_SUFFIXES`.
