#!/usr/bin/env python3
"""Hard-fail if any community still carries a ``Community <N>`` placeholder.

The weekly semantic pipeline clusters the graph (leaving bare ``Community
<N>`` placeholders), names the communities with the LLM, then publishes the
graph, its label sidecar, and a human-readable ``GRAPH_REPORT.md`` as release
assets. A placeholder that survives labelling must never ship as a final
name, so this gate inspects *every* artifact a placeholder could leak
through and refuses to publish on the first offender:

* ``.graphify_labels.json`` — the id -> name label sidecar.
* ``graph.json`` — each node's ``community_name`` field.
* ``GRAPH_REPORT.md`` — the report asset. graphify writes an interim
  placeholder report during ``cluster-only --no-label`` and rewrites it with
  the final names during ``label``; because the report is a *required*
  published asset, verifying it here — rather than trusting the label step's
  rewrite ordering — makes a placeholder-laden report structurally unable to
  pass the gate. The report renders a community name both quoted in its
  section heading (``### Community 0 - "<name>"``) and bare in its navigation
  list (``- <name>``); the unquoted ``### Community 0 -`` heading *prefix* is
  present for every community regardless of naming, so only the quoted label
  form and the bare navigation-list form are treated as placeholder evidence.

Exit 0 when every community is named; exit 1 (with a GitHub ``::error::``
annotation) on the first missing required file or surviving placeholder.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# A bare "Community <N>" is graphify's placeholder for an unnamed community.
_PLACEHOLDER = re.compile(r"^Community \d+$")
# The report quotes each community's label in its section heading, so a quoted
# "Community <N>" is an unambiguous placeholder — unlike the unquoted heading
# prefix "### Community <N> -", which is always present.
_REPORT_QUOTED = re.compile(r'"Community \d+"')
# A thin community that gets no "### Community <N>" heading still appears as a
# bare navigation-list line; a whole line of just "- Community <N>" is a
# placeholder too.
_REPORT_NAV_LINE = re.compile(r"^- Community \d+\s*$")


def _fail(message: str) -> None:
    """Emit a GitHub error annotation and exit non-zero."""
    sys.stderr.write(f"::error::{message}\n")
    raise SystemExit(1)


def _load_required_json(path: Path, kind: str) -> object:
    """Load a required JSON artifact, failing loudly if it is absent."""
    if not path.exists():
        _fail(
            f"{path} missing — {kind}; refusing to publish a knowledge-graph "
            "release with an unverifiable set of community labels"
        )
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def placeholder_labels(labels: object) -> set[str]:
    """Return the ids whose label sidecar entry is a bare placeholder."""
    offenders: set[str] = set()
    if isinstance(labels, dict):
        for community_id, name in labels.items():
            if isinstance(name, str) and _PLACEHOLDER.match(name):
                offenders.add(str(community_id))
    return offenders


def placeholder_nodes(graph: object) -> set[str]:
    """Return the community ids whose graph node names are placeholders."""
    offenders: set[str] = set()
    nodes = graph.get("nodes", []) if isinstance(graph, dict) else []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        name = node.get("community_name")
        if isinstance(name, str) and _PLACEHOLDER.match(name):
            offenders.add(str(node.get("community")))
    return offenders


def report_has_placeholder(report_text: str) -> bool:
    """Report True if the rendered report carries a placeholder community name."""
    if _REPORT_QUOTED.search(report_text):
        return True
    return any(_REPORT_NAV_LINE.match(line) for line in report_text.splitlines())


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", required=True)
    parser.add_argument("--graph", required=True)
    parser.add_argument("--report", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Check every artifact for placeholder labels; exit 1 on any offender."""
    args = parse_args(argv)

    labels = _load_required_json(Path(args.labels), "label step wrote no labels")
    graph = _load_required_json(Path(args.graph), "no graph to publish")
    report_path = Path(args.report)
    if not report_path.exists():
        _fail(
            f"{report_path} missing — the report is a required release asset; "
            "refusing to publish a release without it"
        )

    offenders = placeholder_labels(labels) | placeholder_nodes(graph)
    if offenders:
        ids = ", ".join(sorted(offenders))
        _fail(
            "placeholder community label(s) survived labelling for community "
            f"id(s): {ids} — refusing to publish placeholders as final"
        )
    if report_has_placeholder(report_path.read_text(encoding="utf-8")):
        _fail(
            f"{report_path} still renders a bare 'Community <N>' name — "
            "refusing to publish a report carrying placeholder labels"
        )

    print("no placeholder community labels — all communities are named")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
