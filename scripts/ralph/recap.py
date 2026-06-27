#!/usr/bin/env python3
"""Post a Ralph tick-loop recap to Discord whenever a PR is merged.

Reads two environment variables for delivery:

    DISCORD_BOT_TOKEN   Bot token (sent as `Authorization: Bot <token>`).
    RALPH_CHANNEL_ID    Snowflake ID of the channel to post the recap into.

and uses a GitHub token (GITHUB_TOKEN / GH_TOKEN) plus the repo slug
(--repo or $GITHUB_REPOSITORY) to gather the merge history. If ANTHROPIC_API_KEY
is present, the most-recently-merged PR gets a ten-word "what this unlocked"
headline from Claude; otherwise a plain heuristic headline is used.

This is meant to run from a GitHub Actions workflow keyed on
`pull_request: closed` (filtered to merged PRs) — see
`.github/workflows/ralph-recap.yml` — but it runs fine locally too:

    DISCORD_BOT_TOKEN=... RALPH_CHANNEL_ID=... GITHUB_TOKEN=... \
        python scripts/ralph/recap.py --repo Geoffe-Ga/adepthood --dry-run

`--dry-run` prints the rendered embed as JSON instead of posting it.

The backlog count mirrors `scripts/ralph/pick-next.sh`: open issues bearing any
of the picker's exclude labels (epics, blocked, etc.) are not part of Ralph's
real workload, so they are dropped from the ETA. Override the label set with the
same `RALPH_EXCLUDE_LABELS` env var the picker uses.

The statistics math lives in stats.py (pure, unit-tested); this module is the
I/O shell around it.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, cast

import stats

# Optional dependency: only needed for the Claude-written headline. Imported at
# module top level so the rest of the recap works even when it is absent.
try:
    import anthropic as _anthropic_mod
except ImportError:
    _anthropic_mod = None


class RecapError(Exception):
    """A user-facing failure with an associated process exit code."""

    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.code = code


GITHUB_API = "https://api.github.com"
DISCORD_API = "https://discord.com/api/v10"
# Discord embed accent — a Ralph-purple.
EMBED_COLOR = 0x7C3AED
# Cap per-PR comment fetches so a giant campaign doesn't make thousands of calls.
DEFAULT_MAX_PRS = 200
HEADLINE_MODEL = "claude-opus-4-8"

# Issues carrying any of these labels are not part of Ralph's real backlog, so
# they are excluded from the open-issue count behind the ETA. Kept in sync with
# the default exclude set in `scripts/ralph/pick-next.sh`.
DEFAULT_EXCLUDE_LABELS = (
    "epic",
    "wontfix",
    "duplicate",
    "invalid",
    "question",
    "blocked",
    "needs-spec",
    "future-work",
    "do-not-auto-merge",
    "in-progress",
)


# --------------------------------------------------------------------------- #
# HTTP helpers
# --------------------------------------------------------------------------- #


def _request_json(
    url: str,
    *,
    headers: dict[str, str],
    method: str = "GET",
    body: bytes | None = None,
) -> object:
    """Perform an HTTP request and parse a JSON response body.

    Returns the parsed JSON (typed as `object`; callers cast). Raises
    urllib.error.HTTPError / URLError on transport or HTTP failures.
    """
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw else None


def _gh_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ralph-recap",
    }


def _gh_get_paged(path: str, *, token: str, params: dict[str, str], max_items: int) -> list[dict[str, Any]]:
    """GET a paginated GitHub list endpoint, stopping at max_items."""
    headers = _gh_headers(token)
    out: list[dict[str, Any]] = []
    page = 1
    while len(out) < max_items:
        query = "&".join(f"{k}={v}" for k, v in {**params, "per_page": "100", "page": str(page)}.items())
        url = f"{GITHUB_API}{path}?{query}"
        chunk = cast("list[dict[str, Any]]", _request_json(url, headers=headers))
        if not chunk:
            break
        out.extend(chunk)
        if len(chunk) < 100:
            break
        page += 1
    return out[:max_items]


# --------------------------------------------------------------------------- #
# GitHub data gathering
# --------------------------------------------------------------------------- #


def fetch_merged_prs(repo: str, *, token: str, max_prs: int) -> list[dict[str, Any]]:
    """Return merged PRs (newest merge first), capped at max_prs."""
    closed = _gh_get_paged(
        f"/repos/{repo}/pulls",
        token=token,
        params={"state": "closed", "sort": "updated", "direction": "desc"},
        max_items=max_prs * 2,
    )
    merged = [pr for pr in closed if pr.get("merged_at")]
    merged.sort(key=lambda pr: cast("str", pr["merged_at"]), reverse=True)
    return merged[:max_prs]


def fetch_pr_detail(repo: str, number: int, *, token: str) -> dict[str, Any]:
    """Fetch a single PR (carries additions/deletions/changed_files)."""
    url = f"{GITHUB_API}/repos/{repo}/pulls/{number}"
    return cast("dict[str, Any]", _request_json(url, headers=_gh_headers(token)))


def fetch_pr_verdicts(repo: str, number: int, *, token: str) -> list[str]:
    """Return the ordered list of normalized Claude verdicts on one PR."""
    comments = _gh_get_paged(
        f"/repos/{repo}/issues/{number}/comments",
        token=token,
        params={"sort": "created", "direction": "asc"},
        max_items=100,
    )
    verdicts: list[str] = []
    for comment in comments:
        verdict = stats.normalize_verdict(str(comment.get("body", "")))
        if verdict is not None:
            verdicts.append(verdict)
    return verdicts


def _excluded_labels() -> set[str]:
    """Return the label set that disqualifies an issue from the backlog count.

    Mirrors `scripts/ralph/pick-next.sh`: defaults to the housekeeping/deferred
    markers, overridable via the same `RALPH_EXCLUDE_LABELS` env var (a
    space-separated list). An empty override counts every open issue.
    """
    raw = os.environ.get("RALPH_EXCLUDE_LABELS")
    if raw is None:
        return set(DEFAULT_EXCLUDE_LABELS)
    return {label for label in raw.split() if label}


def count_open_backlog(repo: str, *, token: str, max_items: int = 1000) -> int:
    """Count open issues that are real, unblocked Ralph work — the backlog.

    Excludes pull requests (which the issues endpoint returns too) and any issue
    bearing an excluded label, so the ETA reflects what the picker would
    actually pick up rather than every open card.
    """
    issues = _gh_get_paged(
        f"/repos/{repo}/issues",
        token=token,
        params={"state": "open"},
        max_items=max_items,
    )
    excluded = _excluded_labels()
    backlog = 0
    for issue in issues:
        if "pull_request" in issue:
            continue
        names = {str(label.get("name", "")) for label in issue.get("labels", [])}
        if names & excluded:
            continue
        backlog += 1
    return backlog


# --------------------------------------------------------------------------- #
# Headline generation
# --------------------------------------------------------------------------- #


def _heuristic_headline(title: str) -> str:
    """Fallback ten-word headline: the cleaned PR title, clipped to ten words."""
    cleaned = title.strip()
    for prefix in ("feat:", "feat(", "fix:", "chore:", "refactor:", "docs:"):
        if cleaned.lower().startswith(prefix):
            cleaned = cleaned.split(":", 1)[-1].strip() if ":" in cleaned else cleaned
            break
    words = cleaned.split()
    return " ".join(words[:10]) if words else "Latest change merged into the tick loop"


def generate_headline(title: str, body: str) -> str:
    """Ask Claude for a ten-word "what this unlocked" headline.

    Falls back to a heuristic if the Anthropic SDK or API key is unavailable, so
    the recap never fails just because the headline can't be generated.
    """
    if _anthropic_mod is None or not os.environ.get("ANTHROPIC_API_KEY"):
        return _heuristic_headline(title)

    prompt = (
        "A pull request was just merged into an autonomous coding loop. "
        "Write a single headline of at most ten words describing what merging "
        "this PR has unlocked or newly made possible for the project. Lead with "
        "the capability or outcome, not the implementation. Plain language only: "
        "no buzzwords, no 'leverage'/'robust'/'seamless'/'synergy', no jargon "
        "soup, no trailing punctuation. Return only the headline.\n\n"
        f"PR title: {title}\n\n"
        f"PR description:\n{body[:4000]}"
    )
    try:
        client = _anthropic_mod.Anthropic()
        response = client.messages.create(
            model=HEADLINE_MODEL,
            max_tokens=256,
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(block.text for block in response.content if block.type == "text").strip()
    except Exception:  # any SDK/API failure degrades to the heuristic, never fails the recap
        return _heuristic_headline(title)
    return text or _heuristic_headline(title)


# --------------------------------------------------------------------------- #
# Recap assembly
# --------------------------------------------------------------------------- #


def _fmt_hours(hours: float) -> str:
    if hours < 1:
        return f"{round(hours * 60)}m"
    if hours < 48:
        return f"{hours:.1f}h"
    return f"{hours / 24:.1f}d"


def _fmt_eta(estimate: dict[str, object]) -> str:
    if not estimate["known"]:
        return "unknown (loop is stalled — no recent merges)"
    days = cast("float | None", estimate["days_remaining"])
    if days is None or days <= 0:
        return "backlog clear 🎉"
    eta = cast("dt.datetime", estimate["eta"])
    return f"~{days:.1f} days (≈ {eta.date().isoformat()})"


def build_recap(repo: str, *, token: str, max_prs: int, now: dt.datetime) -> dict[str, Any] | None:
    """Gather data and assemble the Discord embed payload.

    Returns None when there are no merged PRs yet (nothing to recap).
    """
    merged = fetch_merged_prs(repo, token=token, max_prs=max_prs)
    if not merged:
        return None

    merged_at = [stats.parse_iso(cast("str", pr["merged_at"])) for pr in merged]
    durations = [
        (stats.parse_iso(cast("str", pr["merged_at"])) - stats.parse_iso(cast("str", pr["created_at"]))).total_seconds()
        / 3600.0
        for pr in merged
    ]

    iterations: list[int] = []
    for pr in merged:
        verdicts = fetch_pr_verdicts(repo, int(pr["number"]), token=token)
        rounds = stats.iterations_before_lgtm(verdicts)
        if rounds is not None:
            iterations.append(rounds)

    latest = merged[0]
    latest_detail = fetch_pr_detail(repo, int(latest["number"]), token=token)
    churn = [
        (
            int(latest_detail.get("additions", 0)),
            int(latest_detail.get("deletions", 0)),
            int(latest_detail.get("changed_files", 0)),
        )
    ]

    rate = stats.merge_rate(merged_at, now=now)
    ttm = stats.time_to_merge_stats(durations)
    iters = stats.iteration_stats(iterations)
    open_items = count_open_backlog(repo, token=token)
    estimate = stats.estimate_remaining(open_items, rate["per_day"], now=now)
    totals = stats.churn_totals(churn)
    busy = stats.busiest_day(merged_at)

    headline = generate_headline(str(latest.get("title", "")), str(latest.get("body") or ""))

    return _render_embed(
        repo=repo,
        latest=latest,
        headline=headline,
        rate=rate,
        ttm=ttm,
        iters=iters,
        estimate=estimate,
        latest_churn=totals,
        busy=busy,
        now=now,
    )


def _render_embed(
    *,
    repo: str,
    latest: dict[str, Any],
    headline: str,
    rate: dict[str, float],
    ttm: dict[str, float],
    iters: dict[str, float],
    estimate: dict[str, object],
    latest_churn: dict[str, int],
    busy: tuple[str, int] | None,
    now: dt.datetime,
) -> dict[str, Any]:
    """Turn computed stats into a Discord embed payload (one message)."""
    pr_number = int(latest["number"])
    pr_url = str(latest.get("html_url", f"https://github.com/{repo}/pull/{pr_number}"))

    clean_pct = round(iters["clean_merge_rate"] * 100)
    iter_line = (
        f"**{iters['mean']:.1f}** avg rounds to LGTM · "
        f"**{clean_pct}%** first-try clean · "
        f"worst **{int(iters['max'])}** (n={int(iters['sample'])})"
        if iters["sample"]
        else "no LGTM verdicts found yet"
    )

    busy_line = f"{busy[1]} merges on {busy[0]}" if busy else "—"

    fields = [
        {
            "name": "🚀 Latest unlock",
            "value": f"*{headline}*\n[#{pr_number} — {latest.get('title', '')}]({pr_url})",
            "inline": False,
        },
        {
            "name": "📦 PRs merged",
            "value": f"**{int(rate['total'])}** total · {int(rate['last_7_days'])} in last 7d",
            "inline": True,
        },
        {
            "name": "⚡ Merge rate",
            "value": f"**{rate['per_day']:.2f}**/day over {rate['span_days']:.1f}d",
            "inline": True,
        },
        {
            "name": "🔁 Review iterations",
            "value": iter_line,
            "inline": False,
        },
        {
            "name": "⏱️ Time to merge",
            "value": (
                f"median **{_fmt_hours(ttm['median'])}** · "
                f"fastest {_fmt_hours(ttm['fastest'])} · slowest {_fmt_hours(ttm['slowest'])}"
            ),
            "inline": False,
        },
        {
            "name": "🗺️ Backlog remaining",
            "value": f"**{estimate['open_items']}** open · ETA {_fmt_eta(estimate)}",
            "inline": True,
        },
        {
            "name": "🔥 Busiest day",
            "value": busy_line,
            "inline": True,
        },
        {
            "name": "🧮 This PR's footprint",
            "value": (
                f"+{latest_churn['additions']} / -{latest_churn['deletions']} across {latest_churn['files']} file(s)"
            ),
            "inline": False,
        },
    ]

    embed = {
        "title": f"🤖 Ralph Recap — {repo}",
        "url": f"https://github.com/{repo}/pulls?q=is%3Apr+is%3Amerged",
        "description": f"Another tick landed. Here's where the loop stands as of <t:{int(now.timestamp())}:R>.",
        "color": EMBED_COLOR,
        "fields": fields,
        "footer": {"text": "Ralph tick loop · recap fires on every merge"},
        "timestamp": now.isoformat(),
    }
    return {"embeds": [embed]}


# --------------------------------------------------------------------------- #
# Discord delivery
# --------------------------------------------------------------------------- #


def post_to_discord(channel_id: str, token: str, payload: dict[str, Any]) -> None:
    """Post the recap payload to a Discord channel as a bot."""
    url = f"{DISCORD_API}/channels/{channel_id}/messages"
    headers = {
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (ralph-recap, 1.0)",
    }
    _request_json(url, headers=headers, method="POST", body=json.dumps(payload).encode("utf-8"))


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def _gather(repo: str, gh_token: str, max_prs: int) -> dict[str, Any] | None:
    """Build the recap payload, mapping network failures to RecapError."""
    now = dt.datetime.now(dt.timezone.utc)
    try:
        return build_recap(repo, token=gh_token, max_prs=max_prs, now=now)
    except urllib.error.HTTPError as exc:
        raise RecapError(f"GitHub API request failed: {exc.code} {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RecapError(f"network failure talking to GitHub: {exc.reason}") from exc


def _deliver(channel_id: str | None, payload: dict[str, Any]) -> None:
    """Post the payload to Discord, mapping failures to RecapError."""
    if not channel_id:
        raise RecapError("RALPH_CHANNEL_ID (or --channel-id) is required to post", code=2)
    discord_token = os.environ.get("DISCORD_BOT_TOKEN")
    if not discord_token:
        raise RecapError("DISCORD_BOT_TOKEN is required to post", code=2)
    try:
        post_to_discord(channel_id, discord_token, payload)
    except urllib.error.HTTPError as exc:
        raise RecapError(f"Discord API request failed: {exc.code} {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RecapError(f"network failure talking to Discord: {exc.reason}") from exc


def _run(args: argparse.Namespace) -> int:
    if not args.repo:
        raise RecapError("--repo or $GITHUB_REPOSITORY is required", code=2)
    gh_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not gh_token:
        raise RecapError("GITHUB_TOKEN (or GH_TOKEN) is required", code=2)

    payload = _gather(str(args.repo), gh_token, int(args.max_prs))
    if payload is None:
        print("No merged PRs yet — nothing to recap.")
        return 0
    if args.dry_run:
        print(json.dumps(payload, indent=2))
        return 0

    _deliver(args.channel_id, payload)
    print(f"Posted Ralph recap to channel {args.channel_id}.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"), help="owner/repo slug")
    parser.add_argument("--channel-id", default=os.environ.get("RALPH_CHANNEL_ID"))
    parser.add_argument("--max-prs", type=int, default=DEFAULT_MAX_PRS)
    parser.add_argument("--dry-run", action="store_true", help="print the embed instead of posting")
    args = parser.parse_args(argv)
    try:
        return _run(args)
    except RecapError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.code


if __name__ == "__main__":
    sys.exit(main())
