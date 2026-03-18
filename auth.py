"""
auth.py — Système d'authentification Le Mat
JWT stateless + SQLite users DB + bcrypt passwords
"""
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import bcrypt

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from pydantic import BaseModel

# ── Config ────────────────────────────────────────────────────────────────────

SECRET_KEY = os.environ.get("LEMAT_SECRET_KEY", "lemat-dev-secret-change-in-production")
ALGORITHM  = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 72

# ── Password hashing ──────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))

# ── JWT ───────────────────────────────────────────────────────────────────────

def create_access_token(user_id: int, email: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    return jwt.encode(
        {"sub": str(user_id), "email": email, "exp": expire},
        SECRET_KEY, algorithm=ALGORITHM
    )

def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token invalide ou expiré")

# ── DB ────────────────────────────────────────────────────────────────────────

_AUTH_DB: Optional[Path] = None

def get_auth_db_path() -> Path:
    return _AUTH_DB

def init_auth_db(base_dir: Path):
    """Initialise la base users. Crée le compte admin si absent."""
    global _AUTH_DB
    data_dir = base_dir.parent
    data_dir.mkdir(parents=True, exist_ok=True)
    _AUTH_DB = data_dir / "auth.db"

    con = sqlite3.connect(_AUTH_DB)
    con.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            email      TEXT    UNIQUE NOT NULL,
            password   TEXT    NOT NULL,
            created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    """)
    con.commit()

    # Compte admin par défaut
    row = con.execute("SELECT id FROM users WHERE email = ?", ("birotori@gmail.com",)).fetchone()
    if not row:
        con.execute(
            "INSERT INTO users (email, password) VALUES (?, ?)",
            ("birotori@gmail.com", hash_password("admin"))
        )
        con.commit()

    con.close()

def _conn():
    con = sqlite3.connect(_AUTH_DB)
    con.row_factory = sqlite3.Row
    return con

def get_user_by_email(email: str) -> Optional[dict]:
    with _conn() as con:
        row = con.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        return dict(row) if row else None

def get_user_by_id(user_id: int) -> Optional[dict]:
    with _conn() as con:
        row = con.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None

def create_user(email: str, password: str) -> dict:
    with _conn() as con:
        try:
            cur = con.execute(
                "INSERT INTO users (email, password) VALUES (?, ?)",
                (email, hash_password(password))
            )
            con.commit()
            return {"id": cur.lastrowid, "email": email}
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=400, detail="Cet email est déjà utilisé")

# ── Pydantic models ───────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: str
    password: str

class LoginRequest(BaseModel):
    email: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    email: str
    user_id: int

# ── FastAPI dependency ────────────────────────────────────────────────────────

_bearer = HTTPBearer()

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(_bearer)) -> dict:
    payload = decode_token(credentials.credentials)
    user_id = int(payload["sub"])
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="Utilisateur introuvable")
    return user
