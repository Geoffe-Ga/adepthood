"""Whether to offer the corpus decision at the Resonance moment (#2407).

The corpus is opt-in and, until this, nothing outside Settings ever said it
existed. The owner ruling of 2026-09-05 fixed where and how often it may be
mentioned: **after the first completed Resonance pass**, on an account that has
never decided; on a plain "Not now", **again only after both** a cooldown in
days and a count of further completed passes; **never again** once consent is
decided either way or "Do not ask again" is chosen. NORTH-STAR §6 is the reason
for the shape -- an invitation is one-tap declinable, never repeats nagging,
and never frames declining as failure -- and this module is where that shape is
a function rather than a hope.

**Why this is not a ``ConsentDecision``.** ADR 0005 Decision 5 makes consent an
auditable event with two values, and :class:`models.corpus_consent.ConsentDecision`
says "two values and no third" because a pending state stored as a decision is
a state something can accidentally treat as permission. Setting the invitation
aside is not a decision about the corpus at all: it is a decision about being
*asked*, and it changes nothing about what is ontologized. So it lives in its
own record (:class:`models.corpus_invitation_state.CorpusInvitationState`) and
the consent log stays exactly as ADR 0005 and ADR 0006 left it.

Pure by design: no session, no I/O, no clock. The caller gathers the facts and
hands in ``now``; this is a deterministic map from a value object to a boolean.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final

from domain.dates import ensure_aware

#: How many completed passes an undecided account has before it is asked at
#: all. One: the ruling names the *first* completed pass as the moment.
FIRST_OFFER_AFTER_PASSES: Final[int] = 1

#: The least time a plain "Not now" is respected for. Seven days, per the
#: ruling; the passes floor below has to be met as well, not instead.
REOFFER_MIN_DAYS: Final[int] = 7

#: The fewest further completed passes a plain "Not now" is respected for.
#: Three, per the ruling; both floors together mean a person who journals daily
#: and one who journals monthly are each left alone for a stretch that is real
#: on their own scale.
REOFFER_MIN_PASSES: Final[int] = 3


@dataclass(frozen=True)
class InvitationFacts:
    """Everything the rule needs, already read.

    ``consent_decided`` is ``decided_at is not None`` on the journal source's
    consent state -- a grant *or* a dated refusal. ``passes_at_dismissal`` is
    the pass count at the instant of the most recent "Not now", so the further
    passes since are a subtraction rather than a second counter.
    """

    consent_decided: bool
    completed_passes: int
    dismissed_at: datetime | None
    passes_at_dismissal: int
    do_not_ask_again: bool


def _cooldown_elapsed(facts: InvitationFacts, dismissed_at: datetime, now: datetime) -> bool:
    """Both halves of the ruling's cooldown, and only both."""
    days_ok = now - ensure_aware(dismissed_at) >= timedelta(days=REOFFER_MIN_DAYS)
    passes_ok = facts.completed_passes - facts.passes_at_dismissal >= REOFFER_MIN_PASSES
    return days_ok and passes_ok


def should_offer(facts: InvitationFacts, *, now: datetime) -> bool:
    """Whether the invitation may be shown to this account right now.

    Silence is the default and every early return below is a reason for it: no
    pass yet, a decision already on the record, a standing "Do not ask again",
    or a "Not now" still inside its cooldown. Only an undecided account that has
    completed a pass, and either was never asked or has waited out both floors,
    is offered anything.
    """
    if facts.completed_passes < FIRST_OFFER_AFTER_PASSES:
        return False
    if facts.consent_decided or facts.do_not_ask_again:
        return False
    if facts.dismissed_at is None:
        return True
    return _cooldown_elapsed(facts, facts.dismissed_at, now)
