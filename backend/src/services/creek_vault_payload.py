"""Reading what a Creek Vault answered: bounds, tier echoes, and the reflection document.

The pure half of the vault seam's read paths, split out of
:mod:`services.creek_vault_client` so the adapters there are left holding
transports, sessions, and a connection pool while the *rules* for reading an
untrusted answer live in one place with no I/O in sight. Nothing here opens a
socket, touches a session, or holds a credential; every function takes a value a
vault already sent and answers with something adepthood is willing to render.

Three concerns, and they belong together because each is a different half of the
same sentence "this answer is safe to use":

* **Bounds and projection.** :func:`_bounded_text` and the note helpers turn
  Creek's margin notes into adepthood's marginalia vocabulary, dropping whatever
  does not survive on its own terms rather than completing it with a default that
  would put words in the user's Higher Self neither they nor the vault wrote.
* **Tier echoes.** The ratified ``/v1`` surface publishes no way to *declare* a
  privacy ceiling, so :func:`_admissible_ceiling` verifies the one a vault says
  it applied. An answer computed above the ceiling adepthood was willing to
  accept was drawn from material this app never authorized, and is refused whole.
* **The reflection document.** :func:`_parse_reflection_result` is the one place
  the ratified ``/v1`` reflection body is read. It was written to be the single
  parser two transports shared; only the HTTP one remains, so it is now simply
  the only reading of that shape there is -- which is the same guarantee arrived
  at from the other side, since a second reading is how two readings of one
  reflection come to disagree.

Every message this module can raise with is built by :func:`_capability_message`
from a closed set of our own prefixes plus a
:class:`~domain.creek_vault.CreekCapability` wire name, so no branch can
interpolate the entry body, the credential, or a vault-chosen string into text
that reaches a log or a traceback. That is a property of construction rather than
of remembering to redact.

Cross-references ``docs/creek-vault-mcp-contract.md``; Creek's published contract
owns the wire shapes.
"""

from __future__ import annotations

from collections.abc import Mapping

from domain.creek_vault import (
    CreekCapability,
    CreekVaultCareEscalationError,
    CreekVaultPayloadError,
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
)
from domain.resonance import ANCHOR_TEXT_MAX, NOTE_MAX

# The status a reflection response reports when it is a care handoff rather than
# a reflection. Creek publishes it as a ``const`` on its own ``CareEscalationResponse``
# document, so it is not a member of :class:`VaultReflectionStatus` -- it is a
# different published shape arriving at the same 200, and it is matched here as a
# raw wire string before anything else in the body is read.
_REFLECT_ESCALATE_STATUS = "escalate"

# The published top-level fields of ``ReflectionResponse``, in the order Creek's
# schema declares them ``required``. Presence is checked before anything is
# projected, so a body missing one is refused rather than completed with a
# default the vault never sent.
_REFLECTION_RESPONSE_REQUIRED_FIELDS = (
    "status",
    "tier_ceiling",
    "routed_tier",
    "notes",
    "essay_grounded",
)

# How many notes adepthood asks a ratified ``/v1`` reflection for: the largest
# budget the published request schema admits. Asking for the maximum is right
# because adepthood drops non-anchoring quotes on its own side -- a note whose
# quote is not verbatim in the entry never renders -- so a small budget would
# spend the vault's whole allowance on notes that may not survive. It is a
# request-side ceiling and nothing else: :data:`_MAX_REFLECT_NOTES` still bounds
# what is read back out of whatever the vault actually answers, and neither one
# substitutes for the other.
_REQUESTED_NOTE_BUDGET = 10

# How many notes of a reflect response adepthood will even look at. Double
# Creek's own shipped cap of six, so a vault that modestly raises its cap still
# lands whole, while a buggy or hostile one is bounded to roughly twelve times
# (:data:`~domain.resonance.ANCHOR_TEXT_MAX` + :data:`~domain.resonance.NOTE_MAX`)
# plus JSON overhead -- about 12 KB serialized -- instead of however much it
# cares to answer with. This is a bound on *untrusted vault output before
# serialization*, independent of the separate anchoring cap
# :mod:`domain.resonance` applies to how many of these notes survive onto the
# entry; neither one substitutes for the other.
_MAX_REFLECT_NOTES = 12

