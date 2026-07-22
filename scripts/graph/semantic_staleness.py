#!/usr/bin/env python3
"""Report whether the published semantic graph layer is overdue for a rebuild.

Reads a published meta JSON (the `semantic-meta.json` release asset) and judges
its `built_at` age against STALE_AFTER_DAYS. Only a `code+semantic` meta with a
timestamp can be stale; a code-only graph or a missing/empty meta is simply not
a semantic layer and is reported as fresh.

Cron-safe contract: every invocation exits 0. Staleness is reported via stdout
and, under GitHub Actions, via `stale=` / `age_days=` lines appended to the
file named by $GITHUB_OUTPUT — never via the exit code.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import pathlib

# The weekly semantic pass should land at least this often; older is stale.
STALE_AFTER_DAYS = 14


def age_days(built_at: str, *, now: datetime.datetime) -> int:
    """Whole days elapsed between an ISO-8601 `built_at` stamp and `now`."""
    parsed = datetime.datetime.fromisoformat(built_at.replace("Z", "+00:00"))
    return (now - parsed).days


def evaluate(meta: dict, *, now: datetime.datetime, threshold: int = STALE_AFTER_DAYS) -> dict:
    """Judge a graph meta dict; only an aged code+semantic layer is stale.

    Exactly `threshold` days old is NOT stale — staleness is strictly greater.
    """
    kind = meta.get("kind")
    built_at = meta.get("built_at")
    if kind != "code+semantic" or not built_at:
        reason = "not a semantic layer" if kind != "code+semantic" else "no built_at timestamp"
        return {"kind": kind, "built_at": built_at, "age_days": None, "is_stale": False, "reason": reason}
    age = age_days(str(built_at), now=now)
    return {
        "kind": kind,
        "built_at": built_at,
        "age_days": age,
        "is_stale": age > threshold,
        "reason": f"semantic layer is {age} days old (threshold {threshold})",
    }


def _load_meta(path: pathlib.Path) -> dict:
    """Read the meta JSON; a missing or unreadable file degrades to {}."""
    if not path.exists():
        return {}
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return meta if isinstance(meta, dict) else {}


def _write_github_output(result: dict) -> None:
    """Append stale/age lines to $GITHUB_OUTPUT when running under Actions."""
    out_path = os.environ.get("GITHUB_OUTPUT")
    if not out_path:
        return
    age = result["age_days"]
    with open(out_path, "a", encoding="utf-8") as handle:
        handle.write(f"stale={'true' if result['is_stale'] else 'false'}\n")
        handle.write(f"age_days={age if age is not None else ''}\n")


def main(argv: list[str] | None = None) -> int:
    """Evaluate the meta file and report; always exits 0 (cron-safe)."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--meta", required=True, help="path to the published semantic meta JSON")
    args = parser.parse_args(argv)

    meta = _load_meta(pathlib.Path(args.meta))
    now = datetime.datetime.now(datetime.timezone.utc)
    result = evaluate(meta, now=now)

    state = "STALE" if result["is_stale"] else "FRESH"
    age = result["age_days"] if result["age_days"] is not None else "n/a"
    print(f"semantic layer age: {age} days (kind={result['kind']}) -> {state} ({result['reason']})")
    _write_github_output(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
