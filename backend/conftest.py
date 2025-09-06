import sys  # keep if you're manipulating sys.path
from pathlib import Path

# Absolute path to the repo root (directory that contains 'backend')
REPO_ROOT = (Path(__file__).parent / "..").resolve()

# Add backend/ to sys.path, regardless of where pytest is called from
sys.path.insert(0, str(REPO_ROOT / "backend/src"))
