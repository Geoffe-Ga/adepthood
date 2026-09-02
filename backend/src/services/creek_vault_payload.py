"""The Creek Vault wire shapes: what adepthood sends, and what it will read back.

The pure half of the vault seam, split out of
:mod:`services.creek_vault_client` so the adapters there are left holding
transports, sessions, and a connection pool while the *rules* for building a
request and reading an untrusted answer live in one place with no I/O in sight.
Nothing here opens a socket, touches a session, or holds a credential; every
function takes a value adepthood already holds or a vault already sent, and
answers with something one side is willing to use.

Four concerns, and they belong together because each is a different half of the
same sentence "this exchange is safe to make":

* **Bounds and projection.** :func:`_bounded_text` and the note helpers turn
  Creek's margin notes into adepthood's marginalia vocabulary, dropping whatever
  does not survive on its own terms rather than completing it with a default that
  would put words in the user's Higher Self neither they nor the vault wrote.
* **Tier echoes.** A ceiling is declared on the way out, in the adapter's
  ``X-Creek-Tier-Ceiling`` header; :func:`_admissible_ceiling` checks the
  separate claim a vault makes on the way back about the one it *applied*. An
  answer computed above the ceiling adepthood was willing to accept was drawn
  from material this app never authorized, and is refused whole.
* **The reflection document.** :func:`_parse_reflection_result` is the one place
  the ratified ``/v1`` reflection body is read. It was written to be the single
  parser two transports shared; only the HTTP one remains, so it is now simply
  the only reading of that shape there is -- which is the same guarantee arrived
  at from the other side, since a second reading is how two readings of one
  reflection come to disagree.
* **The two write shapes.** :func:`_journal_entry_body` and
  :func:`_upload_document_body` build the only two requests that put a user's
  own material on the wire, and :func:`_parse_http_ingest_result` /
  :func:`_parse_http_upload_result` read what came back of them. They sit beside
  the read rules rather than in the adapter because they are the same kind of
  thing: a published shape, honoured exactly, with no field invented and none
  omitted. Both answers are read conservatively -- an action we recognise *and*
  a storable fragment id, or not stored at all -- because reporting a write we
  cannot verify would let an entry look replicated when it is not, and would
  tell an uploader their document is in their vault when it is nowhere.

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

import enum
from collections.abc import Mapping
from datetime import date

from domain.constants import TOTAL_STAGES
from domain.creek_vault import (
    CreekCapability,
    CreekVaultCareEscalationError,
    CreekVaultPayloadError,
    VaultClassificationMethod,
    VaultClassificationPass,
    VaultIngestAction,
    VaultIngestRequest,
    VaultIngestResult,
    VaultLinkPass,
    VaultLinkStage,
    VaultPraxisKind,
    VaultPraxisStatus,
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultRelatedEddy,
    VaultRelatedPraxis,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultWheelAspect,
    VaultWheelBalance,
    WireTierCeiling,
    wire_ceiling_for,
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

# How many of each kind of compiled page a reflection may surface. Both are
# Creek's own published ``maxItems`` rather than a second opinion about them, and
# ``test_http_reflect_bounds_related_pages_at_the_published_maximums`` pins them
# equal to the vendored schema so they cannot drift from it silently. Bounded
# *here* and nowhere else: the response builder carries whatever survives this
# read, because a second cap applied downstream is how two readings of one
# ceiling come to disagree. Small on purpose -- a reflection is a note in the
# margin, not a dashboard.
_MAX_RELATED_PRAXIS = 3
_MAX_RELATED_EDDIES = 2

# How long a compiled page's own title may be before adepthood stops reading it.
# A title is a page's identity, so it is bounded like a note's quote rather than
# like its prose: generous for a real heading, far short of what an unbounded
# vault-chosen string could cost a client rendering it.
_RELATED_TITLE_MAX = 200

# The one bound on a compiled page's prose -- a praxis excerpt or an eddy's
# description. Creek caps the excerpt on its own side; this is the bound that
# does not depend on it doing so, and it is shared because the two fields are the
# same kind of thing (a page describing itself in its own words) and a second
# constant would only invite the two to drift.
_RELATED_PROSE_MAX = 1_000

# Length of the ``YYYY-MM-DD`` date an eddy publishes as its formation day.
# Checked alongside the parse rather than instead of it: ``date.fromisoformat``
# accepts several ISO spellings, and admitting one would hand a client a string
# it must guess the shape of.
_ISO_DATE_LENGTH = 10

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

    The three are asked in cheapest-first order, so an oversized vault-supplied
    string is refused on its length alone rather than after ``strip`` has
    allocated a full-size transient copy of it. The waste was real only for
    whitespace-padded input -- CPython answers with the receiver itself when an
    exact :class:`str` has nothing to remove, so an oversized value with no
    surrounding whitespace was never copied -- but a padded one was, and a vault
    that chooses its own payload chooses the padding too. It is defence in depth
    on an untrusted response rather than the primary control, which remains the
    bound itself.
    """
    if not isinstance(raw, str) or len(raw) > limit or not raw.strip():
        return None
    return raw


