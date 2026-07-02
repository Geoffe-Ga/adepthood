"""Response schemas for resonance + marginalia endpoints."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from domain.care import CareKind
from models.marginalia import MarginaliaKind, MarginaliaStatus
from schemas.completion_suggestion import CompletionSuggestionResponse


class MarginaliaResponse(BaseModel):
    """A single margin note returned to clients.

    ``user_id`` is intentionally excluded — the client already knows its own
    identity and exposing surrogate keys aids enumeration (mirrors the journal
    entry response).
    """

    id: int
    journal_entry_id: int
    kind: MarginaliaKind
    anchor_start: int
    anchor_end: int
    anchor_text: str
    note: str
    essay: str | None
    essay_generated_at: datetime | None
    status: MarginaliaStatus
    created_at: datetime
    updated_at: datetime


class CareResourceResponse(BaseModel):
    """One non-clinical support pointer in the care surface.

    Mirrors :class:`domain.care.CareResource`: a routing ``kind``, a name, how to
    reach it, and what it is. Carries no diagnosis or medication guidance.
    """

    kind: CareKind
    name: str
    contact: str
    what_it_is: str


class CareResponse(BaseModel):
    """The care surface returned when an entry screens as acute distress.

    A warm, non-shaming message plus structured human + professional support
    pointers (NORTH-STAR §10). Present only on an elevated signal; ``None`` on
    every ordinary entry. It accompanies the reflection — never replaces it — so
    a distressed person is never left alone with only AI-generated text.
    """

    message: str
    resources: list[CareResourceResponse]


class ContractionReflectionResponse(BaseModel):
    """A warm, declinable Higher Self reflection naming a foundation's contraction.

    Mirrors :class:`domain.contraction.ContractionInvitation`: a ``variant`` drawn
    from ``ContractionVariant`` and the deterministic ``message`` for it. Never a
    demotion, never a broken-streak notice — a gentle naming that honors "you
    choose your depth." Present only when a sustained contraction is detected.
    """

    variant: str
    message: str


class ResonanceResponse(BaseModel):
    """Result of a resonance pass: the new notes plus refreshed wallet balances.

    ``suggestions`` carries any completion suggestions detected on the same pass
    (additive, best-effort — empty when none are found or detection failed).

    ``care`` is ``None`` for an ordinary entry (no behavior change); on an acute
    -distress signal it carries the human + professional support surface, which
    accompanies — never replaces — the reflection (NORTH-STAR §10). It is derived
    only from the entry being processed, so it can never leak across users.

    ``private`` is ``True`` only for an ``intimate`` entry (issue #895): such an
    entry is never sent to a cloud LLM, so no marginalia/suggestions are produced
    and ``private_message`` carries the non-shaming explanation. Both fields are
    defaulted, so every existing (public/personal) response is byte-for-byte
    unchanged.

    ``contraction`` is ``None`` for a healthy or new user; on a sustained thinning
    of the habit foundation it carries a warm, declinable reflection. It is
    computed locally (no LLM) and has zero side effects on progression, and — like
    ``care`` / ``private`` — is defaulted so every existing response is unchanged.
    """

    marginalia: list[MarginaliaResponse]
    suggestions: list[CompletionSuggestionResponse] = []
    remaining_messages: int
    remaining_balance: int
    monthly_reset_date: datetime
    care: CareResponse | None = None
    private: bool = False
    private_message: str | None = None
    contraction: ContractionReflectionResponse | None = None


class MarginaliaListResponse(BaseModel):
    """All marginalia for an entry (active + stale)."""

    items: list[MarginaliaResponse]
