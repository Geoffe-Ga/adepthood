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
pushd frontend >/dev/null || exit 1
npx expo install
popd >/dev/null || exit 1

echo "✅ Installing pre-commit hooks..."
pre-commit install --install-hooks
pre-commit install --hook-type commit-msg

echo "🎉 Setup complete! Your environment is ready."
echo ""
echo "Next steps:"
echo "  - Run 'source .venv/bin/activate' to enter the virtual environment."
echo "  - Run 'pytest' to test, or 'pre-commit run --all-files' to lint everything now."