def _bounded_prose(raw: object, limit: int) -> str | None:
    """Return vault-supplied prose within ``limit``, else ``None``.

    The permissive twin of :func:`_bounded_text`, and the difference is the whole
    reason it exists: a compiled page's description is published as the empty
    string when the page declares none, so refusing a blank the way a note's
    quote must be refused would drop every undescribed eddy. Blank prose renders
    as nothing, which is the honest rendering of a page that says nothing about
    itself; a blank *quote*, by contrast, anchors to nothing at all.
    """
    return raw if isinstance(raw, str) and len(raw) <= limit else None


def _wire_value(members: type[enum.StrEnum], raw: object) -> str | None:
    """Return one vault-supplied wire string when it names a member, else ``None``.

    The single narrowing every closed vocabulary this module reads goes through.
    The value is proved to be a string before it reaches the enum constructor --
    a number or a nested object cannot -- and an unrecognized member answers
    ``None`` rather than raising, leaving each caller to decide whether an
    unreadable value costs its item or the whole document.

    It answers with the wire string rather than the member, and each caller
    constructs its own enum from it. That keeps the helper concrete: a version
    generic over the member type would need a type parameter, and the parameter
    syntax ruff asks for at this target version is a syntax error on the oldest
    interpreter this backend is tested against.
    """
    if not isinstance(raw, str):
        return None
    try:
        members(raw)
    except ValueError:
        return None
    return raw


def _bounded_items(raw: object, limit: int) -> tuple[object, ...]:
    """Return the leading ``limit`` items of a vault-supplied array, unread.

    The one shape every optional collection in a reflection is read with, so the
    three of them cannot each grow their own idea of it. Answers empty -- never
    raises -- for anything that is not a list, since ``null``, an absent field
    and a wrong-typed one all mean the same thing: nothing to surface. Only the
    leading ``limit`` items are handed on, order preserved, so an over-eager or
    hostile vault cannot grow this work without bound; each caller then projects
    them one at a time, so one malformed item never costs its siblings.
    """
    return tuple(raw[:limit]) if isinstance(raw, list) else ()


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

    A :func:`_bounded_items` read over :data:`_MAX_REFLECT_NOTES`, so a malformed
    reflection defers to the cloud rather than breaking the resonance pass, and
    an over-eager or hostile vault cannot grow this work (or the JSON it feeds)
    without bound.
    """
    return [
        note
        for item in _bounded_items(raw, _MAX_REFLECT_NOTES)
        if (note := _reflection_note(item)) is not None
    ]


def _praxis_vocabulary(
    item: Mapping[str, object],
) -> tuple[VaultPraxisKind, VaultPraxisStatus] | None:
    """Narrow a praxis page's two closed vocabularies together, or answer ``None``.

    Read as one value because they fail as one: a page whose kind or whose
    lifecycle is outside what Creek publishes is a page adepthood cannot label,
    and either miss costs the whole page. Keeping the pair here also leaves
    :func:`_related_praxis` reading the page's own words and nothing else.
    """
    kind = _wire_value(VaultPraxisKind, item.get("praxis_type"))
    lifecycle = _wire_value(VaultPraxisStatus, item.get("status"))
    if kind is None or lifecycle is None:
        return None
    return VaultPraxisKind(kind), VaultPraxisStatus(lifecycle)


def _related_praxis(item: object) -> VaultRelatedPraxis | None:
    """Project one compiled praxis page onto the seam's value, or drop it whole.

    Every field has to survive on its own terms, exactly as a margin note's do: a
    title that is real text, a kind and a status inside Creek's published
    vocabularies, and an excerpt within :data:`_RELATED_PROSE_MAX`. A partial
    page is dropped rather than completed with a default, which would show the
    writer a practice their vault never named -- or, worse, show a released one
    as active.
    """
    if not isinstance(item, Mapping):
        return None
    title = _bounded_text(item.get("title"), _RELATED_TITLE_MAX)
    excerpt = _bounded_prose(item.get("excerpt"), _RELATED_PROSE_MAX)
    vocabulary = _praxis_vocabulary(item)
    if title is None or excerpt is None or vocabulary is None:
        return None
    praxis_type, status = vocabulary
    return VaultRelatedPraxis(title=title, praxis_type=praxis_type, status=status, excerpt=excerpt)


def _published_count(raw: object) -> int | None:
    """Return a published count when the vault answered one, else ``None``.

    One reading of "this field is a count", used everywhere the wire publishes
    one -- an eddy's clustered fragments, and every tally the pipeline responses
    are made of. A second implementation of the same rule is how two readings of
    the same number come to disagree.

    ``bool`` is excluded before anything else because Python's ``bool`` *is* an
    ``int``: without that, a vault answering ``true`` would publish an eddy
    clustering one fragment, or a classification pass that visited one fragment
    when it visited none. The rest is the published constraint -- an integer,
    never negative, because a tally of nothing is zero and a tally below that
    describes no corpus.
    """
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        return None
    return raw


def _iso_date(raw: object) -> str | None:
    """Return a vault-supplied ``YYYY-MM-DD`` date, verbatim, when it is one.

    Both halves are load-bearing. The length pins the spelling, because
    :meth:`datetime.date.fromisoformat` also accepts basic and week-date forms
    and admitting one would hand a client a string whose shape it must guess.
    The parse pins the value, because a well-shaped impossibility -- a thirteenth
    month -- would otherwise render as a date nobody's corpus has.
    """
    if not isinstance(raw, str) or len(raw) != _ISO_DATE_LENGTH:
        return None
    try:
        date.fromisoformat(raw)
    except ValueError:
        return None
    return raw


def _eddy_formation(item: Mapping[str, object]) -> tuple[int, str] | None:
    """Narrow the two facts a vault detected about an eddy, or answer ``None``.

    The tally and the formation date are read as one value because neither is
    the writer's own prose: both are things the vault observed about the cluster,
    and a page that cannot say honestly how much it gathers or when it appeared
    is one adepthood will not show at all.
    """
    fragment_count = _published_count(item.get("fragment_count"))
    formed = _iso_date(item.get("formed"))
    if fragment_count is None or formed is None:
        return None
    return fragment_count, formed


def _related_eddy(item: object) -> VaultRelatedEddy | None:
    """Project one eddy onto the seam's value, or drop it whole.

    Item-wise fail-soft on the same terms as :func:`_related_praxis`. The one
    asymmetry is ``description``, which is read with :func:`_bounded_prose`
    rather than :func:`_bounded_text`: an eddy page declaring no description
    publishes the empty string, and refusing that would drop every undescribed
    cluster the writer has.
    """
    if not isinstance(item, Mapping):
        return None
    title = _bounded_text(item.get("title"), _RELATED_TITLE_MAX)
    description = _bounded_prose(item.get("description"), _RELATED_PROSE_MAX)
    formation = _eddy_formation(item)
    if title is None or description is None or formation is None:
        return None
    fragment_count, formed = formation
    return VaultRelatedEddy(
        title=title, description=description, fragment_count=fragment_count, formed=formed
    )


def _related_praxis_pages(raw: object) -> tuple[VaultRelatedPraxis, ...]:
    """Project a reflection's praxis array, bounded at :data:`_MAX_RELATED_PRAXIS`."""
    return tuple(
        page
        for item in _bounded_items(raw, _MAX_RELATED_PRAXIS)
        if (page := _related_praxis(item)) is not None
    )


