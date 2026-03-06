"""
LEMAT — Model Parser  (v2 — Phase 1: Data Layer)
=================================================
Parses .lemat schema files into structured definitions.

Syntax reference:

  database "myapp.db"

  model User {
    id         Int        @id @autoincrement
    name       Text       @required
    email      Email      @unique
    bio        Textarea
    role       Select(admin, member, guest)  @default(member)
    avatar     File
    active     Bool       @default(true)
    score      Number
    birthdate  Date
    createdAt  DateTime   @default(now)
  }

  model Post {
    id        Int       @id @autoincrement
    title     Text      @required
    content   Textarea
    author    Relation(User)
    status    Select(draft, published, archived)  @default(draft)
    cover     File
    createdAt DateTime  @default(now)
  }

Supported field types:
  Int / Integer           → INTEGER (PK-compatible)
  Text / String / Varchar → TEXT
  Textarea                → TEXT  (multi-line hint)
  Number / Float / Real   → REAL
  Bool / Boolean          → INTEGER (0/1)
  Date                    → TEXT  (ISO date string)
  DateTime / Timestamp    → TEXT  (ISO datetime string)
  Email                   → TEXT  (email hint)
  URL                     → TEXT  (url hint)
  File                    → TEXT  (filename / URL stored)
  Color                   → TEXT  (hex color hint)
  Json                    → TEXT  (JSON blob)
  Select(opt1, opt2, ...) → TEXT  with CHECK(value IN (...))
  Relation(ModelName)     → INTEGER  FK → ModelName.id (auto-detected)
"""

import re
from dataclasses import dataclass, field as dc_field
from typing import Optional, List


# ── Type mappings ─────────────────────────────────────────────────────────────

# lemat type (lower) → SQLite affinity
SQLITE_TYPES: dict[str, str] = {
    "int":       "INTEGER",
    "integer":   "INTEGER",
    "text":      "TEXT",
    "string":    "TEXT",
    "str":       "TEXT",
    "varchar":   "TEXT",
    "textarea":  "TEXT",
    "email":     "TEXT",
    "url":       "TEXT",
    "file":      "TEXT",
    "color":     "TEXT",
    "real":      "REAL",
    "float":     "REAL",
    "double":    "REAL",
    "number":    "REAL",
    "boolean":   "INTEGER",
    "bool":      "INTEGER",
    "datetime":  "TEXT",
    "timestamp": "TEXT",
    "date":      "TEXT",
    "blob":      "BLOB",
    "json":      "TEXT",
}

# UI display categories for the visual schema editor
TYPE_KIND: dict[str, str] = {
    "int":       "number",
    "integer":   "number",
    "real":      "number",
    "float":     "number",
    "double":    "number",
    "number":    "number",
    "boolean":   "bool",
    "bool":      "bool",
    "datetime":  "datetime",
    "timestamp": "datetime",
    "date":      "date",
    "email":     "email",
    "url":       "url",
    "textarea":  "textarea",
    "file":      "file",
    "color":     "color",
    "json":      "json",
    # default → "text"
}

# Human-readable labels for the schema editor
TYPE_LABEL: dict[str, str] = {
    "int":       "Int",
    "integer":   "Int",
    "text":      "Text",
    "string":    "Text",
    "str":       "Text",
    "varchar":   "Text",
    "textarea":  "Textarea",
    "email":     "Email",
    "url":       "URL",
    "file":      "File",
    "color":     "Color",
    "real":      "Number",
    "float":     "Number",
    "double":    "Number",
    "number":    "Number",
    "boolean":   "Bool",
    "bool":      "Bool",
    "datetime":  "DateTime",
    "timestamp": "DateTime",
    "date":      "Date",
    "blob":      "Blob",
    "json":      "JSON",
    "select":    "Select",
    "relation":  "Relation",
}

# All canonical simple types for the visual editor picker
SIMPLE_TYPES = ["Text", "Textarea", "Int", "Number", "Bool",
                "Date", "DateTime", "Email", "URL", "File", "Color", "JSON"]


# ── Dataclasses ───────────────────────────────────────────────────────────────

@dataclass
class FieldDef:
    name: str
    sql_type: str                        # SQLite affinity
    lemat_type: str = "text"             # original keyword (lower)
    field_kind: str = "simple"           # "simple" | "select" | "relation" | "file" | "bool"
    primary_key: bool = False
    autoincrement: bool = False
    unique: bool = False
    not_null: bool = False
    default: Optional[str] = None        # raw SQL default value
    # Select
    select_options: List[str] = dc_field(default_factory=list)
    # Relation
    relation_model: Optional[str] = None  # target model name
    relation_field: str = "id"            # target field (always id for now)

    def to_dict(self) -> dict:
        d = {
            "name":        self.name,
            "type":        self.lemat_type,
            "kind":        self.field_kind,
            "sqlType":     self.sql_type,
            "primaryKey":  self.primary_key,
            "unique":      self.unique,
            "required":    self.not_null,
            "default":     self.default,
            "label":       TYPE_LABEL.get(self.lemat_type, self.lemat_type.capitalize()),
        }
        if self.select_options:
            d["options"] = self.select_options
        if self.relation_model:
            d["relationModel"] = self.relation_model
            d["relationField"] = self.relation_field
        return d


