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

from collections.abc import Mapping

from domain.creek_vault import (
    CreekCapability,
    CreekVaultCareEscalationError,
    CreekVaultPayloadError,
    VaultIngestAction,
    VaultIngestRequest,
    VaultIngestResult,
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    WireTierCeiling,
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
