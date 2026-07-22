#!/usr/bin/env python3
"""Append one per-day `graphify benchmark` record to a JSONL trend ledger.

Parses the text stdout of `graphify benchmark` (the `Graph:` node/edge counts
and the `Reduction:` tokens-per-query factor) and appends a single dated JSON
line to the ledger. The ledger is append-only and idempotent per day: re-running
on the same date neither duplicates nor rewrites an earlier line, so the file
is a stable time series the recap can chart deltas from.

Usage:

    graphify benchmark graphify-out/graph.json | \
        python3 scripts/graph/append_benchmark_trend.py \
            --out graph/metrics/benchmark-trend.jsonl
"""

from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import re
import sys

# Pinned to `graphify benchmark` stdout: variable space runs, thousands commas.
_GRAPH_RE = re.compile(r"Graph:\s+([0-9,]+)\s+nodes,\s+([0-9,]+)\s+edges")
_REDUCTION_RE = re.compile(r"Reduction:\s+([0-9]+(?:\.[0-9]+)?)x")


def parse_benchmark(text: str) -> tuple[float, int, int]:
    """Extract (reduction_avg, nodes, edges) from `graphify benchmark` stdout.

    Raises ValueError when either the Graph: or Reduction: line is absent or
    unparseable, so callers can fail loudly on malformed input.
    """
    graph = _GRAPH_RE.search(text)
    reduction = _REDUCTION_RE.search(text)
    if graph is None or reduction is None:
        raise ValueError("benchmark text is missing the Graph: or Reduction: line")
    nodes = int(graph.group(1).replace(",", ""))
    edges = int(graph.group(2).replace(",", ""))
    return float(reduction.group(1)), nodes, edges


def _last_record_date(path: pathlib.Path) -> str | None:
    """Date of the ledger's last non-blank JSON line, or None when unreadable."""
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        return None
    try:
        record = json.loads(lines[-1])
    except ValueError:
        return None
    if not isinstance(record, dict):
        return None
    date = record.get("date")
    return date if isinstance(date, str) else None


def append_trend(path: pathlib.Path, *, reduction_avg: float, nodes: int, edges: int, date: str) -> bool:
    """Append one dated record; return False when that date is already recorded.

    Append-only: earlier lines are never rewritten. Idempotence is judged by the
    LAST non-blank line only, so a same-day re-run is a no-op.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and _last_record_date(path) == date:
        return False
    record = {"date": date, "reduction_avg": reduction_avg, "nodes": nodes, "edges": edges}
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")
    return True


def _read_benchmark_text(benchmark: str | None) -> str:
    """Read the benchmark stdout from a file, or stdin when no path is given."""
    if benchmark:
        return pathlib.Path(benchmark).read_text(encoding="utf-8")
    return sys.stdin.read()


def main(argv: list[str] | None = None) -> int:
    """Parse benchmark stdout and append today's record to the trend ledger."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--benchmark", help="file holding `graphify benchmark` stdout (default: stdin)")
    parser.add_argument("--out", required=True, help="JSONL trend ledger to append to")
    parser.add_argument(
        "--date",
        default=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
        help="record date, YYYY-MM-DD (default: today UTC)",
    )
    args = parser.parse_args(argv)

    text = _read_benchmark_text(args.benchmark)
    try:
        reduction_avg, nodes, edges = parse_benchmark(text)
    except ValueError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1

    wrote = append_trend(
        pathlib.Path(args.out), reduction_avg=reduction_avg, nodes=nodes, edges=edges, date=args.date
    )
    verb = "appended" if wrote else "already recorded"
    print(f"{verb} {args.date}: reduction {reduction_avg}x, {nodes} nodes, {edges} edges -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
