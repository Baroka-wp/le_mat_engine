# Le Mat — Agent Skill Guide

## What is Le Mat
Le Mat is a web-based code editor and deployment platform. Users create projects,
define database schemas, write frontend code, server-side API routes, and deploy —
all from the browser. You are an AI assistant helping the user build their project.

## Available Tools

### create_file(path, content)
Creates or overwrites a file at the given path relative to the project root.
- `path`: relative path like `"index.html"` or `"api/users.py"`
- `content`: the full file content as a string
- Parent directories are created automatically
- **Returns a diff** showing what changed

### read_file(path)
Reads a file and returns its content. **Always use this before edit_file** to get exact content.

### edit_file(path, old_text, new_text)
Replace a specific section of a file. Preferred over create_file for modifications.
- `old_text`: exact text to find (must match exactly — copy from read_file output)
- `new_text`: replacement text
- Only the first occurrence is replaced
- **Returns a diff** showing what changed
- If old_text isn't found, you get a file preview to help find the right text

### delete_file(path)
Deletes a file or folder (and its contents).

### create_folder(path)
Creates a directory (and parent directories if needed).

### list_files()
Returns the complete file tree of the project.

### search_in_files(pattern, file_glob?)
Search for text across all project files using regex.
- `pattern`: text or regex to search for (case-insensitive)
- `file_glob`: optional filter like `"*.py"`, `"*.js"`, `"api/*.py"`
- Returns matching file paths, line numbers, and matching text

---

## Le Mat Schema System (.lemat files)

Projects define their database in a `.lemat` file using a simple DSL:

```
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
```

### Field Types
- `integer` / `int` → SQLite INTEGER
- `text` / `string` / `str` / `varchar` → SQLite TEXT
- `real` / `float` / `double` / `number` → SQLite REAL
- `boolean` / `bool` → SQLite INTEGER (0/1)
- `datetime` / `date` / `timestamp` → SQLite TEXT (ISO format)
- `json` → SQLite TEXT (stored as JSON string)
- `blob` → SQLite BLOB

### Field Decorators
- `@id` — Primary key (auto-increment for integer)
- `@required` — NOT NULL constraint
- `@unique` — UNIQUE constraint
- `@default(value)` — Default value. Use `@default(now)` for CURRENT_TIMESTAMP
- `@ref(Model.field)` — Foreign key reference

---

## Le Mat JavaScript SDK (auto-generated for frontend)

When a `.lemat` schema exists, Le Mat auto-generates a JS SDK.
The SDK is **auto-injected** into all HTML pages served by Le Mat — you do NOT need to add any `<script>` tag for it. The global variable is `lemat` (lowercase).

### CRUD Operations
**IMPORTANT**: `all()` returns `{ table, total, rows: [...] }`, NOT a plain array. Always use `.rows`:
```javascript
// Get all rows (with optional filters)
const result = await LeMat.User.all();
const users = result.rows;     // ← array of objects
const admins = (await LeMat.User.all({ role: "admin" })).rows;

// Get one row by primary key
const user = await LeMat.User.find(1);

// Create a new row
const newUser = await LeMat.User.create({ name: "Alice", email: "alice@example.com" });

// Update a row
const updated = await LeMat.User.update(1, { name: "Alice Updated" });

// Delete a row
await LeMat.User.delete(1);
```

### Relations
```javascript
// Get children (articles by a user)
const articles = await LeMat.User.children(1, "Article");

// Get parent (user of an article)
const author = await LeMat.Article.parent(5, "User");
```

### Email
```javascript
await LeMat.Mail.send({
  to: "user@example.com",
  subject: "Welcome!",
  html: "<h1>Hello</h1>"
});
```

---

## Le Mat Python SDK (auto-generated for server-side)

For Python files (API routes, scripts), Le Mat auto-generates `_lemat_init.py`:

```python
import _lemat_init as lemat

# Query all rows
users = lemat.db.execute("SELECT * FROM User").fetchall()

# Insert
lemat.db.execute("INSERT INTO User (name, email) VALUES (?, ?)", ["Alice", "alice@example.com"])
lemat.db.commit()

# Available: lemat.db (SQLite connection), lemat.mail (email sending)
```

---

## API Routes (api/ folder)

Server-side API routes go in the `api/` directory.

### Python API Route Example
```python
# api/users.py
@api.get("/users")
def list_users(req):
    users = lemat.db.execute("SELECT * FROM User").fetchall()
    return [dict(u) for u in users]

@api.post("/users")
def create_user(req):
    data = req["body"]
    lemat.db.execute(
        "INSERT INTO User (name, email) VALUES (?, ?)",
        [data["name"], data["email"]]
    )
    lemat.db.commit()
    return {"message": "User created"}, 201

@api.get("/users/:id")
def get_user(req):
    user = lemat.db.execute(
        "SELECT * FROM User WHERE id = ?", [req["params"]["id"]]
    ).fetchone()
    if not user:
        return {"error": "Not found"}, 404
    return dict(user)
```

### JavaScript API Route Example
```javascript
// api/users.js
api.get('/users', (req) => {
  const users = lemat.db.all('User');
  return users;
});

api.post('/users', (req) => {
  const { name, email } = req.body;
  lemat.db.run('INSERT INTO User (name, email) VALUES (?, ?)', [name, email]);
  return { message: 'User created' };
});
```

### API Authentication
All API routes require an API key via `X-API-Key` header. Keys are managed in the Le Mat sidebar.

---

## HTML Page Template
When creating HTML pages, always use this structure:
```html
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page Title</title>
  <link rel="stylesheet" href="style.css">
  <!-- SDK lemat is auto-injected, no script tag needed -->
</head>
<body>
  <!-- content here -->
  <script src="app.js"></script>
</body>
</html>
```

## Project Structure Best Practices

```
project-name/
├── index.html          # Entry point (served at project URL)
├── schema.lemat        # Database schema definition
├── style.css           # Main stylesheet
├── app.js              # Main frontend JavaScript
├── api/                # Server-side API routes
│   ├── users.py        # Python API handler
│   └── products.js     # JavaScript API handler
├── components/         # Reusable HTML/JS components
└── assets/             # Images, fonts, etc.
```

## Tips
- `index.html` is automatically served as the project's home page
- Static files are served directly from the project root
- Database is created automatically when a `.lemat` schema is saved
- Changes to `.lemat` files trigger automatic database migration
- Use responsive design — projects may be viewed on mobile devices
- Always include error handling in API routes
- Use `search_in_files` to find code before modifying it
- Prefer `edit_file` over `create_file` for existing files
