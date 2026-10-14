"""Select CI lanes from the complete Git diff, without an API file-count limit."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


def affected(paths: list[str]) -> dict[str, bool]:
    """Include shared inputs and the workflow itself in each lane's scope."""
    shared = any(
        path.startswith("scripts/ci/") or path == ".github/workflows/_affected.yml"
        for path in paths
    )
    backend_workflow = ".github/workflows/backend-ci.yml" in paths
    backend = (
        shared
        or backend_workflow
        or any(
            path.startswith(("backend/", "scripts/backend/"))
            and not path.startswith("backend/tests/scripts/")
            and not path.endswith(".md")
            for path in paths
        )
    )
    cross = (
        shared
        or backend_workflow
        or any(
            # backendSource.ts deliberately accepts any backend path, including
            # shared fixtures, config examples and test-owned contract inputs.
            # Keep this cheap lane broad so new readers cannot evade it.
            path.startswith(("backend/", "frontend/"))
            or path == "scripts/frontend/cross-boundary-drift.sh"
            for path in paths
        )
    )
    content = (
        shared
        or backend_workflow
        or any(
            path.startswith(
                ("backend/content/", "backend/src/curriculum/", "backend/requirements")
            )
            or path
            in {
                "backend/scripts/sync_content.py",
                "backend/scripts/build_stage_correspondence.py",
                "backend/scripts/content_completeness.py",
                "backend/scripts/check_wavelength_terms.py",
                "backend/scripts/__init__.py",
            }
            for path in paths
        )
    )
    e2e = (
        shared
        or ".github/workflows/e2e.yml" in paths
        or any(
            path.startswith(
                (
                    "backend/src/",
                    "backend/content/",
                    "backend/migrations/",
                    "backend/tests/e2e/",
                    "backend/requirements",
                    "scripts/backend/",
                    "frontend/",
                )
            )
            or path
            in {
                "backend/alembic.ini",
                "backend/pyproject.toml",
                "backend/tests/__init__.py",
            }
            for path in paths
        )
    )
    return {"backend": backend, "cross": cross, "content": content, "e2e": e2e}


def changed_paths(event_name: str, event: dict) -> list[str] | None:
    """Use a PR merge base or the full push range; uncertainty runs every lane."""
    if event_name == "pull_request":
        base = event["pull_request"]["base"]["sha"]
        head = event["pull_request"]["head"]["sha"]
        revision = f"{base}...{head}"
    elif event_name == "push":
        base, head = event["before"], event["after"]
        if base == "0" * 40:
            return None
        revision = f"{base}..{head}"
    else:
        return None
    try:
        # --no-renames reports both sides of moves, so the old component is
        # checked too. NUL separators preserve spaces/newlines in filenames.
        result = subprocess.run(
            ["git", "diff", "--name-only", "--no-renames", "-z", revision, "--"],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError:
        return None
    return os.fsdecode(result.stdout).rstrip("\0").split("\0") if result.stdout else []


def main() -> None:
    """Write explicit boolean outputs for job-level GitHub Actions conditions."""
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    paths = changed_paths(os.environ["GITHUB_EVENT_NAME"], event)
    lanes = affected(paths or [])
    if paths is None:
        lanes = dict.fromkeys(lanes, True)
        print("Diff unavailable; running every lane.")
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        for name, enabled in lanes.items():
            print(f"{name}={str(enabled).lower()}", file=output)
            print(f"{name}: {'run' if enabled else 'skip'}")


if __name__ == "__main__":
    main()
