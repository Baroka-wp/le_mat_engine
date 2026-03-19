"""
Le Mat — Agent Project Memory
Builds and maintains a JSON cache of the project structure to avoid
re-reading files and save tokens. The memory is stored as _agent_memory.json
inside the project directory.
"""

import json
import os
import re
import time
from pathlib import Path
from typing import Optional

# Files that should never appear in memory
HIDDEN_NAMES = {
    "_lemat_init.py", "_lemat_init.js", "_lemat_api_init.js",
    "_meta.json", "_agent.json", "_agent_history.json",
    "_agent_memory.json", "_agent_pipeline_state.json",
    "api_keys.json", "smtp.json", "crons.json", "cron_logs.json",
    "__pycache__", "node_modules", ".git", ".DS_Store",
}

MEMORY_FILE = "_agent_memory.json"

# Max file size to include in summaries (chars)
MAX_SUMMARY_SIZE = 4000
# Max total memory size before we start trimming
MAX_MEMORY_CHARS = 60000


def _memory_path(project_dir: Path) -> Path:
    return project_dir / MEMORY_FILE


def load_memory(project_dir: Path) -> dict:
    """Load existing memory or return empty structure."""
    mp = _memory_path(project_dir)
    if mp.exists():
        try:
            data = json.loads(mp.read_text("utf-8"))
            # Validate structure
            if isinstance(data, dict) and "version" in data:
                return data
        except (json.JSONDecodeError, OSError):
            pass
    return _empty_memory()


def save_memory(project_dir: Path, memory: dict):
    """Persist memory to disk."""
    memory["updated_at"] = time.time()
    content = json.dumps(memory, ensure_ascii=False, indent=2)
    # Trim if too large
    if len(content) > MAX_MEMORY_CHARS:
        _trim_memory(memory)
        content = json.dumps(memory, ensure_ascii=False, indent=2)
    _memory_path(project_dir).write_text(content, encoding="utf-8")


def _empty_memory() -> dict:
    return {
        "version": 1,
        "updated_at": 0,
        "project": {
            "description": "",
            "tech_stack": [],
        },
        "file_tree": [],
        "schemas": {},
        "pages": [],
        "api_routes": [],
        "file_summaries": {},
    }


def build_memory_from_scratch(project_dir: Path) -> dict:
    """
    Scan the entire project and build a complete memory.
    Called on first agent interaction or when memory is stale.
    """
    memory = _empty_memory()
    if not project_dir.exists():
        return memory

    # 1. File tree
    memory["file_tree"] = _scan_file_tree(project_dir)

    # 2. Detect tech stack
    memory["project"]["tech_stack"] = _detect_tech_stack(project_dir)

    # 3. Parse .lemat schemas
    memory["schemas"] = _parse_all_schemas(project_dir)

    # 4. Detect HTML pages
    memory["pages"] = _detect_pages(project_dir)

    # 5. Detect API routes
    memory["api_routes"] = _detect_api_routes(project_dir)

    # 6. Build file summaries for key files
    memory["file_summaries"] = _build_file_summaries(project_dir)

    # 7. Read project description from _meta.json
    meta_path = project_dir / "_meta.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text("utf-8"))
            memory["project"]["description"] = meta.get("description", "")
        except Exception:
            pass

    memory["updated_at"] = time.time()
    return memory


def update_memory_after_action(
    project_dir: Path,
    memory: dict,
    action: str,
    path: str,
    content: Optional[str] = None,
) -> dict:
    """
    Incrementally update memory after a tool action.
    Much cheaper than rebuilding from scratch.
    """
    rel_path = path

    if action in ("create_file", "edit_file"):
        # Update file tree
        _ensure_in_tree(memory["file_tree"], rel_path)
        # Update summary
        if content is not None:
            memory["file_summaries"][rel_path] = _summarize_file(rel_path, content)
        # Re-detect if it's a schema, page, or API route
        if rel_path.endswith(".lemat"):
            memory["schemas"] = _parse_all_schemas(project_dir)
        if rel_path.endswith(".html"):
            memory["pages"] = _detect_pages(project_dir)
        if rel_path.startswith("api/"):
            memory["api_routes"] = _detect_api_routes(project_dir)

    elif action == "delete_file":
        _remove_from_tree(memory["file_tree"], rel_path)
        memory["file_summaries"].pop(rel_path, None)
        # Re-detect affected categories
        if rel_path.endswith(".lemat"):
            memory["schemas"] = _parse_all_schemas(project_dir)
        if rel_path.endswith(".html"):
            memory["pages"] = _detect_pages(project_dir)
        if rel_path.startswith("api/"):
            memory["api_routes"] = _detect_api_routes(project_dir)

    elif action == "create_folder":
        _ensure_in_tree(memory["file_tree"], rel_path + "/")

    memory["updated_at"] = time.time()
    return memory