def _related_eddy_pages(raw: object) -> tuple[VaultRelatedEddy, ...]:
    """Project a reflection's eddy array, bounded at :data:`_MAX_RELATED_EDDIES`."""
    return tuple(
        eddy
        for item in _bounded_items(raw, _MAX_RELATED_EDDIES)
        if (eddy := _related_eddy(item)) is not None
    )


def _admissible_ceiling(echoed: object, accepted: VaultTierCeiling) -> VaultTierCeiling | None:
    """Return a vault's echoed tier ceiling when we were willing to accept it, else ``None``.

    Verification is the *second* half of a pair, not a substitute for the first.
    The ceiling is declared on the way out, in ``X-Creek-Tier-Ceiling`` -- the
    ratified surface publishes no request *field* for one (``ReflectionRequest``
    is ``additionalProperties: false``, ``GET /v1/wheel`` takes no parameter),
    which is why the header is where it goes and why inventing a fourth body
    field would still be guessing. What this function checks is the separate
    claim the vault makes on the way back: not what it was asked for, but what
    it says it applied.

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
    declines to send a fourth field. The ceiling is still declared, in the
    ``X-Creek-Tier-Ceiling`` header the adapter builds; "not in this body" was
    never "not on this request". ``max_notes`` asks for the schema's own maximum
    (:data:`_REQUESTED_NOTE_BUDGET`).
    """
    return {"content": body, "max_notes": _REQUESTED_NOTE_BUDGET}


def _reflection_status(raw: object) -> VaultReflectionStatus | None:
    """Narrow a reflection's wire status onto our enum, or ``None`` when unreadable.

    One use of :func:`_wire_value`, so the value is proved to be a string before
    it reaches the enum constructor exactly as every other closed vocabulary here
    is. What differs is what the caller does with a ``None``: an unrecognized
    status is *not* silently dropped -- a status outside the published pair is an
    answer this client cannot read at all.
    """
    value = _wire_value(VaultReflectionStatus, raw)
    return None if value is None else VaultReflectionStatus(value)


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

    The two related collections are read the same permissive way the ``essay``
    is, and for the same reason: both are optional in the published shape, so an
    absent, null, or unreadable one is an ordinary answer carrying no pages
    rather than a body this client must refuse.
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
        related_praxis=_related_praxis_pages(payload.get("related_praxis")),
        related_eddies=_related_eddy_pages(payload.get("related_eddies")),
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


# Longest vault-issued fragment id adepthood will keep as an entry's durable
# reference. Opaque handles are short by nature -- a UUID is 36 characters -- so
# this is generous by nearly an order of magnitude, and it is a *bound*, not a
# format: the vault owns the shape of its own ids. It exists because that string
# is persisted verbatim into a journal entry's unbounded ``vault_ref`` text
# column on every save, which without a ceiling lets a compromised vault grow
# the operator's database by as much as it cares to answer with.
_MAX_FRAGMENT_ID_LENGTH = 256

