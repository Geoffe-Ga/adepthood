#!/bin/bash
set -euo pipefail

# Only run in remote (web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/user/adepthood}"
cd "$PROJECT_DIR"

echo "Installing frontend dependencies..."
cd "$PROJECT_DIR/frontend"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "Installing backend dependencies..."
cd "$PROJECT_DIR"
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
pip install -q -r backend/requirements.txt -r backend/requirements-dev.txt

echo "Installing pre-commit hooks..."
pip install -q pre-commit
pre-commit install
pre-commit install --hook-type commit-msg
pre-commit install --hook-type pre-push

echo "Session setup complete."