@dataclass
class ModelDef:
    name: str
    fields: List[FieldDef] = dc_field(default_factory=list)

    def pk_field(self) -> Optional[FieldDef]:
        for f in self.fields:
            if f.primary_key:
                return f
        return None

    def pk_name(self) -> str:
        pk = self.pk_field()
        return pk.name if pk else "id"

    def to_dict(self) -> dict:
        return {
            "name":   self.name,
            "pk":     self.pk_name(),
            "fields": [f.to_dict() for f in self.fields],
        }


@dataclass
class SchemaDef:
    database: str = "database.db"
    models: List[ModelDef] = dc_field(default_factory=list)

    def get_model(self, name: str) -> Optional[ModelDef]:
        return next((m for m in self.models if m.name.lower() == name.lower()), None)

    def to_dict(self) -> dict:
        return {
            "database": self.database,
            "models":   [m.to_dict() for m in self.models],
        }


# ── Parser ────────────────────────────────────────────────────────────────────

def parse(source: str) -> SchemaDef:
    schema = SchemaDef()

    # database "file.db"
    m = re.search(r'^\s*database\s+"([^"]+)"', source, re.MULTILINE)
    if m:
        schema.database = m.group(1)

    # model ModelName { ... }
    for mm in re.finditer(r"model\s+(\w+)\s*\{([^}]*)\}", source, re.DOTALL):
        model = ModelDef(name=mm.group(1))
        for line in mm.group(2).splitlines():
            line = line.strip()
            if not line or line.startswith("//") or line.startswith("#"):
                continue
            fd = _parse_field(line)
            if fd:
                model.fields.append(fd)
        schema.models.append(model)

    return schema


def _parse_field(line: str) -> Optional[FieldDef]:
    """Parse a single field line into a FieldDef."""
    # Field name is always the first token
    m = re.match(r'^(\w+)\s+', line)
    if not m:
        return None
    name = m.group(1)
    rest = line[m.end():]

    # ── Select(opt1, opt2, ...) ───────────────────────────────────────────────
    sm = re.match(r'[Ss]elect\s*\(([^)]+)\)', rest)
    if sm:
        options = [o.strip().strip("'\"") for o in sm.group(1).split(",") if o.strip()]
        decorators = rest[sm.end():]
        f = FieldDef(
            name=name,
            sql_type="TEXT",
            lemat_type="select",
            field_kind="select",
            select_options=options,
        )
        _apply_decorators(f, decorators)
        return f

    # ── Relation(ModelName) ───────────────────────────────────────────────────
    rm = re.match(r'[Rr]elation\s*\((\w+)(?:\.(\w+))?\)', rest)
    if rm:
        target_model = rm.group(1)
        target_field = rm.group(2) or "id"
        decorators = rest[rm.end():]
        f = FieldDef(
            name=name,
            sql_type="INTEGER",
            lemat_type="relation",
            field_kind="relation",
            relation_model=target_model,
            relation_field=target_field,
        )
        _apply_decorators(f, decorators)
        return f

    # ── Simple types ──────────────────────────────────────────────────────────
    tm = re.match(r'(\w+)', rest)
    if not tm:
        return None

    raw_type = tm.group(1).lower()
    decorators = rest[tm.end():]
    sql_type = SQLITE_TYPES.get(raw_type, "TEXT")
    kind = TYPE_KIND.get(raw_type, "simple")
    if raw_type in ("file",):
        kind = "file"
    if raw_type in ("bool", "boolean"):
        kind = "bool"

    # Legacy @ref(Model.field) → map to relation
    ref_m = re.search(r"@ref\(([^)]+)\)", decorators)
    if ref_m:
        ref_parts = ref_m.group(1).strip().split(".")
        f = FieldDef(
            name=name,
            sql_type="INTEGER",
            lemat_type="relation",
            field_kind="relation",
            relation_model=ref_parts[0] if ref_parts else "",
            relation_field=ref_parts[1] if len(ref_parts) > 1 else "id",
        )
        _apply_decorators(f, decorators)
        return f

    f = FieldDef(name=name, sql_type=sql_type, lemat_type=raw_type, field_kind=kind)
    _apply_decorators(f, decorators)
    return f