# The one not-stored result every unreadable 2xx journal answer collapses to.
# Interned because it is value-identical on each of those paths, and named so no
# branch is tempted to invent a ``vault_ref`` the vault never issued.
_NOT_STORED_RESULT = VaultIngestResult(stored=False, vault_ref=None, action=None)

# The upload path's own not-stored answer. A separate constant rather than a
# reuse because the two results are different types: an upload additionally
# carries the tags a vault's ingest pipeline assigned, which is empty here for
# the same reason the ref is absent -- nothing was written to have any.
_NOT_STORED_UPLOAD = VaultUploadResult(stored=False, vault_ref=None, action=None, tags=())


def _is_storable_ref(fragment_id: str) -> bool:
    """Return whether a vault-issued id is safe to persist as an entry's ``vault_ref``.

    Three conditions, and the last two are why this exists. Non-empty, because a
    blank id is no reference at all. Within :data:`_MAX_FRAGMENT_ID_LENGTH`, so a
    compromised vault cannot answer every journal save with an arbitrarily large
    string that lands in an unbounded text column. And printable, because this
    is the one vault-chosen string adepthood *stores* rather than drops:
    ``str.isprintable`` rejects NUL (which a Postgres text column refuses
    outright, turning a hostile response into a failed write of an
    already-saved entry), CR/LF (log injection, should the ref ever be
    rendered), and the zero-width and bidi-override codepoints the journal's own
    write boundary already sanitizes out of user text.

    It also rejects an unpaired surrogate, and that is load-bearing rather than
    incidental to the ones listed above. ``vault_ref`` is the only string a vault
    chooses that reaches a *response body* with no database row in between --
    ``POST /corpus/import`` returns it directly, and the vault branch of that
    route writes nothing: :func:`services.corpus_import._to_vault` takes no
    session at all, so the route's commit flushes an empty unit of work and the
    guard in :mod:`security.pg_text_guard` -- which inspects only values bound
    for mapped columns -- has nothing to look at. A lone surrogate has no UTF-8
    encoding at all, so rendering one is a 500; ``str.isprintable`` is what stops
    that, because U+D800-U+DFFF is Unicode category ``Cs`` and no ``Cs`` code
    point is printable.

    Narrowing this check to the specific code points named above -- an obvious
    tidy-up, since the docstring reads like an inventory -- would reopen that
    path. Pinned by ``test_storable_ref_bound_excludes_lone_surrogates``.
    """
    return (
        bool(fragment_id)
        and len(fragment_id) <= _MAX_FRAGMENT_ID_LENGTH
        and fragment_id.isprintable()
    )


def _usable_fragment_id(payload: Mapping[str, object]) -> str | None:
    """Return the vault's fragment id when it is storable, else ``None``.

    A missing, blank, non-string, oversized, or unprintable id is unusable as a
    durable reference (see :func:`_is_storable_ref`), and coercing one
    (``str(7)``) would fabricate a ref the vault never issued.
    """
    fragment_id = payload.get("fragment_id")
    if isinstance(fragment_id, str) and _is_storable_ref(fragment_id):
        return fragment_id
    return None


def _journal_entry_body(request: VaultIngestRequest) -> Mapping[str, object]:
    """Map an ingest request onto the ratified ``/v1`` journal-entry fields.

    Exactly three fields, and no more: the entry id travels in the URL (it is
    the resource), and the write ceiling travels in :data:`_CEILING_HEADER`,
    which is where Creek reads it from. Sending a field the ratified shape does
    not name would be guessing. The body's ``tier`` and that header carry the
    same value on this path -- a journal write stores at the writer's own tier --
    but they are not one claim said twice: the header is what the caller is
    *admitted* at, and Creek refuses the write outright when the tier here
    outranks it.
    """
    return {
        "content": request.body,
        "timestamp": request.created_at.isoformat(),
        "tier": request.tier.value,
    }


def _upload_document_body(
    request: VaultUploadRequest, tier: WireTierCeiling
) -> Mapping[str, object]:
    """Map an upload request onto the published ``UploadRequest`` fields.

    Exactly the five Creek publishes, and no more: the shape declares
    ``additionalProperties: false``, so a field adepthood invented would be a
    refused request rather than something a vault quietly ignores. The document
    travels as base64 inside JSON, which is the shape Creek publishes and the
    only one either end could use: a form-encoded file transport is banned
    outright on both sides -- Creek's CI forbids the parser, and this
    repository's own privacy tests forbid that surface anywhere in the tree,
    because it spools user bytes to disk.

    ``tier`` is a :class:`WireTierCeiling` rather than the request's own
    :class:`~domain.creek_vault.VaultTierCeiling`, and it is a parameter rather
    than a translation done here: the caller resolves it through
    :func:`~domain.creek_vault.wire_ceiling_for` before the request exists, so
    an intimate document is refused while its bytes are still a field on a
    frozen dataclass. Creek made this field required and two-valued at 0.7.0 /
    0.8.0 for the matching reason -- a defaulted tier filed intimate-derived
    bytes in the clear.

    ``timestamp`` is sent because the published shape names it and the journal
    write sends its own for symmetry. Creek stores it nowhere: a binary document
    has no frontmatter, so the fragment's timestamp comes from the ingestor.
    """
    return {
        "filename": request.filename,
        "content_base64": request.content_base64,
        "external_id": request.external_id,
        "timestamp": request.created_at.isoformat(),
        "tier": tier.value,
    }


