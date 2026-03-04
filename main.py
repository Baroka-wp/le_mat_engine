import asyncio
import json
import os
import shlex
import shutil
import uuid
from pathlib import Path
from typing import List

import aiofiles
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

BASE_DIR = Path("/data/projects")
BASE_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Le Mat - Deployment Platform")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/editor", StaticFiles(directory="/app/static", html=True), name="editor")

# Registry of running processes  { run_id -> Process }
active_processes: dict[str, asyncio.subprocess.Process] = {}

# Live reload: project name → list of connected WebSockets
livereload_clients: dict[str, list[WebSocket]] = {}

LANG_RUNNERS = {
    "py":  ["python3", "-u", "{file}"],
    "js":  ["node", "{file}"],
    "mjs": ["node", "{file}"],
    "ts":  ["npx", "--yes", "ts-node", "{file}"],
    "sh":  ["bash", "{file}"],
}

# Script injected into every served HTML page for live reload
LIVERELOAD_SCRIPT = """<script>
(function(){
  var proj = location.pathname.split('/')[2];
  function connect(){
    var ws = new WebSocket('ws://' + location.host + '/api/projects/' + proj + '/livereload');
    ws.onmessage = function(){ location.reload(); };
    ws.onclose   = function(){ setTimeout(connect, 1500); };
  }
  connect();
})();
</script>"""


# ─── Helpers ─────────────────────────────────────────────────────────────────

def safe_path(project: str, filepath: str = "") -> Path:
    project_dir = BASE_DIR / project
    if filepath:
        resolved = (project_dir / filepath).resolve()
        if not str(resolved).startswith(str(project_dir.resolve())):
            raise HTTPException(status_code=400, detail="Path traversal not allowed")
        return resolved
    return project_dir


def dir_tree(root: Path, rel: Path = None) -> dict:
    if rel is None:
        rel = root
    entries = []
    for item in sorted(root.iterdir(), key=lambda x: (x.is_file(), x.name)):
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
    """Notify all live-reload clients for a project."""
    dead = []
    for ws in livereload_clients.get(project, []):
        try:
            await ws.send_text("reload")
        except Exception:
            dead.append(ws)
    for ws in dead:
        livereload_clients[project].remove(ws)


def inject_livereload(html: str) -> str:
    if "</body>" in html:
        return html.replace("</body>", LIVERELOAD_SCRIPT + "</body>", 1)
    return html + LIVERELOAD_SCRIPT


# ─── Live Reload WebSocket ────────────────────────────────────────────────────

@app.websocket("/api/projects/{project}/livereload")
async def livereload_ws(project: str, ws: WebSocket):
    await ws.accept()
    livereload_clients.setdefault(project, []).append(ws)
    try:
        while True:
            await ws.receive_text()   # keep-alive ping/pong
    except WebSocketDisconnect:
        clients = livereload_clients.get(project, [])
        if ws in clients:
            clients.remove(ws)


# ─── Projects ─────────────────────────────────────────────────────────────────

@app.get("/api/projects", response_model=List[str])
def list_projects():
    return [d.name for d in BASE_DIR.iterdir() if d.is_dir()]


@app.post("/api/projects/{project}", status_code=201)
def create_project(project: str):
    path = safe_path(project)
    if path.exists():
        raise HTTPException(status_code=409, detail="Project already exists")
    path.mkdir(parents=True)
    return {"message": f"Project '{project}' created"}


@app.delete("/api/projects/{project}")
def delete_project(project: str):
    path = safe_path(project)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    shutil.rmtree(path)
    return {"message": f"Project '{project}' deleted"}


# ─── File Tree ────────────────────────────────────────────────────────────────

@app.get("/api/projects/{project}/tree")
def get_tree(project: str):
    path = safe_path(project)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    return dir_tree(path)


# ─── File CRUD ────────────────────────────────────────────────────────────────

@app.get("/api/projects/{project}/files/{filepath:path}")
async def read_file(project: str, filepath: str):
    path = safe_path(project, filepath)
    if not path.exists() or path.is_dir():
        raise HTTPException(status_code=404, detail="File not found")
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
    # Notify browser tabs watching this project
    await broadcast_reload(project)
    return {"message": "Saved", "path": filepath}


@app.delete("/api/projects/{project}/files/{filepath:path}")
def delete_file(project: str, filepath: str):
    path = safe_path(project, filepath)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Not found")
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
    return {"message": "Deleted"}


# ─── Upload ───────────────────────────────────────────────────────────────────

@app.post("/api/projects/{project}/upload")
async def upload_files(
    project: str,
    files: List[UploadFile] = File(...),
    folder: str = Form(default=""),
):
    project_dir = safe_path(project)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")
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


@app.post("/api/projects/{project}/mkdir/{folderpath:path}")
def make_dir(project: str, folderpath: str):
    path = safe_path(project, folderpath)
    path.mkdir(parents=True, exist_ok=True)
    return {"message": f"Folder '{folderpath}' created"}


# ─── Code Execution (SSE streaming) ──────────────────────────────────────────

NON_EXECUTABLE = {"html", "htm", "css", "svg", "json", "xml", "md", "txt"}


@app.get("/api/projects/{project}/exec/{filepath:path}")
async def exec_file(project: str, filepath: str, cmd: str = None):
    project_dir = safe_path(project)
    file_path   = safe_path(project, filepath)

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    ext = filepath.rsplit(".", 1)[-1].lower() if "." in filepath else ""

    if not cmd and ext in NON_EXECUTABLE:
        raise HTTPException(
            status_code=422,
            detail=f"Les fichiers .{ext} ne s'exécutent pas côté serveur.",
        )

    if cmd:
        command = shlex.split(cmd)
        command = [c.replace("{file}", filepath) for c in command]
    elif ext in LANG_RUNNERS:
        command = [c.replace("{file}", filepath) for c in LANG_RUNNERS[ext]]
    else:
        raise HTTPException(
            status_code=422,
            detail=f"Aucun runner pour .{ext} — utilise le champ 'commande custom'.",
        )

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
                    yield f"data: {json.dumps({'type': 'error', 'data': 'Timeout (60s)\n'})}\n\n"
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


# ─── Serve project files (with live reload injected in HTML) ─────────────────

@app.get("/projects/{project}/{filepath:path}")
async def serve_project_file(project: str, filepath: str):
    path = safe_path(project, filepath)
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if path.is_dir():
        index = path / "index.html"
        if index.exists():
            return HTMLResponse(inject_livereload(index.read_text(errors="replace")))
        raise HTTPException(status_code=404, detail="No index.html found")
    if path.suffix.lower() in (".html", ".htm"):
        return HTMLResponse(inject_livereload(path.read_text(errors="replace")))
    return FileResponse(path)


@app.get("/projects/{project}")
async def serve_project_index(project: str):
    index = safe_path(project, "index.html")
    if index.exists():
        return HTMLResponse(inject_livereload(index.read_text(errors="replace")))
    raise HTTPException(status_code=404, detail="No index.html found in project")


@app.get("/")
def root():
    return HTMLResponse('<meta http-equiv="refresh" content="0; url=/editor/">')