def memory_to_context(memory: dict, relevant_paths: list = None) -> str:
    """
    Convert memory to a compact context string for the LLM prompt.
    If relevant_paths is specified, only include summaries for those files.
    This is the key token-saving function.
    """
    parts = []

    # Project info
    desc = memory.get("project", {}).get("description", "")
    stack = memory.get("project", {}).get("tech_stack", [])
    if desc:
        parts.append("## Project: " + desc)
    if stack:
        parts.append("Tech: " + ", ".join(stack))

    # File tree (compact)
    tree = memory.get("file_tree", [])
    if tree:
        tree_str = _render_tree(tree)
        parts.append("## Files\n```\n" + tree_str + "\n```")

    # Schemas
    schemas = memory.get("schemas", {})
    if schemas:
        schema_parts = []
        for name, info in schemas.items():
            models_str = ", ".join(info.get("models", []))
            schema_parts.append(name + ": " + models_str)
        parts.append("## DB Schemas\n" + "\n".join(schema_parts))

    # Pages
    pages = memory.get("pages", [])
    if pages:
        parts.append("## Pages\n" + "\n".join("- " + p for p in pages))

    # API routes
    routes = memory.get("api_routes", [])
    if routes:
        route_lines = []
        for r in routes:
            route_lines.append(r.get("method", "?") + " " + r.get("path", "?") + " (" + r.get("file", "?") + ")")
        parts.append("## API Routes\n" + "\n".join("- " + l for l in route_lines))

    # File summaries (only relevant ones, or all if not specified)
    summaries = memory.get("file_summaries", {})
    if relevant_paths:
        filtered = {k: v for k, v in summaries.items() if k in relevant_paths}
    else:
        filtered = summaries

    if filtered:
        sum_parts = []
        total = 0
        for fpath, info in sorted(filtered.items()):
            entry = "### " + fpath + "\n"
            if info.get("type"):
                entry += "Type: " + info["type"] + "\n"
            if info.get("exports"):
                entry += "Exports: " + ", ".join(info["exports"][:10]) + "\n"
            if info.get("imports"):
                entry += "Imports: " + ", ".join(info["imports"][:10]) + "\n"
            if info.get("functions"):
                entry += "Functions: " + ", ".join(info["functions"][:15]) + "\n"
            if info.get("preview"):
                entry += "```\n" + info["preview"] + "\n```\n"
            if total + len(entry) > 20000:
                break
            sum_parts.append(entry)
            total += len(entry)
        if sum_parts:
            parts.append("## File Details\n" + "\n".join(sum_parts))

    return "\n\n".join(parts)


# ── Internal helpers ─────────────────────────────────────────────────────────

def _scan_file_tree(project_dir: Path, rel: str = "") -> list:
    """Recursively scan and return a flat list of relative paths."""
    entries = []
    target = project_dir / rel if rel else project_dir
    if not target.exists():
        return entries
    try:
        for item in sorted(target.iterdir(), key=lambda x: (x.is_file(), x.name.lower())):
            if item.name in HIDDEN_NAMES or item.name.endswith(".db"):
                continue
            item_rel = (rel + "/" + item.name) if rel else item.name
            if item.is_dir():
                entries.append(item_rel + "/")
                entries.extend(_scan_file_tree(project_dir, item_rel))
            else:
                entries.append(item_rel)
    except PermissionError:
        pass
    return entries


def _render_tree(file_list: list) -> str:
    """Render flat path list as indented tree."""
    lines = []
    for path in file_list:
        depth = path.count("/")
        if path.endswith("/"):
            depth = max(0, depth - 1)
        name = path.rstrip("/").split("/")[-1]
        prefix = "  " * depth
        suffix = "/" if path.endswith("/") else ""
        lines.append(prefix + name + suffix)
    return "\n".join(lines)


def _detect_tech_stack(project_dir: Path) -> list:
    stack = []
    for f in project_dir.iterdir():
        if f.name == "package.json":
            stack.append("node.js")
        elif f.name == "requirements.txt":
            stack.append("python")
        elif f.suffix == ".lemat":
            stack.append("lemat-db")
    # Detect from file extensions
    exts = set()
    for f in project_dir.rglob("*"):
        if f.is_file() and f.name not in HIDDEN_NAMES:
            exts.add(f.suffix)
    if ".html" in exts:
        stack.append("html")
    if ".css" in exts:
        stack.append("css")
    if ".js" in exts and "node.js" not in stack:
        stack.append("javascript")
    if ".py" in exts and "python" not in stack:
        stack.append("python")
    if ".ts" in exts:
        stack.append("typescript")
    return list(set(stack))