def _coerce_ingest_action(raw: object) -> VaultIngestAction | None:
    """Map the vault's reported action onto our enum, or ``None`` if we do not know it.

    Mirrors :func:`_coerce_capability`: an unknown or wrong-typed value is
    dropped rather than raising, so the string a vault chose can never reach a
    message or a log. An unknown action is not a durable write, though -- the
    caller treats ``None`` as "we could not read this response".
    """
    if not isinstance(raw, str):
        return None
    try:
        return VaultIngestAction(raw)
    except ValueError:
        return None


def _parse_http_ingest_result(payload: object) -> VaultIngestResult:
    """Project a 2xx ingest body onto a result, conservatively.

    A durable write needs both halves: an action we recognize *and* a storable
    fragment id. Anything less -- a body that is not a JSON object, an unknown
    action, a blank or oversized or unprintable id -- parses to not-stored,
    which the write path records as a degraded write. That is the safe
    direction: reporting a write we cannot verify would let the entry look
    replicated when it is not.
    """
    if isinstance(payload, Mapping):
        action = _coerce_ingest_action(payload.get("action"))
        fragment_id = _usable_fragment_id(payload)
        if action is not None and fragment_id is not None:
            return VaultIngestResult(stored=True, vault_ref=fragment_id, action=action)
    return _NOT_STORED_RESULT


def _parse_http_upload_result(payload: object) -> VaultUploadResult:
    """Project a 2xx upload body onto a result, conservatively.

    The sibling of :func:`_parse_http_ingest_result`, and deliberately built on
    the same two-halves rule rather than a looser one: a durable upload needs an
    action we recognize *and* a storable fragment id, and anything less parses to
    not-stored. The stakes are higher here than on the journal path, which is why
    the rule is not relaxed -- a journal entry is already in Postgres when its
    replication degrades, while an uploaded document has no local copy at all, so
    reporting a write we cannot verify would tell someone their file is in their
    vault when it is nowhere.

    ``UploadResponse`` publishes more than this reads -- ``affected_fragment_ids``
    for the workbook that splits into several fragments, ``source_type``,
    ``warnings``, an echoed ``tier_ceiling``. None of them is projected because
    :class:`~domain.creek_vault.VaultUploadResult` has nowhere to put them and
    inventing somewhere would publish a shape no caller asked for. ``tags`` stays
    empty for the same reason it does on the fallback path: the vault does not
    return per-fragment tags on this surface, and empty is the truth rather than
    a failure.
    """
    if isinstance(payload, Mapping):
        action = _coerce_ingest_action(payload.get("action"))
        fragment_id = _usable_fragment_id(payload)
        if action is not None and fragment_id is not None:
            return VaultUploadResult(stored=True, vault_ref=fragment_id, action=action)
    return _NOT_STORED_UPLOAD


# The status every pipeline response reports when it actually ran. Its own
# constant rather than a reuse of the wheel's or the reflection's: the three
# capabilities merely happen to spell success the same way today, and coupling
# them would let one capability's future rename silently change how another is
# parsed.
_PIPELINE_OK_STATUS = "ok"

# The published top-level fields of ``ClassificationResponse`` and of
# ``LinkResponse``, in the order Creek's schemas declare them ``required``.
# Presence is checked before anything is projected, so a 2xx body missing one is
# refused rather than completed with a default the vault never sent -- the
# discipline ``_WHEEL_RESPONSE_REQUIRED_FIELDS`` keeps, applied to the two wider
# shapes. ``status`` and ``tier_ceiling`` are required here and then verified
# rather than carried: a constant and a ceiling echo are claims to check, not
# values a caller has any use for.
_CLASSIFICATION_RESPONSE_REQUIRED_FIELDS = (
    "status",
    "tier_ceiling",
    "method",
    "total",
    "classified",
    "preserved_manual",
    "preserved_llm",
    "privacy_tiers_assigned",
    "retiered",
    "praxis_marked",
    "tags_extracted",
    "complete",
)
_LINK_RESPONSE_REQUIRED_FIELDS = (
    "status",
    "tier_ceiling",
    "method",
    "fragment_count",
    "link_count",
    "largest_cluster_fragments",
    "clusters_split",
    "oversized_discarded",
)

# Which of those fields are counts, and so must survive :func:`_published_count`
# rather than merely being present. Split out from the required tuples above
# because the two ask different questions -- one is "did the vault answer this
# field at all", the other "is what it answered a number a corpus could have
# produced" -- and a body can pass the first while failing the second.
_CLASSIFICATION_COUNT_FIELDS = (
    "total",
    "classified",
    "preserved_manual",
    "preserved_llm",
    "privacy_tiers_assigned",
    "retiered",
    "praxis_marked",
    "tags_extracted",
)
_LINK_COUNT_FIELDS = (
    "fragment_count",
    "link_count",
    "largest_cluster_fragments",
    "clusters_split",
    "oversized_discarded",
)


