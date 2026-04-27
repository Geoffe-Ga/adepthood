r"""Boundary helper for free-text user input — strip dangerous code points.

The fix for stored-XSS and prompt-injection lives at *insertion* time, not at
*render* time.  Applying :func:`sanitize_user_text` once when text enters the
system means every downstream sink (DB row, LLM prompt, log line) sees a
normalized value.  Render-time escaping is still required for HTML but is the
job of the UI; this module deliberately does **not** HTML-escape so legitimate
characters (``<``, ``&``, quotes) survive into the journal as the user typed
them.

The helper strips three classes of input:

* **C0 controls** (``0x00``-``0x1F``) except ``\t`` / ``\n`` / ``\r`` —
  null bytes truncate C strings, vertical tab and form feed break log
  parsers, ESC enables ANSI escape attacks in terminal log viewers.
  ``\t`` / ``\n`` / ``\r`` are kept because journal entries legitimately
  contain newlines and tabs.
* **DEL** (``0x7F``) — invisible, easily smuggled past visual review.
* **Zero-width and bidirectional override codepoints** (``U+200B``-``U+200F``,
  ``U+202A``-``U+202E``, ``U+2060``-``U+206F``, ``U+FEFF``) — invisible
  characters used for visual spoofing (Trojan Source) and ``RIGHT-TO-LEFT
  OVERRIDE`` attacks that flip rendered text direction.

It also normalises to NFC so combining-character variants (e.g. ``e`` plus
combining-acute vs. precomposed ``é``) hash and compare identically downstream.

The function is intentionally **idempotent** — running it twice yields the same
output as running it once.  Callers can therefore wrap a value at the router
*and* the service layer without double-stripping risk.

Implementation note: the regex character class for invisible codepoints is
constructed via ``\u`` escapes rather than literal characters so the source
file itself contains no bidirectional / zero-width control characters
(satisfies bandit ``B613`` Trojan-Source detection).
"""

from __future__ import annotations

import re
import unicodedata

# Default maximum length matches the schema-level Pydantic constraints (10k
# chars).  Callers that need a smaller cap (e.g. usernames) override via the
# ``max_len`` keyword.
DEFAULT_MAX_TEXT_LENGTH = 10_000

# Non-printing C0 controls that are *never* legitimate in user free-text.  We
# preserve ``\t`` (0x09), ``\n`` (0x0A), and ``\r`` (0x0D) because journal
# entries legitimately contain whitespace.  Everything else in the C0 range —
# null bytes (0x00), bell (0x07), backspace (0x08), vertical tab (0x0B), form
# feed (0x0C), shift-out (0x0E), ESC (0x1B), etc. — is stripped.  DEL (0x7F)
# joins the set because it is invisible and only ever indicates either an
# encoding bug or a deliberate smuggling attempt.
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]")

# Zero-width and bidirectional-override codepoints.  These are invisible to
# the eye (and thus to a human reviewer) but break log parsers, identifier
# comparisons, and rendered output:
#   * U+200B-U+200F — zero-width space, joiners, LRM/RLM directional marks
#   * U+202A-U+202E — explicit directional formatting (LRE, RLE, PDF, LRO,
#     RLO).  RLO in particular is the "Trojan Source" attack that flips
#     rendered string direction without changing the underlying bytes.
#   * U+2060-U+206F — word joiner, function application, invisible math ops,
#     and four reserved deprecated formatting codes.
#   * U+FEFF — BOM / zero-width no-break space when not at file start.
#
# The pattern is built from ``\u``-escaped range strings so the source file
# itself contains no invisible codepoints (Trojan-Source defense).
_ZERO_WIDTH_RANGES = (
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x206F),
    (0xFEFF, 0xFEFF),
)
_ZERO_WIDTH = re.compile(
    "[" + "".join(f"{chr(lo)}-{chr(hi)}" for lo, hi in _ZERO_WIDTH_RANGES) + "]"
)


class TextTooLongError(ValueError):
    """Raised when sanitized text exceeds ``max_len`` characters.

    Subclassed from :class:`ValueError` so callers that already catch
    ``ValueError`` (Pydantic validators, FastAPI's request-validation layer)
    keep working without changes.  The dedicated subclass lets specialised
    handlers distinguish length overflow from other validation failures.
    """


def sanitize_user_text(
    text: str,
    *,
    max_len: int = DEFAULT_MAX_TEXT_LENGTH,
) -> str:
    r"""Return ``text`` normalized to NFC with control / zero-width chars stripped.

    Steps, in order, are deterministic so the result is identical regardless
    of how the input was constructed:

    1. NFC-normalize so combining-character variants collapse to canonical
       form (downstream string comparisons work consistently).
    2. Strip C0 controls and DEL, preserving ``\t`` / ``\n`` / ``\r``.
    3. Strip zero-width / bidirectional-override codepoints.
    4. Strip leading and trailing whitespace.  This happens **after** the
       control-char strip so a string like ``"  \x00  hello  "`` becomes
       ``"hello"`` rather than ``" hello "``.
    5. Enforce the length cap.

    The helper is pure (no side effects) and idempotent — applying it twice
    is the same as applying it once, which lets routers and services both
    invoke it without coordination.

    Raises:
        TypeError: if ``text`` is not a ``str``.  The fail-fast TypeError keeps
            ``None`` and other non-strings from being silently coerced.
        TextTooLongError: when the *sanitized* length exceeds ``max_len``.
            Length is measured after stripping so a payload that fits inside
            the cap purely because of stripped padding is still accepted.
    """
    if not isinstance(text, str):
        msg = f"sanitize_user_text expected str, got {type(text).__name__}"
        raise TypeError(msg)
    cleaned = unicodedata.normalize("NFC", text)
    cleaned = _CONTROL_CHARS.sub("", cleaned)
    cleaned = _ZERO_WIDTH.sub("", cleaned)
    cleaned = cleaned.strip()
    if len(cleaned) > max_len:
        msg = f"text exceeds {max_len} chars after sanitization"
        raise TextTooLongError(msg)
    return cleaned
