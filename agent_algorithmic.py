"""
Le Mat — Algorithmic (Deterministic) Generators
Handles tasks that can be done without LLM calls:
- Scaffold HTML pages from templates
- Generate CRUD API routes from schema
- Create .lemat schema from model descriptions
- Generate boilerplate CSS
These save tokens by producing code deterministically.
"""

import re
from typing import Optional


def can_handle_algorithmically(task_type: str) -> bool:
    """Check if a task type can be handled without LLM."""
    return task_type in (
        "scaffold_page",
        "scaffold_crud_api",
        "scaffold_schema",
        "scaffold_css",
    )


def generate(task_type: str, params: dict) -> list:
    """
    Generate files deterministically.
    Returns a list of {"action": "create_file", "path": ..., "content": ...}
    """
    if task_type == "scaffold_page":
        return _scaffold_page(params)
    elif task_type == "scaffold_crud_api":
        return _scaffold_crud_api(params)
    elif task_type == "scaffold_schema":
        return _scaffold_schema(params)
    elif task_type == "scaffold_css":
        return _scaffold_css(params)
    return []


# ── Page scaffold ────────────────────────────────────────────────────────────

def _scaffold_page(params: dict) -> list:
    """Generate an HTML page with standard Le Mat structure."""
    name = params.get("name", "page")
    title = params.get("title", name.replace("-", " ").replace("_", " ").title())
    has_db = params.get("has_db", False)
    css_file = params.get("css_file", "style.css")
    js_file = params.get("js_file", "")

    lemat_script = '  <!-- SDK lemat auto-injected -->' if has_db else ""
    js_tag = '  <script src="' + js_file + '"></script>' if js_file else ""

    filename = name if name.endswith(".html") else name + ".html"

    html = '''<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <link rel="stylesheet" href="{css_file}">
{lemat_script}
</head>
<body>
  <header>
    <h1>{title}</h1>
  </header>

  <main id="app">
    <!-- Content here -->
  </main>

  <footer>
    <p>&copy; 2024 {title}</p>
  </footer>
{js_tag}
</body>
</html>'''.format(
        title=title,
        css_file=css_file,
        lemat_script=lemat_script,
        js_tag=js_tag,
    )

    return [{"action": "create_file", "path": filename, "content": html}]


# ── CRUD API scaffold ────────────────────────────────────────────────────────

def _scaffold_crud_api(params: dict) -> list:
    """Generate CRUD API routes from schema model info."""
    model_name = params.get("model", "Item")
    fields = params.get("fields", [])
    language = params.get("language", "python")

    if language == "python":
        return _scaffold_crud_python(model_name, fields)
    else:
        return _scaffold_crud_js(model_name, fields)


def _scaffold_crud_python(model_name: str, fields: list) -> list:
    """Generate Python CRUD routes."""
    table = model_name
    lower = model_name.lower()
    route_base = "/" + lower + "s"

    # Find the primary key field
    pk_field = "id"
    insert_fields = []
    for f in fields:
        if f.get("is_pk"):
            pk_field = f["name"]
        elif not f.get("auto"):
            insert_fields.append(f)

    insert_cols = ", ".join(f["name"] for f in insert_fields)
    insert_placeholders = ", ".join("?" for _ in insert_fields)
    insert_values = "[" + ", ".join('data["' + f["name"] + '"]' for f in insert_fields) + "]"

    content = '''# api/{lower}s.py
import _lemat_init as lemat

@api.get("{route_base}")
def list_{lower}s(req):
    rows = lemat.db.execute("SELECT * FROM {table}").fetchall()
    return [dict(r) for r in rows]

@api.get("{route_base}/:{pk_field}")
def get_{lower}(req):
    row = lemat.db.execute(
        "SELECT * FROM {table} WHERE {pk_field} = ?",
        [req["params"]["{pk_field}"]]
    ).fetchone()
    if not row:
        return {{"error": "Not found"}}, 404
    return dict(row)

@api.post("{route_base}")
def create_{lower}(req):
    data = req["body"]
    lemat.db.execute(
        "INSERT INTO {table} ({insert_cols}) VALUES ({insert_placeholders})",
        {insert_values}
    )
    lemat.db.commit()
    return {{"message": "{model_name} created"}}, 201

@api.put("{route_base}/:{pk_field}")
def update_{lower}(req):
    data = req["body"]
    fields = []
    values = []
    for key, val in data.items():
        fields.append(f"{{key}} = ?")
        values.append(val)
    values.append(req["params"]["{pk_field}"])
    lemat.db.execute(
        "UPDATE {table} SET " + ", ".join(fields) + " WHERE {pk_field} = ?",
        values
    )
    lemat.db.commit()
    return {{"message": "{model_name} updated"}}

@api.delete("{route_base}/:{pk_field}")
def delete_{lower}(req):
    lemat.db.execute(
        "DELETE FROM {table} WHERE {pk_field} = ?",
        [req["params"]["{pk_field}"]]
    )
    lemat.db.commit()
    return {{"message": "{model_name} deleted"}}
'''.format(
        lower=lower,
        route_base=route_base,
        table=table,
        pk_field=pk_field,
        insert_cols=insert_cols,
        insert_placeholders=insert_placeholders,
        insert_values=insert_values,
        model_name=model_name,
    )

    return [{"action": "create_file", "path": "api/" + lower + "s.py", "content": content}]


