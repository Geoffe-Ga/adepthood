"""Response schemas for resonance + marginalia endpoints."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field

from domain.care import CareKind
from domain.contraction import ContractionVariant
from domain.creek_vault import VaultPraxisKind, VaultPraxisStatus
from models.marginalia import (
    InferenceProvider,
    MarginaliaKind,
    MarginaliaSource,
    MarginaliaStatus,
)
from schemas.completion_suggestion import CompletionSuggestionResponse


class OperationSource(StrEnum):
    """Which side answered one operation of a pass, as a response reports it (#3062).

    The persisted :class:`~models.marginalia.MarginaliaSource` values, plus
    ``none``: the operation was not run at all (detection with no candidates,
    or under a vault-bound boundary). ``none`` is a fact about this pass and is
    never stored, so it can never be mistaken for a row whose source was not
    recorded.
    """

    CREEK_VAULT = MarginaliaSource.CREEK_VAULT.value
    APP_PROVIDER = MarginaliaSource.APP_PROVIDER.value
    DEMO = MarginaliaSource.DEMO.value
    NONE = "none"


class MarginaliaResponse(BaseModel):
    """A single margin note returned to clients.

    ``user_id`` is intentionally excluded — the client already knows its own
    identity and exposing surrogate keys aids enumeration (mirrors the journal
    entry response).

    The provenance fields (#3062) are the server's record of which side answered
    the note (``source``) and its letter (``essay_source``), stamped when they
    were written. Every one is ``None`` on a row written before receipts
    existed -- "source not recorded" -- and none is ever inferred from the
    account's current vault connection. ``source_model`` is the answering
    side's own report, never an attestation.
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
    source: MarginaliaSource | None = None
    source_provider: InferenceProvider | None = None
    source_model: str | None = None
    essay_source: MarginaliaSource | None = None
    receipt_version: int | None = None


class EssayRequest(BaseModel):
    """Optional body for ``POST /journal/marginalia/{id}/essay`` (#623).

    ``price_acknowledged`` is the client saying "the writer saw the price and
    asked". A server-paid first letter costs one wallet unit, and the in-repo
    rule is that a charged depth is offered with its price on it -- so the
    server refuses to charge without it rather than trusting every installed
    client to have stopped asking on open. Cached, BYOK and intimate requests
    are never charged and need no body at all.
    """

    price_acknowledged: bool = False


class EssayResponse(MarginaliaResponse):
    """A margin note after an essay request, plus the wallet it left behind.

    The balances mirror :class:`ResonanceResponse` so a client reads one shape
    for "what this cost me" on both charged journal depths. They sit on a
    subclass rather than on :class:`MarginaliaResponse` itself so note listings
    do not grow a wallet read per row.
    """

    remaining_messages: int
    remaining_balance: int
    monthly_reset_date: datetime


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
    # Which side wrote the letter (#3062); ``None`` when it was not recorded.
    essay_source: MarginaliaSource | None = None


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

    A short heading (``title``), a warm, non-shaming message, and structured
    human + professional support pointers (NORTH-STAR §10). Present only on an
    elevated signal; ``None`` on every ordinary entry. It accompanies the
    reflection — never replaces it — so a distressed person is never left alone
    with only AI-generated text.
    """

    title: str = Field(min_length=1)
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


class ProvenanceReceipt(BaseModel):
    """Which side answered one operation of a resonance pass (#3062).

    Closed vocabulary throughout except ``model``, the answering side's own
    report of itself. ``source`` is ``none`` when the operation was not run.
    """

    source: OperationSource
    provider: InferenceProvider | None = None
    model: str | None = None
    receipt_version: int


class PassProvenance(BaseModel):
    """Who answered each operation of a resonance pass, and who paid for it (#3062).

    ``notes`` is the reflection -- including one that answered with nothing, so
    an empty pass still says which source was empty. ``detection`` is the
    completion check, with ``detection_checked`` saying whether it actually
    returned. ``paid_by`` is ``free`` for a demo and for a refunded empty pass,
    ``own_key`` when the caller's key paid, and ``wallet`` when the deduction
    stands.
    """

    notes: ProvenanceReceipt
    detection: ProvenanceReceipt
    detection_checked: bool
    paid_by: Literal["own_key", "wallet", "free"]


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

    ``provenance`` says which side answered each operation of the pass and who
    paid (#3062). ``None`` on the private and care-only paths, where no
    operation ran.
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
    provenance: PassProvenance | None = None


class MarginaliaListResponse(BaseModel):
    """All marginalia for an entry (active + stale)."""

    items: list[MarginaliaResponse]