# How Creek's seven published note kinds render in adepthood's marginalia
# vocabulary. ``pattern`` is the one that speaks across entries -- Creek grounds
# its notes in the surrounding corpus, so a recurrence note is exactly what
# adepthood calls a ``connection`` -- while the other six each observe something
# about this one entry and so render as a ``theme``. Adepthood's third kind,
# ``symbol``, is deliberately unused: nothing in Creek's vocabulary denotes an
# image standing for something else, and forcing a non-symbol onto it would
# render the note as something it is not. A kind absent from this table is
# dropped, never coerced onto a nearest neighbor.
_MARGINALIA_KIND_BY_CREEK_KIND: Mapping[str, str] = {
    "pattern": "connection",
    "reframe": "theme",
    "fear": "theme",
    "longing": "theme",
    "value": "theme",
    "tension": "theme",
    "gift": "theme",
}

# Tier ceilings ranked by how much material they admit; each rank includes
# everything below it, so a larger rank is a wider ceiling. Used to compare an
# echoed ceiling against one we were willing to accept, which is a comparison a
# plain enum cannot make.
_TIER_CEILING_RANK: Mapping[VaultTierCeiling, int] = {
    VaultTierCeiling.OPEN: 0,
    VaultTierCeiling.PERSONAL: 1,
    VaultTierCeiling.INTIMATE: 2,
}

# The four things that can go wrong with one vault call, as message prefixes. A
# closed set of our own literals: they are the whole variable part of every
# exception this module raises, and keeping them here is what makes it checkable
# at a glance that no branch interpolates the entry body, the API key, or a
# vault-supplied string into text that will reach a log or a traceback.
_CALL_FAILED = "creek vault call failed"
_REQUEST_REJECTED = "creek vault rejected the request"
_CREDENTIAL_REJECTED = "creek vault rejected the credential"
_RESPONSE_UNREADABLE = "creek vault returned an unreadable response"


def _capability_message(prefix: str, capability: CreekCapability) -> str:
    """Build one static failure message naming a capability by its wire name.

    The name is taken from :class:`~domain.creek_vault.CreekCapability` rather
    than written as a literal so a message can never drift from the wire name it
    reports, and both halves are ours: nothing a vault sent can reach the result.
    """
    return f"{prefix}: {capability.value}"


_REFLECT_UNREADABLE_MESSAGE = _capability_message(_RESPONSE_UNREADABLE, CreekCapability.REFLECT)


def _bounded_text(raw: object, limit: int) -> str | None:
    """Return a vault-supplied string when it is usable text within ``limit``, else ``None``.

    Three conditions, each of which a note cannot do without: it is a string at
    all (a number or a nested object is not text), it carries something other
    than whitespace (a blank quote anchors to nothing and a blank note says
    nothing), and it fits the marginalia field it is bound for, so no vault can
    answer with an unbounded string. The value is returned **verbatim** rather
    than stripped, because adepthood anchors a quote by matching it
    character-for-character against the entry body -- trimming here would
    silently break the very anchor this check exists to protect.
    """
    if not isinstance(raw, str) or not raw.strip() or len(raw) > limit:
        return None
    return raw


def _marginalia_kind(raw: object) -> str | None:
    """Map one Creek note kind onto adepthood's, or ``None`` when we do not know it.

    Mirrors :func:`_coerce_capability` and :func:`_coerce_ingest_action`: an
    unknown or wrong-typed kind is dropped rather than raising or being coerced
    onto a neighbor, so a vault that invents a kind loses that one note instead
    of having it rendered as something the user never wrote.
    """
    if not isinstance(raw, str):
        return None
    return _MARGINALIA_KIND_BY_CREEK_KIND.get(raw)


def _reflection_note(item: object) -> dict[str, str] | None:
    """Project one Creek note onto the marginalia contract, or drop it whole.

    This is the boundary where an untrusted vault's output becomes something
    adepthood renders back to the user, so every field has to survive on its own
    terms: a mappable kind, a quote within
    :data:`~domain.resonance.ANCHOR_TEXT_MAX`, a note within
    :data:`~domain.resonance.NOTE_MAX`. A partial note is dropped rather than
    completed with a default, which would put words in the user's Higher Self
    that neither they nor the vault ever wrote.
    """
    if not isinstance(item, Mapping):
        return None
    kind = _marginalia_kind(item.get("kind"))
    quote = _bounded_text(item.get("quote"), ANCHOR_TEXT_MAX)
    note = _bounded_text(item.get("note"), NOTE_MAX)
    if kind is None or quote is None or note is None:
        return None
    return {"kind": kind, "quote": quote, "note": note}