def _classification_request_body() -> Mapping[str, object]:
    """Build the body of a whole-vault classification request.

    Two fields exist on the published shape and this sends one of them.

    ``method`` is sent explicitly even though Creek defaults it, because an
    omitted field means "whatever you default to" and a named one means "run the
    rules classifier" -- and only the second is a statement adepthood can be held
    to when the served set grows. It is emphatically *not* sent as ``null``: the
    field is a one-member enum under ``additionalProperties: false``, so an
    explicit null is a type violation the vault answers with ``422``.

    ``retier`` is omitted, and omission here is the decision rather than a
    default falling through. Re-deriving a privacy tier the operator or the
    uploader already settled is not adepthood's call to make -- every fragment
    adepthood puts in a vault already carries the tier adepthood declared at
    upload time -- so the request that could ask for it is one this function
    cannot build.
    """
    return {"method": VaultClassificationMethod.RULES.value}


def _link_request_body(stage: VaultLinkStage) -> Mapping[str, object]:
    """Build the body of one linker-stage request.

    ``method`` is unconditional here where it is merely deliberate above:
    ``LinkRequest.method`` is ``required`` and carries no default, because the
    three stages are not interchangeable and a default would silently run a pass
    the caller did not choose while reporting it as the one they asked for.
    """
    return {"method": stage.value}


def _counts(payload: Mapping[str, object], fields: tuple[str, ...]) -> dict[str, int] | None:
    """Read every named field as a published count, or answer ``None``.

    All-or-nothing on purpose. A response whose ``total`` is a string and whose
    other seven tallies are integers is not a pass that partly happened; it is a
    body adepthood cannot read, and projecting seven of its numbers would file a
    fiction under a completed stage.
    """
    counts: dict[str, int] = {}
    for name in fields:
        count = _published_count(payload[name])
        if count is None:
            return None
        counts[name] = count
    return counts


def _admissible_pipeline_body(
    payload: Mapping[str, object], required: tuple[str, ...], accepted: VaultTierCeiling
) -> bool:
    """Whether a 2xx pipeline body is one adepthood may read at all.

    Three questions, in the order that makes each one answerable: every published
    field present, the success constant actually present in ``status``, and the
    ceiling the vault says it ran at no wider than the one adepthood was willing
    to accept. The last is the one that matters most here -- these routes run
    over the *whole* vault, so a wider echo says the counts were drawn from
    material this app never authorized a pass over, and a count computed over
    unauthorized material is refused whole rather than recorded.
    """
    if not all(name in payload for name in required):
        return False
    if payload["status"] != _PIPELINE_OK_STATUS:
        return False
    return _ceiling_admissible(payload["tier_ceiling"], accepted)


def _parse_classification_pass(
    payload: Mapping[str, object], accepted: VaultTierCeiling
) -> VaultClassificationPass | None:
    """Project an admissible classification body onto its domain value, or ``None``.

    ``complete`` is type-checked rather than coerced, and it is checked as a
    ``bool`` specifically: it is the field that says whether the pass finished,
    so a vault answering ``"false"`` or ``0`` must not read as a clean run, and
    truthiness is exactly the reading that would let it.
    """
    if not _admissible_pipeline_body(payload, _CLASSIFICATION_RESPONSE_REQUIRED_FIELDS, accepted):
        return None
    if _wire_value(VaultClassificationMethod, payload["method"]) is None:
        return None
    complete = payload["complete"]
    counts = _counts(payload, _CLASSIFICATION_COUNT_FIELDS)
    if counts is None or not isinstance(complete, bool):
        return None
    return VaultClassificationPass(
        total=counts["total"],
        classified=counts["classified"],
        preserved_manual=counts["preserved_manual"],
        preserved_llm=counts["preserved_llm"],
        privacy_tiers_assigned=counts["privacy_tiers_assigned"],
        retiered=counts["retiered"],
        praxis_marked=counts["praxis_marked"],
        tags_extracted=counts["tags_extracted"],
        complete=complete,
    )


def _parse_link_pass(
    payload: Mapping[str, object], stage: VaultLinkStage, accepted: VaultTierCeiling
) -> VaultLinkPass | None:
    """Project an admissible link body onto its domain value, or ``None``.

    The echoed ``method`` is checked against the stage that was *asked for*
    rather than merely read back. Creek publishes the echo "for correlation",
    and a correlation nobody verifies is a label: a body echoing ``threads`` for
    a ``temporal`` request would otherwise be filed as the temporal stage having
    run, and the ladder would move on from a rung it never climbed.
    """
    if not _admissible_pipeline_body(payload, _LINK_RESPONSE_REQUIRED_FIELDS, accepted):
        return None
    if _wire_value(VaultLinkStage, payload["method"]) != stage.value:
        return None
    counts = _counts(payload, _LINK_COUNT_FIELDS)
    if counts is None:
        return None
    return VaultLinkPass(
        stage=stage,
        fragment_count=counts["fragment_count"],
        link_count=counts["link_count"],
        largest_cluster_fragments=counts["largest_cluster_fragments"],
        clusters_split=counts["clusters_split"],
        oversized_discarded=counts["oversized_discarded"],
    )


