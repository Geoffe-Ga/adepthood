#!/usr/bin/env python3
"""Write the backend's OpenAPI document to ``backend/openapi.json``.

The committed file is what the frontend's Zod-conformance test reads, so it has
to be a faithful, *diffable* artifact rather than a snapshot nobody can review.
Two properties make it one:

* **Deterministic.** Keys are sorted and the separators are fixed, so a rerun on
  an unchanged app produces a byte-identical file. Without that the drift gate
  would fire on dictionary ordering and everyone would learn to ignore it.
* **Checked, not trusted.** ``--check`` regenerates and compares instead of
  writing, which is what CI runs. A generated artifact nobody regenerates is
  worse than none -- #522 deleted a stale generated ``types.ts`` for exactly
  that reason -- so the gate exists to keep this file honest.

Usage::

    python scripts/backend/export_openapi.py            # write the file
    python scripts/backend/export_openapi.py --check    # exit 1 on drift
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BACKEND = _REPO_ROOT / "backend"
_OUTPUT = _BACKEND / "openapi.json"


def load_spec() -> dict[str, object]:
    """Import the FastAPI app and render its OpenAPI document.

    A throwaway in-memory database URL is set first: importing ``main`` builds
    the engine, and this script must not need -- or touch -- a real Postgres to
    describe the app's shape. The import is deliberately inside the function so
    the environment is prepared before it happens.
    """
    os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    os.environ.setdefault("SECRET_KEY", "openapi-export-only")  # noqa: S106
    sys.path.insert(0, str(_BACKEND / "src"))
    from main import app  # noqa: PLC0415 — see docstring: env must be set first

    return dict(app.openapi())


def _display(path: Path) -> str:
    """Render ``path`` relative to the repo when it is inside it, else verbatim.

    ``Path.relative_to`` raises for anything outside the root, which would turn
    every failure message -- the ones that matter most -- into a ValueError
    traceback the moment the output path is redirected (a test, or a caller
    writing elsewhere).
    """
    try:
        return str(path.relative_to(_REPO_ROOT))
    except ValueError:
        return str(path)


def render_spec(spec: dict[str, object]) -> str:
    """Serialise ``spec`` deterministically, with a trailing newline."""
    return json.dumps(spec, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    """Write the document, or compare it and report drift. Returns an exit code."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="compare against the committed file instead of writing it",
    )
    args = parser.parse_args()

    rendered = render_spec(load_spec())

    if not args.check:
        _OUTPUT.write_text(rendered, encoding="utf-8")
        sys.stdout.write(f"wrote {_display(_OUTPUT)}\n")
        return 0

    if not _OUTPUT.exists():
        sys.stderr.write(
            f"{_display(_OUTPUT)} is missing; "
            "run: python scripts/backend/export_openapi.py\n"
        )
        return 1
    if _OUTPUT.read_text(encoding="utf-8") != rendered:
        sys.stderr.write(
            f"{_display(_OUTPUT)} is out of date with the app's routes "
            "and schemas.\nRegenerate it with: python scripts/backend/export_openapi.py\n"
        )
        return 1
    sys.stdout.write(f"{_display(_OUTPUT)} is up to date\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
