#!/bin/bash
# ── Le Mat — Script de développement local ──────────────────────────────────
# Lance l'app directement avec Python (sans Docker).
# Les changements static (JS/CSS/HTML) sont visibles après F5.
# Les changements Python (main.py) déclenchent un rechargement automatique.
# ─────────────────────────────────────────────────────────────────────────────

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$DIR/.venv"
DATA_DIR="$DIR/data/projects"

echo "🎯 Le Mat — Dev local"
echo "📂 Dossier : $DIR"

# ── Créer le venv si nécessaire ───────────────────────────────────────────────
if [ ! -d "$VENV" ]; then
  echo "🔧 Création du venv Python..."
  python3 -m venv "$VENV"
fi

# ── Installer / mettre à jour les dépendances ─────────────────────────────────
echo "📦 Vérification des dépendances..."
"$VENV/bin/pip" install -q -r "$DIR/requirements.txt"

# ── Créer le dossier de données si nécessaire ─────────────────────────────────
mkdir -p "$DATA_DIR"

# ── Libérer le port 8000 si occupé (Docker ou autre processus) ───────────────
PORT=8000
PIDS=$(lsof -ti tcp:$PORT 2>/dev/null) || true
if [ -n "$PIDS" ]; then
  echo "⚠️  Port $PORT occupé — arrêt des processus en cours..."
  echo "$PIDS" | xargs kill -9 2>/dev/null || true
  sleep 1
  echo "✓  Port $PORT libéré"
fi

# Arrêter aussi les conteneurs Docker sur ce port
docker ps --format '{{.ID}} {{.Ports}}' 2>/dev/null | grep ":${PORT}->" | awk '{print $1}' | xargs -r docker stop 2>/dev/null || true

# ── Lancer uvicorn avec --reload ──────────────────────────────────────────────
echo ""
echo "✅ App lancée sur http://localhost:8000"
echo "   → Changements JS/CSS/HTML : visible après F5"
echo "   → Changements main.py    : rechargement auto"
echo "   → Ctrl+C pour arrêter"
echo ""

BASE_DIR="$DATA_DIR" \
STATIC_DIR="$DIR/static" \
"$VENV/bin/uvicorn" main:app \
  --reload \
  --host 0.0.0.0 \
  --port 8000 \
  --app-dir "$DIR"