# The privacy ceiling adepthood presents when it asks for a wheel. Only
# aggregate per-Frequency counts and shares cross this seam -- never fragment
# content -- so the ceiling governs what the vault *counts*, not what it hands
# back. ``personal`` is the honest maximum: intimate content never reaches the
# vault from adepthood at all, and creek independently caps a network consumer
# below intimate. ``open`` would be worse than useless rather than safer,
# because creek ranks unclassified content with personal: an open ceiling
# silently excludes every not-yet-classified fragment, so a young corpus reads
# back as an all-zero wheel.
#
# It is read twice, as the same number for the same reason -- this is the most
# material adepthood ever authorizes a vault to count over. Outbound it is
# *declared*, in :data:`_CEILING_HEADER`; inbound it is the widest ceiling
# adepthood is willing to **accept**, which :func:`_ceiling_admissible` verifies
# the vault's echo against. Declaring it is not optional: the ``/v1`` request
# body and query string publish no field for a ceiling, and reading that as "the
# surface has none" is what left this read taking Creek's ``open`` default and
# counting a fraction of the corpus while looking computed.
_WHEEL_TIER_CEILING = VaultTierCeiling.PERSONAL

# The same ceiling in the vocabulary the header speaks, resolved once at import
# so a wheel read cannot be the call that discovers the translation refuses.
_WHEEL_WIRE_CEILING = wire_ceiling_for(_WHEEL_TIER_CEILING)

# The status a ``creek.wheel`` response reports when it actually computed a
# wheel. Its own constant rather than a reuse of
# :attr:`~domain.creek_vault.VaultReflectionStatus.OK`: the capabilities merely
# happen to spell their success the same way today, and coupling them would let
# one capability's future rename silently change how another is parsed.
_WHEEL_OK_STATUS = "ok"

# The Frequency keys adepthood will read out of the vault's wheel map, in
# canonical order -- one per curriculum stage, so ``F1`` is stage 1. A whitelist
# rather than an iteration of whatever the vault sent, so a code creek adds
# later is ignored exactly as an unknown capability string already is.
#
# That ``F{n}`` -> stage ``n`` correspondence is a **semantic identity**, and
# this is the definition site where that has to be said. The Frequencies, the
# Aspects of Wholeness and the Stages are one set of ten developmental
# positions under four names -- Aspect, Frequency, Stage, Wavelength Mode --
# per ``NORTH-STAR.md``: "the shared ontology where Adepthood's Aspects equal
# Creek's Frequencies equal the Wavelength Modes". Modes are these ten,
# colour-keyed; the six Wavelength *phases* are a different axis entirely,
# and ``graph/ontology-spine.md`` writes each row as
# ``Beige = Stage 1 = F1 = BEIGE = 01-beige = Survival``. F1 *is* stage 1, and
# creek's ``Agency`` *is* the course Aspect Agency.
#
# (An earlier version of this comment argued the opposite -- that the two were
# unrelated vocabularies and their both having ten members was "a coincidence of
# cardinality". That was wrong, and it propagated: see ``domain.frequencies``,
# which now carries the canonical table.)
#
# Colour is the primary key, not the name. The two labelings agree on six of the
# ten positions and diverge on the middle four -- creek's ``Achievism`` against
# the curriculum's ``Intellectual Understanding / Achievist``, and likewise F6,
# F7, F8 -- so a join on names would mismatch exactly those four while looking
# correct. ``backend/tests/services/test_frequency_classification.py`` asserts
# both the colour join and that specific divergence.
#
# The read path still relabels each Frequency into the curriculum's own words
# before rendering, which remains right for a different reason than the one
# originally given: the curriculum's wording is what the user has been reading
# all along, not because the ontology underneath is foreign.
_WHEEL_FREQUENCY_CODES: tuple[str, ...] = tuple(f"F{n}" for n in range(1, TOTAL_STAGES + 1))

# Longest Frequency name adepthood will accept from a wheel entry. A *bound*,
# not a format -- the vault owns what it calls its own Frequencies -- and a
# generous one, since the longest name either side actually ships is under
# thirty characters. It exists because that string is carried into a domain
# value and can reach a log, and without a ceiling a compromised vault could
# answer with a string of any size at all.
_MAX_WHEEL_ASPECT_NAME_LENGTH = 128

# The published top-level fields of ``WheelResponse``, in the order Creek's
# schema declares them ``required``. Presence is checked before anything is
# projected, so a body missing one is refused rather than completed with a
# default the vault never sent. ``total_classified`` is deliberately validated
# and then never branched on: whether an all-zero wheel is worth rendering is
# decided in exactly one place, ``_carries_signal`` in
# :mod:`services.creek_vault_wheel`, and a second implementation of one rule is
# how the two drift.
_WHEEL_RESPONSE_REQUIRED_FIELDS = (
    "status",
    "tier_ceiling",
    "total_classified",
    "unclassified",
    "wheel",
)


