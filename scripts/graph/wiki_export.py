#!/usr/bin/env python3
"""Render a graphify node-link graph into an agent-crawlable wiki.

Given a graphify ``graph.json`` (NetworkX node-link form) and an optional
``.graphify_analysis.json``, emit a small Markdown wiki: one ``index.md``
overview plus exactly one ``community-<NN>-<slug>.md`` article per community.
The output is deterministic and offline (stdlib only) so it can be diffed and
published as a release asset without any network access or timestamps.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

GENERATED_NOTE = (
    "_Generated from the knowledge-graph release by "
    "`scripts/graph/wiki_export.py`. Do not edit by hand._"
)
MIN_ID_WIDTH = 2


def slugify(name: str) -> str:
    """Collapse a community name into a filename-safe slug.

    Lowercases, replaces every run of non-alphanumeric characters with a
    single ``-``, and strips leading/trailing separators.
    """
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def article_filename(community_id: int, name: str) -> str:
    """Return the article filename for a community id and display name.

    A name that slugifies to empty falls back to the community id so the
    filename never degenerates to a trailing-dash ``community-NN-.md``.
    """
    slug = slugify(name) or str(community_id)
    return f"community-{community_id:0{MIN_ID_WIDTH}d}-{slug}.md"


def _as_dict_list(value: object) -> list[dict[str, object]]:
    """Coerce a JSON value into a list of dict records, ignoring non-dicts."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def load_json(path: Path) -> dict[str, object]:
    """Load a JSON object from ``path``."""
    with path.open(encoding="utf-8") as handle:
        data: dict[str, object] = json.load(handle)
    return data


def community_display_name(nodes: list[dict[str, object]], community_id: int) -> str:
    """Return the real community name, falling back to the raw id.

    Never emits a ``Community <N>`` placeholder: when no node carries a
    ``community_name`` the bare id string is used instead. The upstream
    workflow's placeholder guard rejects any surviving ``Community <N>``
    label before this runs, so in the published pipeline a real name is
    always present; the id fallback only guards ad-hoc local runs.
    """
    for node in nodes:
        name = node.get("community_name")
        if isinstance(name, str) and name.strip():
            return name
    return str(community_id)


def group_by_community(
    nodes: list[dict[str, object]],
) -> dict[int, list[dict[str, object]]]:
    """Group nodes by their integer ``community`` id.

    Nodes without a ``community`` assignment are skipped rather than raising:
    a single unclustered node must never break the whole wiki export.
    """
    grouped: dict[int, list[dict[str, object]]] = defaultdict(list)
    for node in nodes:
        community = node.get("community")
        if community is None:
            continue
        grouped[int(str(community))].append(node)
    return grouped


def node_sort_key(node: dict[str, object]) -> tuple[str, str, str]:
    """Deterministic sort key for member nodes."""
    return (
        str(node.get("source_file", "")),
        str(node.get("source_location", "")),
        str(node.get("id", "")),
    )


def render_members(members: list[dict[str, object]]) -> list[str]:
    """Render the member section grouped by source file."""
    lines = ["## Members", ""]
    by_file: dict[str, list[dict[str, object]]] = defaultdict(list)
    for node in members:
        by_file[str(node.get("source_file", ""))].append(node)
    for source_file in sorted(by_file):
        lines.append(f"### `{source_file}`")
        lines.append("")
        for node in sorted(by_file[source_file], key=node_sort_key):
            label = str(node.get("label", node.get("id", "")))
            location = str(node.get("source_location", ""))
            lines.append(f"- **{label}** — `{source_file}:{location}`")
        lines.append("")
    return lines


def render_gods(
    member_ids: set[str],
    gods: list[dict[str, object]],
) -> list[str]:
    """Render the god-node section for a community, if any are members."""
    relevant = [g for g in gods if str(g.get("id", "")) in member_ids]
    if not relevant:
        return []
    relevant.sort(key=lambda g: (str(g.get("label", "")), str(g.get("id", ""))))
    lines = ["## God nodes", ""]
    for god in relevant:
        label = str(god.get("label", god.get("id", "")))
        degree = god.get("degree")
        suffix = f" (degree {degree})" if degree is not None else ""
        lines.append(f"- **{label}**{suffix}")
    lines.append("")
    return lines


