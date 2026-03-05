"""
Le Mat — Model Parser
Parses .lemat schema files into structured definitions.

Syntax example:

  database "myapp.db"

  model User {
    id        integer   @id
    name      text      @required
    email     text      @unique
    role      text      @default("user")
    createdAt datetime  @default(now)
  }

  model Article {
    id        integer   @id
    title     text      @required
    content   text
    authorId  integer   @ref(User.id)
    createdAt datetime  @default(now)
  }
"""

import re
from dataclasses import dataclass, field as dc_field
from typing import Optional, List

# Map lemat types → SQLite types
SQLITE_TYPES: dict[str, str] = {
    "integer":   "INTEGER",
    "int":       "INTEGER",
    "text":      "TEXT",
    "string":    "TEXT",
    "str":       "TEXT",
    "varchar":   "TEXT",
    "real":      "REAL",
    "float":     "REAL",
    "double":    "REAL",
    "number":    "REAL",
    "boolean":   "INTEGER",
    "bool":      "INTEGER",
    "datetime":  "TEXT",
    "date":      "TEXT",
    "timestamp": "TEXT",
    "blob":      "BLOB",
    "json":      "TEXT",
}


@dataclass
class FieldDef:
    name: str
    sql_type: str
    primary_key: bool = False
    autoincrement: bool = False
    unique: bool = False
    not_null: bool = False
    default: Optional[str] = None   # raw SQL default value
    ref: Optional[str] = None       # "OtherModel.field"
    lemat_type: str = "text"        # original type for SDK hints


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
            "name": self.name,
            "pk": self.pk_name(),
            "fields": [
                {
                    "name": f.name,
                    "type": f.lemat_type,
                    "sqlType": f.sql_type,
                    "primaryKey": f.primary_key,
                    "unique": f.unique,
                    "required": f.not_null,
                    "default": f.default,
                    "ref": f.ref,
                }
                for f in self.fields
            ],
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
            "models": [m.to_dict() for m in self.models],
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
            _parse_field(line, model)
        schema.models.append(model)

    return schema


def _parse_field(line: str, model: ModelDef):
    parts = line.split(None, 2)
    if len(parts) < 2:
        return

    name, raw_type = parts[0], parts[1].lower()
    decorators = parts[2] if len(parts) > 2 else ""
    sql_type = SQLITE_TYPES.get(raw_type, "TEXT")

    f = FieldDef(name=name, sql_type=sql_type, lemat_type=raw_type)

    if "@id" in decorators or "@primarykey" in decorators.lower():
        f.primary_key = True
        f.autoincrement = sql_type == "INTEGER"

    if "@unique" in decorators:
        f.unique = True

    if "@required" in decorators or "@notnull" in decorators.lower():
        f.not_null = True

    # @default(value) or @default("string") or @default(now)
    dm = re.search(r"@default\(([^)]+)\)", decorators)
    if dm:
        val = dm.group(1).strip()
        if val == "now":
            f.default = "CURRENT_TIMESTAMP"
        else:
            # strip surrounding quotes for storage, keep for SQL
            inner = val.strip("\"'")
            f.default = f"'{inner}'"

    # @ref(Model.field)
    rm = re.search(r"@ref\(([^)]+)\)", decorators)
    if rm:
        f.ref = rm.group(1).strip()

    model.fields.append(f)


# ── SQL generation ────────────────────────────────────────────────────────────

def to_sql(schema: SchemaDef) -> list[str]:
    """Return CREATE TABLE IF NOT EXISTS statements for all models."""
    stmts = []
    for model in schema.models:
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
            if f.default:
                col += f" DEFAULT {f.default}"
            cols.append(col)

            if f.ref:
                parts = f.ref.split(".")
                if len(parts) == 2:
                    fks.append(
                        f'FOREIGN KEY ("{f.name}") REFERENCES "{parts[0]}"("{parts[1]}")'
                    )

        body = ",\n  ".join(cols + fks)
        stmts.append(f'CREATE TABLE IF NOT EXISTS "{model.name}" (\n  {body}\n);')
    return stmts