def _scaffold_crud_js(model_name: str, fields: list) -> list:
    """Generate JavaScript CRUD routes."""
    table = model_name
    lower = model_name.lower()
    route_base = "/" + lower + "s"

    content = '''// api/{lower}s.js

api.get('{route_base}', (req) => {{
  const rows = lemat.db.all('{table}');
  return rows;
}});

api.get('{route_base}/:id', (req) => {{
  const row = lemat.db.get('{table}', req.params.id);
  if (!row) return {{ error: 'Not found' }};
  return row;
}});

api.post('{route_base}', (req) => {{
  const data = req.body;
  lemat.db.run('INSERT INTO {table} ({cols}) VALUES ({placeholders})', [{values}]);
  return {{ message: '{model_name} created' }};
}});

api.delete('{route_base}/:id', (req) => {{
  lemat.db.run('DELETE FROM {table} WHERE id = ?', [req.params.id]);
  return {{ message: '{model_name} deleted' }};
}});
'''.format(
        lower=lower,
        route_base=route_base,
        table=table,
        model_name=model_name,
        cols=", ".join(f["name"] for f in fields if not f.get("is_pk")),
        placeholders=", ".join("?" for f in fields if not f.get("is_pk")),
        values=", ".join("data." + f["name"] for f in fields if not f.get("is_pk")),
    )

    return [{"action": "create_file", "path": "api/" + lower + "s.js", "content": content}]


# ── Schema scaffold ──────────────────────────────────────────────────────────

def _scaffold_schema(params: dict) -> list:
    """Generate a .lemat schema file from model descriptions."""
    db_name = params.get("database", "app.db")
    models = params.get("models", [])
    filename = params.get("filename", "schema.lemat")

    lines = ['database "' + db_name + '"', ""]

    for model in models:
        name = model.get("name", "Model")
        fields = model.get("fields", [])
        lines.append("model " + name + " {")

        for field in fields:
            fname = field.get("name", "field")
            ftype = field.get("type", "text")
            decorators = []
            if field.get("is_pk"):
                decorators.append("@id")
            if field.get("required"):
                decorators.append("@required")
            if field.get("unique"):
                decorators.append("@unique")
            if field.get("default") is not None:
                val = field["default"]
                if val == "now":
                    decorators.append("@default(now)")
                else:
                    decorators.append("@default(" + json.dumps(val) if isinstance(val, str) else "@default(" + str(val) + ")")
                    if isinstance(val, str):
                        decorators[-1] += ")"
            if field.get("ref"):
                decorators.append("@ref(" + field["ref"] + ")")

            # Align columns
            deco_str = "  " + " ".join(decorators) if decorators else ""
            line = "  " + fname.ljust(14) + ftype.ljust(12) + deco_str
            lines.append(line.rstrip())

        lines.append("}")
        lines.append("")

    content = "\n".join(lines)
    return [{"action": "create_file", "path": filename, "content": content}]