def _parse_all_schemas(project_dir: Path) -> dict:
    """Parse all .lemat files and extract model names + fields."""
    schemas = {}
    for f in project_dir.iterdir():
        if f.suffix == ".lemat" and f.is_file():
            try:
                content = f.read_text("utf-8")
                models = re.findall(r"model\s+(\w+)\s*\{", content)
                schemas[f.name] = {
                    "models": models,
                    "raw_length": len(content),
                }
            except Exception:
                pass
    return schemas


def _detect_pages(project_dir: Path) -> list:
    """Find all HTML files (pages)."""
    pages = []
    for f in project_dir.rglob("*.html"):
        if f.name not in HIDDEN_NAMES:
            rel = str(f.relative_to(project_dir))
            pages.append(rel)
    return sorted(pages)


def _detect_api_routes(project_dir: Path) -> list:
    """Parse api/ files to extract route definitions."""
    routes = []
    api_dir = project_dir / "api"
    if not api_dir.is_dir():
        return routes

    # Python routes: @api.get("/path"), @api.post("/path")
    py_pattern = re.compile(r"@api\.(get|post|put|delete|patch)\s*\(\s*['\"]([^'\"]+)['\"]")
    # JS routes: api.get('/path', ...), api.post('/path', ...)
    js_pattern = re.compile(r"api\.(get|post|put|delete|patch)\s*\(\s*['\"]([^'\"]+)['\"]")

    for f in sorted(api_dir.rglob("*")):
        if f.is_file() and f.suffix in (".py", ".js") and not f.name.startswith("_"):
            try:
                content = f.read_text("utf-8", errors="replace")
                rel = str(f.relative_to(project_dir))
                pattern = py_pattern if f.suffix == ".py" else js_pattern
                for match in pattern.finditer(content):
                    routes.append({
                        "method": match.group(1).upper(),
                        "path": match.group(2),
                        "file": rel,
                    })
            except Exception:
                pass

    return routes


def _build_file_summaries(project_dir: Path) -> dict:
    """Build compact summaries for all readable project files."""
    summaries = {}
    total_chars = 0

    for f in sorted(project_dir.rglob("*")):
        if not f.is_file() or f.name in HIDDEN_NAMES or f.name.endswith(".db"):
            continue
        rel = str(f.relative_to(project_dir))
        try:
            content = f.read_text("utf-8", errors="replace")
        except Exception:
            continue

        summary = _summarize_file(rel, content)
        summaries[rel] = summary
        total_chars += len(json.dumps(summary))

        if total_chars > MAX_MEMORY_CHARS:
            break

    return summaries


def _summarize_file(rel_path: str, content: str) -> dict:
    """Create a compact summary of a single file."""
    summary = {
        "size": len(content),
        "lines": content.count("\n") + 1,
        "type": _classify_file(rel_path),
    }

    # Extract structural info based on file type
    ext = os.path.splitext(rel_path)[1].lower()

    if ext in (".py",):
        summary["functions"] = re.findall(r"(?:def|class)\s+(\w+)", content)[:20]
        summary["imports"] = re.findall(r"(?:import|from)\s+([\w.]+)", content)[:15]

    elif ext in (".js", ".ts"):
        # Functions and classes
        fns = re.findall(r"(?:function|class|const|let|var)\s+(\w+)", content)
        summary["functions"] = fns[:20]
        summary["imports"] = re.findall(r"(?:import|require)\s*\(?['\"]([^'\"]+)", content)[:15]
        # Exports
        exports = re.findall(r"export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)", content)
        if exports:
            summary["exports"] = exports[:10]

    elif ext in (".html",):
        # Title
        title_match = re.search(r"<title>([^<]+)</title>", content)
        if title_match:
            summary["title"] = title_match.group(1)
        # Scripts and styles
        scripts = re.findall(r'<script[^>]*src=["\']([^"\']+)', content)
        styles = re.findall(r'<link[^>]*href=["\']([^"\']+\.css)', content)
        if scripts:
            summary["scripts"] = scripts
        if styles:
            summary["styles"] = styles

    elif ext in (".css",):
        # Count selectors
        selectors = re.findall(r"([.#]?[\w-]+(?:\s*[>,+~]\s*[.#]?[\w-]+)*)\s*\{", content)
        summary["selectors_count"] = len(selectors)
        # Custom properties
        vars_found = re.findall(r"(--[\w-]+)\s*:", content)
        if vars_found:
            summary["css_vars"] = list(set(vars_found))[:10]

    elif ext == ".lemat":
        models = re.findall(r"model\s+(\w+)", content)
        summary["models"] = models

    # For small files, include a preview (saves a read_file call later)
    if len(content) <= MAX_SUMMARY_SIZE:
        summary["preview"] = content
    else:
        # First 60 lines as preview
        lines = content.split("\n")[:60]
        summary["preview"] = "\n".join(lines) + "\n... (truncated)"

    return summary