def _reflection_notes(raw: object) -> list[dict[str, str]]:
    """Narrow a vault's note list to the ones adepthood can actually render.

    Answers with an empty list -- never raises -- for anything that is not a
    list, since a malformed reflection must defer to the cloud rather than break
    the resonance pass. Only the leading :data:`_MAX_REFLECT_NOTES` items are
    considered, order preserved, so an over-eager or hostile vault cannot grow
    this work (or the JSON it feeds) without bound; inside that prefix each item
    stands or falls alone, so one malformed note never costs its siblings.
    """
    if not isinstance(raw, list):
        return []
    return [
        note for item in raw[:_MAX_REFLECT_NOTES] if (note := _reflection_note(item)) is not None
    ]


def _admissible_ceiling(echoed: object, accepted: VaultTierCeiling) -> VaultTierCeiling | None:
    """Return a vault's echoed tier ceiling when we were willing to accept it, else ``None``.

    Verification stands in for declaration here, because the ratified ``/v1``
    surface gives adepthood no way to declare a ceiling at all: ``ReflectionRequest``
    is ``additionalProperties: false`` with no such field, and ``GET /v1/wheel``
    publishes no parameter. Inventing an undocumented query parameter or header
    would be guessing at a contract -- the same reason
    :func:`_journal_entry_body` sends only the three ratified fields and no
    fourth. So the server applies its own published default (``open``, the most
    restrictive of the two a remote caller may reach, which fails closed) and
    adepthood checks the ceiling it says it applied.

    That check is not a formality. An answer echoing a ceiling *above* the one
    adepthood was willing to accept says the vault worked over material this app
    never authorized it to read, and an answer computed over unauthorized material
    is not one this app may render -- so the whole payload is rejected. An echo
    that will not parse as a tier at all is equally inadmissible: an unreadable
    claim is not a claim, and accepting one would make the check passable by
    answering with nonsense. A wrong-typed echo is narrowed out first, mirroring
    :func:`_coerce_capability` and :func:`_coerce_error_code`: every value this
    module reads out of a vault body is proved to be a string before it is looked
    up.

    The parsed member is *returned* rather than merely approved because the
    reflection path carries the routed tier onto its domain value, and re-parsing
    a string this function has already parsed would be a second implementation of
    the same narrowing.
    """
    if not isinstance(echoed, str):
        return None
    try:
        reported = VaultTierCeiling(echoed)
    except ValueError:
        return None
    if _TIER_CEILING_RANK[reported] > _TIER_CEILING_RANK[accepted]:
        return None
    return reported


def _ceiling_admissible(echoed: object, accepted: VaultTierCeiling) -> bool:
    """Return whether a vault's echoed tier ceiling is one we were willing to accept.

    The predicate form of :func:`_admissible_ceiling`, for the callers that only
    need the verdict. One rule, one implementation: a second rank comparison is
    how two readings of the same echo come to disagree.
    """
    return _admissible_ceiling(echoed, accepted) is not None


def _reflection_request_body(body: str) -> Mapping[str, object]:
    """Map a reflection request onto the ratified ``/v1`` fields.

    Exactly two, and no more. There is no ``entry_ref`` because adepthood
    reflects on an ad-hoc body rather than on a fragment the vault has already
    stored, and no tier-ceiling field under any spelling because the published
    request is ``additionalProperties: false`` and names none -- sending one
    would be guessing at a contract, exactly as :func:`_journal_entry_body`
    declines to send a fourth field. ``max_notes`` asks for the schema's own
    maximum (:data:`_REQUESTED_NOTE_BUDGET`).
    """
    return {"content": body, "max_notes": _REQUESTED_NOTE_BUDGET}


def _reflection_status(raw: object) -> VaultReflectionStatus | None:
    """Narrow a reflection's wire status onto our enum, or ``None`` when unreadable.

    Mirrors :func:`_coerce_capability` and :func:`_coerce_error_code`: the value
    is proved to be a string before it is looked up, so a number or a nested
    object cannot reach the enum constructor. Unlike those two, an unrecognized
    status is *not* silently dropped by the caller -- a status outside the
    published pair is an answer this client cannot read at all.
    """
    if not isinstance(raw, str):
        return None
    try:
        return VaultReflectionStatus(raw)
    except ValueError:
        return None


def _reflection_essay(raw: object) -> str | None:
    """Return a reflection's free prose when it is prose, else ``None``.

    ``essay`` is optional and nullable in the published shape, so absence is an
    ordinary answer rather than a fault, and a wrong-typed value is narrowed away
    on the same drop-unknown discipline every other optional field here follows.
    The value is carried so the seam can report what the vault answered; it is
    never rendered, anchored, or logged, and the consumer is where that holds.
    """
    return raw if isinstance(raw, str) else None