# ── CSS scaffold ─────────────────────────────────────────────────────────────

def _scaffold_css(params: dict) -> list:
    """Generate a basic responsive CSS file."""
    theme = params.get("theme", "light")
    filename = params.get("filename", "style.css")

    if theme == "dark":
        bg = "#1a1a2e"
        text = "#e0e0e0"
        primary = "#e94560"
        surface = "#16213e"
    else:
        bg = "#fafafa"
        text = "#333333"
        primary = "#4a90d9"
        surface = "#ffffff"

    content = '''/* {filename} — Auto-generated Le Mat stylesheet */

:root {{
  --color-bg: {bg};
  --color-text: {text};
  --color-primary: {primary};
  --color-surface: {surface};
  --radius: 8px;
  --shadow: 0 2px 8px rgba(0,0,0,0.08);
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}}

*, *::before, *::after {{
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}}

body {{
  font-family: var(--font-sans);
  background: var(--color-bg);
  color: var(--color-text);
  line-height: 1.6;
  min-height: 100vh;
}}

header {{
  background: var(--color-surface);
  padding: 1rem 2rem;
  box-shadow: var(--shadow);
}}

header h1 {{
  font-size: 1.5rem;
  font-weight: 600;
}}

main {{
  max-width: 1200px;
  margin: 2rem auto;
  padding: 0 1rem;
}}

footer {{
  text-align: center;
  padding: 2rem;
  color: #888;
  font-size: 0.875rem;
}}

a {{
  color: var(--color-primary);
  text-decoration: none;
}}

a:hover {{
  text-decoration: underline;
}}

button, .btn {{
  background: var(--color-primary);
  color: white;
  border: none;
  padding: 0.5rem 1.25rem;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 0.9rem;
  transition: opacity 0.2s;
}}

button:hover, .btn:hover {{
  opacity: 0.85;
}}

input, textarea, select {{
  border: 1px solid #ddd;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius);
  font-size: 0.9rem;
  width: 100%;
  background: var(--color-surface);
  color: var(--color-text);
}}

input:focus, textarea:focus, select:focus {{
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px rgba(74, 144, 217, 0.15);
}}

.card {{
  background: var(--color-surface);
  border-radius: var(--radius);
  padding: 1.5rem;
  box-shadow: var(--shadow);
  margin-bottom: 1rem;
}}

.grid {{
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}}

@media (max-width: 768px) {{
  main {{
    padding: 0 0.75rem;
    margin: 1rem auto;
  }}
  .grid {{
    grid-template-columns: 1fr;
  }}
}}
'''.format(
        filename=filename,
        bg=bg,
        text=text,
        primary=primary,
        surface=surface,
    )

    return [{"action": "create_file", "path": filename, "content": content}]


# ── Schema parser helper ─────────────────────────────────────────────────────

def parse_lemat_schema(content: str) -> list:
    """
    Parse a .lemat schema and return structured model info.
    Useful for generating CRUD routes from schema.
    """
    models = []
    current_model = None

    for line in content.split("\n"):
        line = line.strip()
        if not line or line.startswith("//") or line.startswith("#"):
            continue

        model_match = re.match(r"model\s+(\w+)\s*\{", line)
        if model_match:
            current_model = {"name": model_match.group(1), "fields": []}
            continue

        if line == "}" and current_model:
            models.append(current_model)
            current_model = None
            continue

        if current_model and line:
            # Parse field: name type @decorators...
            parts = line.split()
            if len(parts) >= 2:
                field = {
                    "name": parts[0],
                    "type": parts[1],
                    "is_pk": "@id" in line,
                    "required": "@required" in line,
                    "unique": "@unique" in line,
                    "auto": "@id" in line and parts[1] in ("integer", "int"),
                }
                # Default value
                default_match = re.search(r"@default\(([^)]+)\)", line)
                if default_match:
                    field["default"] = default_match.group(1)
                # Ref
                ref_match = re.search(r"@ref\(([^)]+)\)", line)
                if ref_match:
                    field["ref"] = ref_match.group(1)

                current_model["fields"].append(field)

    return models


# Need json for _scaffold_schema default values
import json