def _classify_file(rel_path: str) -> str:
    """Classify file by its role in the project."""
    ext = os.path.splitext(rel_path)[1].lower()
    name = os.path.basename(rel_path).lower()

    if rel_path.startswith("api/"):
        return "api-route"
    if name == "index.html":
        return "entry-page"
    if ext == ".html":
        return "page"
    if ext == ".css":
        return "stylesheet"
    if ext == ".lemat":
        return "schema"
    if ext == ".js":
        return "script"
    if ext == ".py":
        return "python"
    if ext == ".json":
        return "config"
    if ext == ".md":
        return "docs"
    return "other"


def _ensure_in_tree(tree: list, path: str):
    """Add a path to the tree if not already there."""
    # Ensure parent directories exist
    parts = path.rstrip("/").split("/")
    for i in range(len(parts) - 1):
        dir_path = "/".join(parts[:i+1]) + "/"
        if dir_path not in tree:
            tree.append(dir_path)
    # Add the file itself
    if path not in tree:
        tree.append(path)
    tree.sort()


def _remove_from_tree(tree: list, path: str):
    """Remove a path from the tree."""
    if path in tree:
        tree.remove(path)
    # Also remove as directory
    dir_path = path + "/"
    if dir_path in tree:
        tree.remove(dir_path)
    # Remove children
    prefix = path + "/"
    to_remove = [p for p in tree if p.startswith(prefix)]
    for p in to_remove:
        tree.remove(p)


def _trim_memory(memory: dict):
    """Trim memory when it gets too large. Remove previews from least important files."""
    summaries = memory.get("file_summaries", {})
    # Remove previews starting from largest files
    by_size = sorted(summaries.items(), key=lambda x: x[1].get("size", 0), reverse=True)
    for path, info in by_size:
        if "preview" in info:
            del info["preview"]
        # Check if we're small enough now
        if len(json.dumps(memory, ensure_ascii=False)) < MAX_MEMORY_CHARS:
            break


def is_memory_stale(project_dir: Path, memory: dict, threshold: float = 300.0) -> bool:
    """
    Check if memory is stale by comparing modification times.
    threshold: seconds since last update to consider stale.
    """
    if not memory.get("updated_at"):
        return True

    updated = memory["updated_at"]
    now = time.time()

    # If memory is older than threshold, check for file changes
    if now - updated > threshold:
        # Quick check: compare file count
        current_files = []
        for f in project_dir.rglob("*"):
            if f.is_file() and f.name not in HIDDEN_NAMES:
                current_files.append(str(f.relative_to(project_dir)))
        tree_files = [p for p in memory.get("file_tree", []) if not p.endswith("/")]
        if set(current_files) != set(tree_files):
            return True

    return False


def get_relevant_files(memory: dict, task_description: str) -> list:
    """
    Given a task description, return the most relevant file paths
    from memory. This allows per-step context selection to minimize tokens.
    """
    task_lower = task_description.lower()
    scored = []

    for path, info in memory.get("file_summaries", {}).items():
        score = 0

        # Exact path mention
        if path.lower() in task_lower:
            score += 10

        # File name mention
        name = os.path.basename(path).lower()
        name_no_ext = os.path.splitext(name)[0]
        if name in task_lower or name_no_ext in task_lower:
            score += 8

        # Type relevance
        file_type = info.get("type", "")
        if "api" in task_lower and file_type == "api-route":
            score += 5
        if "style" in task_lower or "css" in task_lower:
            if file_type == "stylesheet":
                score += 5
        if "page" in task_lower or "html" in task_lower:
            if file_type in ("page", "entry-page"):
                score += 5
        if "schema" in task_lower or "database" in task_lower or "model" in task_lower:
            if file_type == "schema":
                score += 5

        # Function/class mention
        for fn in info.get("functions", []):
            if fn.lower() in task_lower:
                score += 3

        # Entry page always somewhat relevant
        if file_type == "entry-page":
            score += 2

        if score > 0:
            scored.append((path, score))

    scored.sort(key=lambda x: -x[1])
    return [p for p, s in scored[:8]]