def _reflection_notes_tuple(raw: object) -> tuple[VaultReflectionNote, ...]:
    """Project a reflection's note array onto the domain's note values.

    Reuses :func:`_reflection_notes` -- the one canonical projection onto
    adepthood's marginalia vocabulary, bounded and item-wise fail-soft -- and only
    re-shapes what survives into the pure-domain value type, so the domain module
    carries no wire dependency and there is still exactly one place a Creek note
    kind is translated.
    """
    return tuple(
        VaultReflectionNote(kind=note["kind"], quote=note["quote"], note=note["note"])
        for note in _reflection_notes(raw)
    )


def _complete_reflection(payload: Mapping[str, object]) -> bool:
    """Return whether a reflection body carries the published shape it claims to.

    Three refusals, in the order that makes each meaningful: a body missing a
    field Creek's own schema marks ``required``, which is refused rather than
    completed with a default the vault never sent; an ``essay_grounded`` that is
    not *literally* ``False`` -- it is a ``const false`` upstream, so a payload
    claiming a grounded essay describes a contract this client does not speak,
    and the identity test is what keeps a merely falsy value from standing in for
    the claim; and a ``notes`` that is not the published array, because reading a
    non-array as zero notes would make a malformed document indistinguishable
    from a vault that legitimately found nothing.
    """
    return (
        all(field in payload for field in _REFLECTION_RESPONSE_REQUIRED_FIELDS)
        and payload["essay_grounded"] is False
        and isinstance(payload["notes"], list)
    )


def _reflection_routed_tier(
    payload: Mapping[str, object], accepted: VaultTierCeiling
) -> VaultTierCeiling | None:
    """Return the tier the vault keyed the call with, only if both echoes are admissible.

    Both are checked because they are two separate claims: ``tier_ceiling`` is
    what the vault says it was asked for and ``routed_tier`` is what it says it
    actually keyed the model call with. Either one exceeding what adepthood was
    willing to accept means the answer was drawn from material this app never
    authorized, and an echo that will not parse as a tier is not a claim at all --
    accepting one would make the check passable by answering with nonsense.
    """
    if not _ceiling_admissible(payload["tier_ceiling"], accepted):
        return None
    return _admissible_ceiling(payload["routed_tier"], accepted)


def _readable_reflection(
    payload: Mapping[str, object], accepted: VaultTierCeiling
) -> VaultReflection | None:
    """Project a reflection body onto the seam's value, or ``None`` when unreadable.

    Answers ``None`` rather than raising so the caller owns the refusal, exactly
    as :func:`_parse_wheel` does for the other read. A status outside the
    published pair, an incomplete body, and an inadmissible tier echo are all
    unreadable; a well-formed answer whose notes did not survive projection is
    not, because what the vault said and what adepthood can render are separate
    facts.
    """
    status = _reflection_status(payload.get("status"))
    if status is None or not _complete_reflection(payload):
        return None
    routed_tier = _reflection_routed_tier(payload, accepted)
    if routed_tier is None:
        return None
    return VaultReflection(
        status=status,
        notes=_reflection_notes_tuple(payload["notes"]),
        essay=_reflection_essay(payload.get("essay")),
        essay_grounded=False,
        routed_tier=routed_tier,
    )


def _parse_reflection_result(
    payload: Mapping[str, object], accepted: VaultTierCeiling
) -> VaultReflection:
    """Project one reflection response onto the seam's value, or refuse it whole.

    The one place the ratified ``/v1`` reflection body is read. It was written to
    be the single parser two transports shared, back when the MCP tool result and
    the ``/v1`` body were the same canonical document; the MCP client has since
    been retired, so this is now the only reading of that shape in the app. The
    reason for keeping it that way outlives the transport that motivated it: a
    second reading of one wire shape is how two readings of the same reflection
    come to disagree.

    Three outcomes. A literal ``escalate`` status raises
    :class:`~domain.creek_vault.CreekVaultCareEscalationError` before any other
    field is read, since that document is a different published shape carrying
    none of the fields below. Anything this client cannot read as the published
    shape raises :class:`~domain.creek_vault.CreekVaultPayloadError`, so a vault
    that invented a status or dropped a required field becomes a reportable bug
    rather than an invisible deferral. Everything else is a reflection.
    """
    if payload.get("status") == _REFLECT_ESCALATE_STATUS:
        raise CreekVaultCareEscalationError
    reflection = _readable_reflection(payload, accepted)
    if reflection is None:
        raise CreekVaultPayloadError(_REFLECT_UNREADABLE_MESSAGE)
    return reflection
