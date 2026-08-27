#!/bin/bash

echo "🔧 Creating virtual environment..."
python3 -m venv .venv

echo "📦 Activating virtual environment..."
source .venv/bin/activate

echo "📚 Installing dependencies..."
pip install --upgrade pip
pip install -r backend/requirements.txt
pip install -r backend/requirements-dev.txt

echo "⬇️ Installing pre-commit..."
# Some environments may skip dev dependencies; ensure pre-commit is present.
pip install pre-commit

echo "📦 Installing Node dependencies..."
if [ -d frontend ]; then
  pushd frontend >/dev/null || exit 1
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
  popd >/dev/null || exit 1
fi

echo "📦 Ensuring Expo dependencies are aligned..."
# This script has no `set -e`, so the guard's exit code is branched on explicitly
# rather than left to be ignored. It is not redundant with the install above: that
# block is skipped when there is no frontend/ directory, and the Expo CLI is then
# called anyway. Calling ./node_modules/.bin/expo rather than `npx expo` is what
# makes the failure a failure -- npx would download an `expo` off the registry and
# run it against a tree that has no dependencies.
if ! scripts/frontend/require-node-modules.sh; then
  exit 1
fi
pushd frontend >/dev/null || exit 1
./node_modules/.bin/expo install
popd >/dev/null || exit 1

echo "✅ Installing pre-commit hooks..."
# Which hook types get written is declared by ``default_install_hook_types`` in
# .pre-commit-config.yaml, so this installs pre-commit, commit-msg AND pre-push
# without restating the list here. Keeping the set in one place is the point: it
# was split across this script and the config that a whole stage went missing.
pre-commit install --install-hooks

echo "🎉 Setup complete! Your environment is ready."
echo ""
echo "Next steps:"
echo "  - Run 'source .venv/bin/activate' to enter the virtual environment."
echo "  - Run 'pytest' to test, or 'pre-commit run --all-files' to lint everything now."
