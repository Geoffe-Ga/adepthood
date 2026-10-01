"""What the voice-readiness surface answers, and the sentence each answer carries.

Three states rather than a boolean, because there are two genuinely different
ways to not be ready and they have opposite remedies. An account that has
agreed to have its journal sorted and simply has not written much yet is
*early*: time and imported writing both move it. An account that has not agreed
is not early at all —
:data:`services.corpus_consent.CONSENT_GRANTED_BY_DEFAULT` is ``False`` and
:func:`services.corpus_ingest.ingest_journal_entry` returns before it
classifies anything, so that account can write every day for a year and hold a
corpus of nothing. Collapsing the two would produce a signal whose stated
remedy does not work, on the majority of accounts, permanently.

The copy is the server's, following the ``no_notes_message`` precedent in
:mod:`schemas.marginalia`: only the server knows which of the several ways to
arrive at "not ready" actually happened, and a client inventing a second
explanation would be guessing at a cause it cannot see.

The payload carries counts and a source and nothing else. No fragment text, no
fragment ids, no titles, no excerpts — a readiness signal is a fact *about* a
corpus, and there is no version of this question whose honest answer quotes the
writing back.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from types import MappingProxyType

from pydantic import BaseModel, Field

from services.higher_self_grounding import GroundingSource


class VoiceReadinessState(StrEnum):
    """How far along one account's own corpus is, in the three ways it can be.

    ``READY`` is a real member rather than the absence of the other two, so
    every consumer branches on one vocabulary and the ``ready`` boolean stays a
    projection of this rather than a second, independently-drifting source of
    truth.
    """

    NOT_CONSENTED = "not_consented"
    GATHERING = "gathering"
    READY = "ready"


#: What each state tells the person, or ``None`` when the honest answer is
#: silence. ``NOT_CONSENTED`` names the decision and never an accelerator that
#: account cannot act on; ``GATHERING`` names the one accelerator that is true
#: for an account whose journal *is* being sorted. ``READY`` says nothing at
#: all — an absent signal is the norm, not a deficiency
#: (:mod:`domain.invitations`), and a band that congratulated somebody for
#: arriving would be the gamification NORTH-STAR §5 forbids.
#:
#: Entries, not days: the fallback is the last ``GROUNDING_LIMIT`` entries, not
#: a span of time. ``NOT_CONSENTED`` embeds the client's ``HIGHER_SELF_GAIN``
#: (``frontend/src/features/Settings/higherSelfCopy.ts``) word for word, so the
#: band and Settings say the same thing about the decision; a frontend test
#: reads this literal and fails if the two drift. ``GATHERING`` says how little
#: is sorted rather than "recent entries for now", because the corpus answers a
#: reflection as soon as it holds a single passage.
VOICE_READINESS_MESSAGES: Mapping[VoiceReadinessState, str | None] = MappingProxyType(
    {
        VoiceReadinessState.NOT_CONSENTED: (
            "Right now your reflections are drawn from your last few entries. "
            "Sorting is a separate decision, yours to make whenever you like. "
            "Say yes to sorting, and everything you write here, apart from Intimate entries and "
            "including what you have already written, is sorted by Aspect. Each reflection from "
            "your Higher Self can then draw on a few of those passages, leaning toward where you "
            "stand in the course, rather than only on your last few entries. "
            "Perfectly fine to leave as it is."
        ),
        VoiceReadinessState.GATHERING: (
            "Your corpus is still filling out, so for now your reflections have little or no "
            "sorted writing to draw on. Bringing in work you did elsewhere fills it faster. "
            "Nothing is waiting on you."
        ),
        VoiceReadinessState.READY: None,
    }
)


class VoiceReadinessResponse(BaseModel):
    """Whether this account's reflections are drawn from its corpus yet.

    ``ready`` is redundant with ``state`` on purpose: it is the one field every
    client actually branches on, and deriving it once on the server is what
    keeps three surfaces from each re-deciding which states count as ready.

    ``grounding_source`` is *reporting*, not the readiness rule. It says which
    source a reflection would draw on right now; readiness is decided by the
    fragment count against
    :data:`services.voice_readiness.VOICE_READY_FRAGMENT_THRESHOLD` alone.
    """

    ready: bool
    state: VoiceReadinessState
    message: str | None
    grounding_source: GroundingSource
    classified_fragment_count: int = Field(ge=0)
