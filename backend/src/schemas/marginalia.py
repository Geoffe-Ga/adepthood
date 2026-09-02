"""Response schemas for resonance + marginalia endpoints."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from domain.care import CareKind
from domain.contraction import ContractionVariant
from domain.creek_vault import VaultPraxisKind, VaultPraxisStatus
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


class VoiceDraftResponse(BaseModel):
    """One expanded essay on the Voice Drafts shelf.

    ``essay`` and ``essay_generated_at`` are non-optional here because the
    listing selects only rows where the essay is set, and the
    ``ck_marginalia_essay_timestamp_paired`` CHECK keeps the two columns set
    together — so the type restates the WHERE clause and a leaked unexpanded
    row fails loudly as a response-validation error rather than silently.

    The note's surrogate key is named ``marginalia_id`` rather than ``id`` so a
    client holding a draft can address the note it came from.  ``user_id`` is
    excluded for the reason given on :class:`MarginaliaResponse`.
    """

    marginalia_id: int
    journal_entry_id: int
    kind: MarginaliaKind
    anchor_text: str
    essay: str
    essay_generated_at: datetime


class VoiceDraftListResponse(BaseModel):
    """One page of the Voice Drafts shelf, with its total and a next-page flag."""

    items: list[VoiceDraftResponse]
    total: int
    has_more: bool


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

    variant: ContractionVariant
    message: str


class RelatedPraxisResponse(BaseModel):
    """One praxis page from the writer's own vault that this entry contributed to.

    Mirrors :class:`domain.creek_vault.VaultRelatedPraxis`. It is the writer's
    own compiled page — a title, which of the five kinds it is, where it sits in
    its lifecycle, and the page's own opening prose — never a model summary and
    never anything adepthood derived. Present only when a connected vault
    surfaced it on this pass.
    """

    title: str
    praxis_type: VaultPraxisKind
    status: VaultPraxisStatus
    excerpt: str


class RelatedEddyResponse(BaseModel):
    """One eddy — a cluster of the writer's own fragments — this entry belongs to.

    Mirrors :class:`domain.creek_vault.VaultRelatedEddy`. ``description`` may be
    the empty string for a cluster that declares none, ``fragment_count`` is how
    many fragments it gathers, and ``formed`` is the ``YYYY-MM-DD`` the vault
    first detected it.
    """

    title: str
    description: str
    fragment_count: int
    formed: str


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

    ``no_notes_message`` is the sentence the writer reads when the pass produced
    no margin notes at all — set whenever ``marginalia`` is empty on a pass that
    actually ran, and ``None`` otherwise (including for the ``private`` path,
    which carries its own copy). It is the server's own wording rather than a
    flag the client interprets, because only the server knows *which* of the
    several ways to arrive at zero notes actually happened, and a client
    inventing a second explanation would be guessing at a cause it cannot see.

    ``related_praxis`` and ``related_eddies`` are the writer's own compiled vault
    pages this entry touched — surfaced only when a connected vault answered the
    reflection, and empty on every other path (no vault, a vault that degraded or
    deferred to the cloud, the private/intimate floor, the care short-circuit).
    Empty rather than absent, so a client never has to tell "this server does not
    send them" apart from "this pass surfaced none". Both are bounded at the
    seam that reads them, so the margin stays a note rather than a dashboard.
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
    no_notes_message: str | None = None
    related_praxis: list[RelatedPraxisResponse] = []
    related_eddies: list[RelatedEddyResponse] = []


class MarginaliaListResponse(BaseModel):
    """All marginalia for an entry (active + stale)."""

    items: list[MarginaliaResponse]
