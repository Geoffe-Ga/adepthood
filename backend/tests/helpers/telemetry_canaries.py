"""Synthetic content canaries for the content-free-telemetry invariant (#3064).

Each canary stands in for something a user wrote. Every telemetry sink --
the Sentry envelope, the root log stream, the access log -- is asserted to carry
none of them, whatever shape the content arrives in. Kept in one importable
module so the standing privacy regression suite (#3069) can reuse the set.

None of these is real content: each is synthetic and carries a fixed
``SYNTHETIC`` prefix, so a canary that ever did reach a real vendor would be
recognisable as a test artefact, never as a user's words.
"""

from __future__ import annotations

import json
from typing import Final

# Long enough to clear any truncation cap a sink might apply, so a cap cannot
# make the absence assertion pass by accident.
_LONG_CANARY_REPEAT: Final = 600

SHORT_CANARY: Final = "SYNTHETIC_JOURNAL_CANARY_20261005"

SENTINELS: Final[tuple[str, ...]] = (
    SHORT_CANARY,
    "SYNTHETIC_LONG_CANARY_" + "x" * _LONG_CANARY_REPEAT,
    # Combining marks and CJK: an escaping layer must not let these through
    # in a form the plain-text assertion misses.
    "SYNTHETIC_UNICODE_CANARY_üńi_日本語",
    "SYNTHETIC_MULTILINE_CANARY line one\nline two\r\nline three",
    "SYNTHETIC_RTL_CANARY שלום مرحبا",
    "SYNTHETIC_EMOJI_CANARY \U0001f56f️\U0001f9e1",
)

SENTINEL_IDS: Final[tuple[str, ...]] = ("short", "long", "unicode", "multiline", "rtl", "emoji")

# Characters of a canary that must not appear: enough to be unmistakable, few
# enough that a sink truncating the value still cannot hide the prefix.
_PROBE_CHARS: Final = 40


def probes(canary: str) -> list[str]:
    """Return the fragments whose presence anywhere means the canary leaked.

    One probe per line of the canary (a sink may split on newlines), in both
    the raw form and the JSON-escaped form a serialiser would write.
    """
    fragments: list[str] = []
    for line in canary.splitlines():
        head = line.strip()[:_PROBE_CHARS]
        if head:
            fragments.append(head)
            fragments.append(json.dumps(head)[1:-1])
    return fragments


def assert_no_canary(blob: str, canary: str) -> None:
    """Fail when any fragment of ``canary`` appears in ``blob``."""
    leaked = [fragment for fragment in probes(canary) if fragment in blob]
    assert not leaked, f"telemetry carried user content: {leaked!r}"