def _wheel_fullness(raw: object) -> float | None:
    """Return a Frequency's share as a float, or ``None`` when it is not a number.

    Booleans are rejected *before* the numeric test, because ``isinstance(True,
    int)`` is ``True`` and a bare numeric check would silently read ``True`` as a
    completely full Frequency. The ``0.0..1.0`` bound is deliberately not checked
    here: the read path's own aspect check owns it, and its chained comparison
    already rejects ``NaN`` and the infinities. That is a division of labor
    between the two halves of the seam, not a gap in either.

    The conversion itself is guarded because JSON has no integer ceiling: a
    literal past the float range decodes to an arbitrary-precision ``int``, and
    ``float()`` then raises ``OverflowError`` -- an ``ArithmeticError`` that is in
    neither this client's transport degrade set nor the read path's
    ``CreekVaultError`` catch, so it would escape the seam as a crash on the
    caller's request path. A share no float can hold is simply unreadable, which
    is what ``None`` already means here.
    """
    if isinstance(raw, bool) or not isinstance(raw, int | float):
        return None
    try:
        return float(raw)
    except OverflowError:
        return None


def _wheel_aspect(entry: object, stage_number: int) -> VaultWheelAspect | None:
    """Project one Frequency entry onto a domain aspect, or drop it whole.

    Both halves have to survive on their own terms: a numeric ``share`` and a
    non-blank, printable ``name`` within :data:`_MAX_WHEEL_ASPECT_NAME_LENGTH`. A
    partial entry is dropped rather than completed with a default, which would
    show the user a Frequency reading neither they nor the vault ever produced.

    Printability is required for the same reason :func:`_is_storable_ref` requires
    it of a fragment id: a Frequency name is short label text, so a control
    character in one is never legitimate, and a name carrying CR/LF, an ANSI
    escape, or a bidirectional override is exactly the payload that forges a log
    line or misrenders a label. The name is relabelled away before this wheel is
    rendered, but this helper is the boundary, and a value that is inert wherever
    it lands does not depend on that.
    """
    if not isinstance(entry, Mapping):
        return None
    fullness = _wheel_fullness(entry.get("share"))
    name = _bounded_text(entry.get("name"), _MAX_WHEEL_ASPECT_NAME_LENGTH)
    if fullness is None or name is None or not name.isprintable():
        return None
    return VaultWheelAspect(stage_number=stage_number, aspect=name, fullness=fullness)


def _wheel_aspects(wheel: Mapping[str, object]) -> tuple[VaultWheelAspect, ...]:
    """Project the whitelisted Frequency codes onto aspects, dropping the unusable ones.

    Walks :data:`_WHEEL_FREQUENCY_CODES` rather than the mapping's own keys, so
    the stage number comes from adepthood's canonical order and any code outside
    the whitelist is ignored. The caller decides what a short result means.
    """
    return tuple(
        aspect
        for stage_number, code in enumerate(_WHEEL_FREQUENCY_CODES, start=1)
        if (aspect := _wheel_aspect(wheel.get(code), stage_number)) is not None
    )


def _parse_wheel(payload: Mapping[str, object]) -> VaultWheelBalance | None:
    """Project a wheel response onto a domain balance, or ``None`` if unusable.

    Answers ``None`` -- never raises -- so the caller owns the degrade. Three
    conditions: a literal :data:`_WHEEL_OK_STATUS`, which is the strict equality
    that makes ``refused``, ``empty``, and any status a future creek adds all
    degrade rather than be mined for numbers; a ``wheel`` that is a mapping; and
    a usable entry for *every* Frequency code. That last one is all-or-nothing on
    purpose: one bad Frequency rejects the whole read rather than yielding a ring
    with a hole in it.
    """
    if payload.get("status") != _WHEEL_OK_STATUS:
        return None
    wheel = payload.get("wheel")
    if not isinstance(wheel, Mapping):
        return None
    aspects = _wheel_aspects(wheel)
    if len(aspects) != len(_WHEEL_FREQUENCY_CODES):
        return None
    return VaultWheelBalance(aspects=aspects)


def _wheel_balance_from(payload: Mapping[str, object] | None) -> VaultWheelBalance | None:
    """Project a decoded 2xx wheel body onto a domain balance, or ``None``.

    Four refusals, in the order that makes each meaningful: a body that was not a
    JSON object at all, a body missing a field Creek's own schema marks required,
    a body whose echoed ceiling is wider than the one adepthood was willing to
    accept, and finally a wheel :func:`_parse_wheel` cannot read.

    It takes a decoded mapping rather than a response because there is nothing
    about a socket in any of those four questions -- which is what lets the whole
    wheel reading live here, beside the reflection's and the pipeline's, instead
    of in the adapter that happens to have fetched it.
    """
    if payload is None or not all(name in payload for name in _WHEEL_RESPONSE_REQUIRED_FIELDS):
        return None
    if not _ceiling_admissible(payload["tier_ceiling"], _WHEEL_TIER_CEILING):
        return None
    return _parse_wheel(payload)


# What a caller is told when a vault answered a wheel it could not read. Built
# from the same closed vocabulary every other message here is, so no branch can
# put a vault-chosen string in front of an operator.
_WHEEL_UNREADABLE_MESSAGE = _capability_message(_RESPONSE_UNREADABLE, CreekCapability.WHEEL)