def _apply_decorators(f: FieldDef, decorators: str):
    """Apply @decorator annotations to a FieldDef (mutates in place)."""
    dec = decorators.lower()

    if "@id" in dec or "@primarykey" in dec:
        f.primary_key = True
        f.autoincrement = f.sql_type == "INTEGER"

    if "@autoincrement" in dec and not f.primary_key:
        f.autoincrement = True

    if "@unique" in dec:
        f.unique = True

    if "@required" in dec or "@notnull" in dec:
        f.not_null = True

    # @default(value)
    dm = re.search(r"@default\(([^)]+)\)", decorators, re.IGNORECASE)
    if dm:
        val = dm.group(1).strip()
        if val.lower() == "now":
            f.default = "CURRENT_TIMESTAMP"
        elif val.lower() in ("true", "1"):
            f.default = "1"
        elif val.lower() in ("false", "0"):
            f.default = "0"
        else:
            inner = val.strip("\"'")
            f.default = f"'{inner}'"


# ── SQL generation ─────────────────────────────────────────────────────────────

def to_sql(schema: SchemaDef) -> list[str]:
    """Return CREATE TABLE IF NOT EXISTS statements for all models."""
    stmts = []
    for model in schema.models:
        stmts.append(_model_to_sql(model))
    return stmts


def _model_to_sql(model: ModelDef) -> str:
    cols, fks = [], []

    for f in model.fields:
        col = f'"{f.name}" {f.sql_type}'

        if f.primary_key:
            col += " PRIMARY KEY"
            if f.autoincrement:
                col += " AUTOINCREMENT"

        if f.unique:
            col += " UNIQUE"

        if f.not_null and not f.primary_key:
            col += " NOT NULL"

        if f.default is not None:
            col += f" DEFAULT {f.default}"

        # Select → CHECK constraint
        if f.field_kind == "select" and f.select_options:
            opts = ", ".join(f"'{o}'" for o in f.select_options)
            col += f" CHECK(\"{f.name}\" IN ({opts}))"

        cols.append(col)

        # Relation → FOREIGN KEY
        if f.field_kind == "relation" and f.relation_model:
            fks.append(
                f'FOREIGN KEY ("{f.name}") '
                f'REFERENCES "{f.relation_model}"("{f.relation_field}")'
            )

    body = ",\n  ".join(cols + fks)
    return f'CREATE TABLE IF NOT EXISTS "{model.name}" (\n  {body}\n);'


# ── Migration helpers ─────────────────────────────────────────────────────────

def diff_schema(old_sql_tables: dict[str, list[str]],
                new_schema: "SchemaDef") -> list[str]:
    """
    Compare existing DB tables (name → [col_names]) with the new schema.
    Returns a list of ALTER TABLE ADD COLUMN statements for new fields.
    Does NOT generate DROP or RENAME statements (safe-by-default migration).
    """
    stmts = []
    for model in new_schema.models:
        existing_cols = set(c.lower() for c in old_sql_tables.get(model.name, []))
        if not existing_cols:
            continue  # new table — handled by CREATE TABLE IF NOT EXISTS
        for f in model.fields:
            if f.name.lower() not in existing_cols:
                col_def = f'"{f.name}" {f.sql_type}'
                if f.default is not None:
                    col_def += f" DEFAULT {f.default}"
                stmts.append(
                    f'ALTER TABLE "{model.name}" ADD COLUMN {col_def};'
                )
    return stmts


# ── Schema serialisation (for .lemat code generation) ─────────────────────────

def to_lemat(schema: SchemaDef) -> str:
    """Serialise a SchemaDef back to .lemat source code."""
    lines = [f'database "{schema.database}"', ""]
    for model in schema.models:
        lines.append(f"model {model.name} {{")
        for f in model.fields:
            lines.append("  " + _field_to_lemat(f))
        lines.append("}")
        lines.append("")
    return "\n".join(lines)


def _field_to_lemat(f: FieldDef) -> str:
    if f.field_kind == "select":
        opts = ", ".join(f.select_options)
        type_str = f"Select({opts})"
    elif f.field_kind == "relation":
        type_str = f"Relation({f.relation_model})"
    else:
        type_str = TYPE_LABEL.get(f.lemat_type, f.lemat_type.capitalize())

    decs = []
    if f.primary_key:
        decs.append("@id")
    if f.autoincrement and not f.primary_key:
        decs.append("@autoincrement")
    if f.unique:
        decs.append("@unique")
    if f.not_null:
        decs.append("@required")
    if f.default is not None:
        raw = f.default.strip("'")
        if raw == "CURRENT_TIMESTAMP":
            raw = "now"
        decs.append(f"@default({raw})")

    dec_str = "  " + "  ".join(decs) if decs else ""
    # Align columns nicely
    return f"{f.name:<18}{type_str:<30}{dec_str}".rstrip()
