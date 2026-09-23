"""The pure rules of beta feedback triage: states, families, fingerprints, drafts.

No session, no FastAPI, no clock. :mod:`services.feedback_triage` is the only
caller that touches the database, and it asks this module every question whose
answer is a rule rather than a row.

**Transitions.** :data:`TRANSITIONS` is the whole state machine, as data. The
forward path is ``new -> triaged -> planned -> closed``; ``new`` and ``triaged``
may also close directly (a report that needs no work, or a duplicate), and a
closed report may be reopened to ``triaged`` -- never straight back to ``new``,
because "an operator has looked at this" is not something that can be unsaid.
Every other pair, including staying put, is refused with one stable code.

**Build family.** Two builds are "the same release line" when they agree on the
first :data:`BUILD_FAMILY_COMPONENTS` dot-separated components once any
pre-release (``-beta``) or build-metadata (``+318``) suffix is removed:
``1.4.2+318`` and ``1.4.9`` are family ``1.4``; ``2026.09.17-beta`` is
``2026.09``. Two components because a patch release rarely changes whether a
bug exists, while a minor one often does.

**Fingerprint.** A read-time digest over category, screen, control and build
family. It is never stored: a stored fingerprint is one more column to migrate
when the family rule changes, and computing it cannot change a report.

**Draft.** :class:`DraftSource` is the allowlist. It has a field for each thing
a GitHub issue may say and no field for anything it may not -- no account id,
and none of the reporter's own words -- so a renderer widened to print either
has nothing to print it from. The operator's text is also passed through
:func:`security.secret_shapes.redact_secret_shapes`, as defence in depth.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from models.feedback import FeedbackReport, FeedbackStatus
from security.secret_shapes import redact_secret_shapes

# ── Transitions ───────────────────────────────────────────────────────────

# The one refusal code for a pair the table does not contain. Stable, because a
# client branches on it, and content-free, because it is an exception message.
TRANSITION_NOT_ALLOWED: Final = "feedback_transition_not_allowed"

TRANSITIONS: Final[Mapping[FeedbackStatus, frozenset[FeedbackStatus]]] = {
    FeedbackStatus.NEW: frozenset({FeedbackStatus.TRIAGED, FeedbackStatus.CLOSED}),
    FeedbackStatus.TRIAGED: frozenset({FeedbackStatus.PLANNED, FeedbackStatus.CLOSED}),
    FeedbackStatus.PLANNED: frozenset({FeedbackStatus.CLOSED}),
    FeedbackStatus.CLOSED: frozenset({FeedbackStatus.TRIAGED}),
}


class TransitionNotAllowedError(ValueError):
    """A status change the transition table does not contain.

    The message is the refusal code and nothing else: a state name is safe, but
    a message that grew to include the report would be the one channel a
    reporter's words could reach Sentry through.
    """

    def __init__(self) -> None:
        """Carry the refusal code as the message, and nothing else."""
        super().__init__(TRANSITION_NOT_ALLOWED)


def check_transition(current: FeedbackStatus, target: FeedbackStatus) -> None:
    """Raise :class:`TransitionNotAllowedError` unless ``current -> target`` is an edge."""
    if target not in TRANSITIONS.get(current, frozenset()):
        raise TransitionNotAllowedError


# ── Build family and fingerprint ──────────────────────────────────────────

BUILD_FAMILY_COMPONENTS: Final = 2

# Everything from the first ``+`` (build metadata) or ``-`` (pre-release) on.
_BUILD_SUFFIX: Final = re.compile(r"[+-].*$")
_COMPONENT_SEPARATOR: Final = "."

# Stands in for a report with no control. A NUL cannot occur in a control token
# (``CONTROL_PATTERN`` admits lowercase, digits, ``_`` and ``.``), so no real
# control -- not even one literally named ``none`` -- can collide with it.
CONTROL_NULL_SENTINEL: Final = "\x00none"
# ASCII unit separator: cannot occur in any input, so ``("a.b", "c")`` and
# ``("a", "b.c")`` can never join to the same string.
_FIELD_SEPARATOR: Final = "\x1f"
FINGERPRINT_HEX_LENGTH: Final = 16


def build_family(app_build: str) -> str:
    """The release line ``app_build`` belongs to; see the module docstring."""
    core = _BUILD_SUFFIX.sub("", app_build)
    return _COMPONENT_SEPARATOR.join(core.split(_COMPONENT_SEPARATOR)[:BUILD_FAMILY_COMPONENTS])


def fingerprint(*, category: str, screen: str, control: str | None, app_build: str) -> str:
    """A short, deterministic digest grouping reports that are probably one problem."""
    parts = (
        category,
        screen,
        CONTROL_NULL_SENTINEL if control is None else control,
        build_family(app_build),
    )
    digest = hashlib.sha256(_FIELD_SEPARATOR.join(parts).encode()).hexdigest()
    return digest[:FINGERPRINT_HEX_LENGTH]


# ── Duplicate cycles ──────────────────────────────────────────────────────

# How far up a chain of "duplicate of" links the cycle check walks. A chain this
# long is a data problem in its own right, so running out of steps is treated
# as a cycle -- refused -- rather than waved through.
MAX_DUPLICATE_CHAIN: Final = 64


def creates_duplicate_cycle(
    source_id: int,
    target_id: int,
    parent_of: Mapping[int, int | None],
) -> bool:
    """Whether marking ``source_id`` a duplicate of ``target_id`` would close a loop.

    Walks up from ``target_id`` through ``parent_of`` (each report's current
    ``duplicate_of_id``). Meeting ``source_id`` on the way -- including at the
    first step, which is a self-link -- is a cycle.
    """
    node: int | None = target_id
    for _ in range(MAX_DUPLICATE_CHAIN):
        if node is None:
            return False
        if node == source_id:
            return True
        node = parent_of.get(node)
    return True


# ── Draft ─────────────────────────────────────────────────────────────────
#
# Owner ruling on #2900 finding [5]: the reporter's words are never published.
# A draft is written to be posted to the project's public issue tracker, so it
# carries the OPERATOR's own title and summary, operator notes the operator
# selects, and a fixed list of non-identifying metadata -- and nothing the
# reporter typed. That rule lives here, in the fields of :class:`DraftSource`,
# rather than in the redactor: a draft cannot publish a field it was never
# given.

# What a draft must never contain, by field name. Asserted disjoint from
# :class:`DraftSource`'s fields. The reporter's four prose fields are here, and
# so is the exact build: the draft carries its family, not the build itself.
FORBIDDEN_DRAFT_FIELDS: Final = frozenset(
    {
        "user_id",
        "email",
        "correlation_id",
        "idem_key",
        "author_admin_id",
        "actor_admin_id",
        "summary",
        "intent",
        "expected",
        "actual",
        "app_build",
    }
)

DRAFT_TITLE_MAX_LENGTH: Final = 120
_ELLIPSIS: Final = "…"
NOT_PROVIDED: Final = "_Not provided._"

_SECTION_SUMMARY: Final = "Summary"
_SECTION_REPRODUCTION: Final = "Reproduction context"
_SECTION_IMPACT: Final = "Impact"
_SECTION_ENVIRONMENT: Final = "Environment"
_SECTION_NOTES: Final = "Operator notes"
_SECTION_SOURCES: Final = "Source references"

# The always-present sections, in the order they are rendered.
DRAFT_SECTIONS: Final = (
    _SECTION_SUMMARY,
    _SECTION_REPRODUCTION,
    _SECTION_IMPACT,
    _SECTION_ENVIRONMENT,
    _SECTION_SOURCES,
)

# The non-identifying metadata a draft carries, as the privacy policy names it.
# ``tests/test_legal_documents.py`` pins the policy's list to this, and this to
# the fields of :class:`DraftSource`.
DRAFT_METADATA_FIELDS: Final = (
    "category",
    "impact",
    "screen",
    "control",
    "build_family",
    "platform",
    "viewport_class",
    "locale",
)


@dataclass(frozen=True)
class OperatorWriting:
    """What the operator wrote for the draft: a title and a summary, in their words."""

    title: str
    summary: str


@dataclass(frozen=True)
class DraftSource:
    """Everything a GitHub issue draft may be built from, and nothing else."""

    public_id: str
    category: str
    impact: str
    screen: str
    control: str | None
    platform: str
    build_family: str
    viewport_class: str
    locale: str | None
    related_public_ids: tuple[str, ...]
    operator_title: str
    operator_summary: str
    notes: tuple[str, ...]

    @classmethod
    def from_report(
        cls,
        report: FeedbackReport,
        *,
        operator: OperatorWriting,
        notes: tuple[str, ...],
        related_public_ids: tuple[str, ...],
    ) -> DraftSource:
        """Copy the allowlisted metadata off ``report``, one named field at a time.

        The report's prose is not read here at all: the only words in a draft are
        ``operator``'s and the selected ``notes``.
        """
        return cls(
            public_id=report.public_id,
            category=report.category,
            impact=report.impact,
            screen=report.screen,
            control=report.control,
            platform=report.platform,
            build_family=build_family(report.app_build),
            viewport_class=report.viewport_class,
            locale=report.locale,
            related_public_ids=related_public_ids,
            operator_title=operator.title,
            operator_summary=operator.summary,
            notes=notes,
        )


@dataclass(frozen=True)
class IssueDraft:
    """A rendered draft: a title, a Markdown body, and the reports it cites."""

    title: str
    markdown: str
    source_public_ids: tuple[str, ...]


def _token(value: str | None) -> str:
    """A metadata token in code style, or the placeholder."""
    return NOT_PROVIDED if value is None else f"`{value}`"


def _title(source: DraftSource) -> str:
    """``[category] operator title``, cut to :data:`DRAFT_TITLE_MAX_LENGTH`."""
    one_line = " ".join(redact_secret_shapes(source.operator_title).split())
    title = f"[{source.category}] {one_line}"
    if len(title) <= DRAFT_TITLE_MAX_LENGTH:
        return title
    return title[: DRAFT_TITLE_MAX_LENGTH - len(_ELLIPSIS)] + _ELLIPSIS


def _section(heading: str, lines: list[str]) -> str:
    return "\n".join([f"## {heading}", "", *lines])


def _reference_lines(cited: tuple[str, ...]) -> list[str]:
    noun = "report" if len(cited) == 1 else "reports"
    return [f"{len(cited)} {noun}:", *(f"- {public_id}" for public_id in cited)]


def render_issue_draft(source: DraftSource) -> IssueDraft:
    """Render ``source`` as a GitHub issue draft. Writes nothing, sends nothing.

    The operator's text is passed through the secret-shape redactor as well --
    defence in depth for what an operator might paste in; the reporter's text
    never arrives here to need it.
    """
    sections = [
        _section(_SECTION_SUMMARY, [redact_secret_shapes(source.operator_summary)]),
        _section(
            _SECTION_REPRODUCTION,
            [f"- Screen: {_token(source.screen)}", f"- Control: {_token(source.control)}"],
        ),
        _section(
            _SECTION_IMPACT,
            [f"- Category: {_token(source.category)}", f"- Impact: {_token(source.impact)}"],
        ),
        _section(
            _SECTION_ENVIRONMENT,
            [
                f"- Platform: {_token(source.platform)}",
                f"- Build family: {_token(source.build_family)}",
                f"- Viewport: {_token(source.viewport_class)}",
                f"- Locale: {_token(source.locale)}",
            ],
        ),
    ]
    if source.notes:
        sections.append(
            _section(_SECTION_NOTES, [f"- {redact_secret_shapes(note)}" for note in source.notes])
        )
    cited = (source.public_id, *source.related_public_ids)
    sections.append(_section(_SECTION_SOURCES, _reference_lines(cited)))
    return IssueDraft(
        title=_title(source),
        markdown="\n\n".join(sections) + "\n",
        source_public_ids=cited,
    )
