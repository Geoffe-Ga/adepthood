#!/bin/bash
set -euo pipefail

# Only run in remote (web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/user/adepthood}"

echo "Installing frontend dependencies..."
cd "$PROJECT_DIR/frontend"
npm install

echo "Installing backend dependencies..."
cd "$PROJECT_DIR/backend"
pip install -r requirements.txt -r requirements-dev.txt

echo "Installing pre-commit hooks..."
cd "$PROJECT_DIR"
pre-commit install

echo "Session setup complete."