def _surprise_touches(
    surprise: dict[str, object],
    member_keys: set[tuple[str, str]],
    member_labels: set[str],
) -> bool:
    """Report whether a surprise bridge has an endpoint in this community.

    Surprises carry display *labels* (not ids) for their endpoints, because
    that is all ``.graphify_analysis.json`` records. Labels are not unique in
    a real monorepo — generic names like ``__init__`` or ``render()`` recur
    across files — so keying on the label alone would misattribute a bridge
    into every community owning a same-named node. Each surprise also carries
    ``source_files`` aligned with its ``source``/``target``, so match on the
    ``(label, source_file)`` pair, which is unique per node, and fall back to
    label-only matching only when the file list is absent or malformed.
    """
    source = str(surprise.get("source", ""))
    target = str(surprise.get("target", ""))
    files = surprise.get("source_files")
    if isinstance(files, list) and len(files) >= 2:
        source_key = (source, str(files[0]))
        target_key = (target, str(files[1]))
        return source_key in member_keys or target_key in member_keys
    return source in member_labels or target in member_labels


def render_surprises(
    member_keys: set[tuple[str, str]],
    member_labels: set[str],
    surprises: list[dict[str, object]],
) -> list[str]:
    """Render cross-community surprise bridges touching this community."""
    relevant = [s for s in surprises if _surprise_touches(s, member_keys, member_labels)]
    if not relevant:
        return []
    relevant.sort(
        key=lambda s: (str(s.get("source", "")), str(s.get("target", "")))
    )
    lines = ["## Surprising bridges", ""]
    for surprise in relevant:
        source = str(surprise.get("source", ""))
        target = str(surprise.get("target", ""))
        relation = str(surprise.get("relation", ""))
        why = str(surprise.get("why", ""))
        lines.append(f"- `{source}` --{relation}--> `{target}` — {why}")
    lines.append("")
    return lines


def render_article(
    name: str,
    members: list[dict[str, object]],
    gods: list[dict[str, object]],
    surprises: list[dict[str, object]],
) -> str:
    """Render one community article as Markdown."""
    member_ids = {str(node.get("id", "")) for node in members}
    member_labels = {str(node.get("label", "")) for node in members}
    member_keys = {
        (str(node.get("label", "")), str(node.get("source_file", ""))) for node in members
    }
    lines = [f"# {name}", "", GENERATED_NOTE, ""]
    lines.extend(render_members(members))
    lines.extend(render_gods(member_ids, gods))
    lines.extend(render_surprises(member_keys, member_labels, surprises))
    lines.append("---")
    lines.append("")
    lines.append("[Back to index](index.md)")
    lines.append("")
    return "\n".join(lines)


def render_index(
    ordered: list[tuple[int, str, list[dict[str, object]]]],
) -> str:
    """Render the wiki index listing every community."""
    lines = [
        "# Knowledge-graph community wiki",
        "",
        GENERATED_NOTE,
        "",
        f"Communities: {len(ordered)}",
        "",
        "| Community | Nodes | Article |",
        "| --- | --- | --- |",
    ]
    for community_id, name, members in ordered:
        filename = article_filename(community_id, name)
        cell = name.replace("|", "\\|")
        lines.append(f"| {cell} | {len(members)} | [{cell}]({filename}) |")
    lines.append("")
    return "\n".join(lines)


def build_wiki(
    graph: dict[str, object],
    analysis: dict[str, object] | None,
    out_dir: Path,
) -> None:
    """Write ``index.md`` and one article per community into ``out_dir``."""
    out_dir.mkdir(parents=True, exist_ok=True)
    nodes = _as_dict_list(graph.get("nodes", []))
    grouped = group_by_community(nodes)

    gods: list[dict[str, object]] = []
    surprises: list[dict[str, object]] = []
    if analysis is not None:
        gods = _as_dict_list(analysis.get("gods", []))
        surprises = _as_dict_list(analysis.get("surprises", []))

    ordered: list[tuple[int, str, list[dict[str, object]]]] = []
    for community_id in sorted(grouped):
        members = grouped[community_id]
        name = community_display_name(members, community_id)
        ordered.append((community_id, name, members))

    (out_dir / "index.md").write_text(render_index(ordered), encoding="utf-8")
    for community_id, name, members in ordered:
        article = render_article(name, members, gods, surprises)
        (out_dir / article_filename(community_id, name)).write_text(
            article, encoding="utf-8"
        )


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--graph", default="graphify-out/graph.json")
    parser.add_argument("--analysis", default="graphify-out/.graphify_analysis.json")
    parser.add_argument("--out-dir", default="graphify-out/wiki")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Entry point: render the wiki from the graph and optional analysis."""
    args = parse_args(argv)
    graph = load_json(Path(args.graph))
    analysis_path = Path(args.analysis)
    analysis = load_json(analysis_path) if analysis_path.exists() else None
    build_wiki(graph, analysis, Path(args.out_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
