"""Project the seeded practice presets into the frontend's launch-matrix fixture.

Issue #3072 (AC8): the frontend proves that every seeded preset — canonical and
alternative — produces a ``ModeConfig`` the client validates, mounts the right
session view, and can start, pause, resume, complete and save. That test cannot
import Python, so it reads a committed JSON projection of
:data:`seed_practices.PRESET_PRACTICES` instead. A copy is only honest while
something fails when it drifts, so this one module owns the projection and both
the regeneration command and the backend drift test call it:

    cd backend && PYTHONPATH=src python -m scripts.dump_seeded_presets --write
    cd backend && PYTHONPATH=src python -m scripts.dump_seeded_presets --check

``--check`` compares parsed JSON, not bytes: the fixture lives under
``frontend/`` where prettier owns its layout, and a reflow must not read as
drift. Exit codes: 0 when written or current, 1 on drift or a missing fixture.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from seed_practices import CANONICAL_PRESET_PRACTICES, PRESET_PRACTICES

#: Where the frontend launch matrix reads the projection from.
FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "features"
    / "Practice"
    / "__tests__"
    / "fixtures"
    / "seededPresets.json"
)

#: The one command that regenerates the fixture, printed on drift.
REGENERATE_COMMAND = "cd backend && PYTHONPATH=src python -m scripts.dump_seeded_presets --write"

EXIT_OK = 0
EXIT_DRIFT = 1


def dump_seeded_presets() -> list[dict[str, Any]]:
    """Return every seeded preset as the fields the frontend matrix needs.

    Sorted by stage, canonical first, then name, so a regeneration is stable
    regardless of the order presets are declared in.
    """
    canonical_names = {p["name"] for p in CANONICAL_PRESET_PRACTICES}
    rows = [
        {
            "name": p["name"],
            "stage_number": p["stage_number"],
            "mode": p["mode"],
            "mode_config": p["mode_config"],
            "canonical": p["name"] in canonical_names,
        }
        for p in PRESET_PRACTICES
    ]
    return sorted(rows, key=lambda r: (r["stage_number"], not r["canonical"], r["name"]))


def render(rows: list[dict[str, Any]]) -> str:
    """Serialise the projection deterministically (sorted keys, trailing newline)."""
    return json.dumps(rows, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def check(path: Path) -> int:
    """Return :data:`EXIT_OK` when ``path`` holds the current projection, else drift."""
    if not path.is_file():
        sys.stderr.write(f"{path} is missing; regenerate with:\n  {REGENERATE_COMMAND}\n")
        return EXIT_DRIFT
    committed = json.loads(path.read_text(encoding="utf-8"))
    if committed != dump_seeded_presets():
        sys.stderr.write(
            f"{path} has drifted from seed_practices.PRESET_PRACTICES; regenerate with:\n"
            f"  {REGENERATE_COMMAND}\n"
        )
        return EXIT_DRIFT
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    """Write (``--write``) or verify (``--check``, the default) the fixture."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--write", action="store_true", help="(re)write the fixture")
    parser.add_argument("--check", action="store_true", help="fail when the fixture drifted")
    parser.add_argument("--path", type=Path, default=FIXTURE_PATH, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.write:
        args.path.parent.mkdir(parents=True, exist_ok=True)
        args.path.write_text(render(dump_seeded_presets()), encoding="utf-8")
        return EXIT_OK
    return check(args.path)


if __name__ == "__main__":
    sys.exit(main())
