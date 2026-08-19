"""Concrete Creek Vault client adapters and their factory.

This is the service-layer counterpart to the pure :mod:`domain.creek_vault`
seam, following the same domain-protocol -> service-adapter pattern as
:mod:`services.marginalia` and the env-var config / error-normalization pattern
as :mod:`services.botmason`.

Two implementations of :class:`~domain.creek_vault.CreekVaultClient` live here:

* :class:`HttpCreekVaultClient` -- talks to a real vault over plain HTTP/JSON,
  handshaking with a single ``GET /v1/capabilities``. It is written to
  **degrade, never crash**: :meth:`~HttpCreekVaultClient.handshake` swallows
  every transport, parsing, and version-mismatch failure into
  :meth:`HandshakeResult.unavailable`, and every per-capability call normalizes
  any transport exception to :class:`CreekVaultUnavailableError` with a
  **static, capability-named message** that never echoes the entry body or the
  API key. It additionally records *which* failure mode degraded it
  (:class:`HandshakeDegradeReason`) so contract-version skew stays countable
  apart from a vault that is merely unreachable, one that is merely slow, and
  one that refused our credential.
  Journal ingest, the wheel read, and the reflection are the capabilities whose
  ``/v1`` shapes Creek has ratified, so they are wired up -- a ``PUT`` of the
  entry's own URL, a parameterless ``GET`` of the whole-corpus aggregate, and a
  ``POST`` of the reflections collection; classify alone still refuses, because
  guessing an unratified wire format is worse than staying local. A failed
  ingest is *dropped*, not queued -- there is no retry and no backlog today, and
  the local Postgres row stays the system of record either way.
* :class:`LocalFallbackCreekVaultClient` -- the no-vault path. Handshake reports
  unavailable, nothing is supported, ingest is a silent no-op (operator Postgres
  stays the system of record), and the read/compute capabilities raise
  :class:`CreekCapabilityUnsupportedError`.

HTTP/JSON over ``/v1`` is the whole application boundary, per Decision 1 of
``docs/adr/0004-creek-vault-http-application-boundary.md``. Adepthood once
reached a vault over an MCP client of its own as well; that client is retired,
and MCP remains what the ADR says it is -- Creek's adapter for *agents*, served
by Creek and called by nothing in this repository.

:func:`build_creek_vault_client` chooses between the two from
``CREEK_VAULT_URL`` (unset means the local fallback, so an unconfigured
deployment transparently degrades) and ``CREEK_VAULT_PROTOCOL``, which now
admits exactly one value. Nothing here is ever guessed at, since guessing a
transport would send vault traffic somewhere the operator did not choose --
but every way the configuration can be unusable degrades to the local fallback
with one WARNING rather than raising: a stale ``mcp`` selector, a selector
nobody ever supported, and a ``CREEK_VAULT_URL`` no transport can be built for
alike. This factory runs inside a per-request dependency, so a raise there would
cost the writer their entry over an optional capability. It answers that
question and no other: *who* may hold a configured client is settled one layer
up, in :mod:`dependencies.creek_vault`, because a vault reached under a single
deployment-wide identity is one shared corpus rather than any user's.

Transport security: a URL is refused outright if it is one this seam cannot
safely bind the ``CREEK_VAULT_API_KEY`` bearer credential to -- plaintext
``http://`` to any non-loopback host, because the credential must never cross a
network in cleartext; userinfo, which is itself a credential that httpx would
log unmasked and turn into a Basic-auth downgrade of our bearer; a query or
fragment, either of which would silently redirect the credential away from the
endpoint the operator configured; and a value that parses to no host, or does
not parse at all, which no request could ever be built from. Deciding which of
those a given string is belongs to :mod:`services.creek_vault_url`, a
stdlib-only leaf that reads no environment and holds no credential; what to *do*
about the answer is decided here.
:func:`unusable_creek_vault_url` names which of those a configured value is,
and the two callers answer it differently *on purpose*.
:class:`HttpCreekVaultClient` fails closed at construction, before the key is
bound to anything: reaching its constructor with a URL nobody classified is a
programming error, and it does not run on a request path, so it stays loud.
:func:`build_creek_vault_client` does run on one, per request, so it warns and
returns the local fallback -- the credential still never reaches the suspect
URL, because no HTTP adapter is built at all.
:class:`HttpCreekVaultClient` speaks request/response JSON over a shared,
credential-free pooled connection (:class:`_VaultHttpPool`), building its
authorization header per call so the pooled connection never holds the key. This
seam does not itself encrypt the entry *body*: the end-to-end, ciphertext-only
intimate-transit rule of Decision 6 in
``docs/adr/0004-creek-vault-http-application-boundary.md`` (a user-held key the
operator cannot decrypt) is enforced where the body is assembled, in the write
path built on this seam -- out of scope here, not forgotten.

Every attempt made through either adapter is counted exactly once by
:mod:`services.creek_vault_telemetry`, which is the only place an operator can
see a seam that degrades in silence.

Cross-references ``docs/creek-vault-mcp-contract.md`` for the shipped
per-capability fallback rules; Creek's published contract owns the wire shapes.
"""

from __future__ import annotations

import asyncio
import enum
import logging
import os
from collections.abc import Callable, Mapping, Sequence
from http import HTTPStatus
from types import MappingProxyType, TracebackType
from typing import NoReturn, cast
from urllib.parse import quote

import httpx

from domain.constants import TOTAL_STAGES
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultCareEscalationError,
    CreekVaultClient,
    CreekVaultContractError,
    CreekVaultError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultErrorCode,
    VaultIngestAction,
    VaultIngestRequest,
    VaultIngestResult,
    VaultReflection,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultWheelAspect,
    VaultWheelBalance,
    WireTierCeiling,
    wire_ceiling_for,
)
from services.creek_vault_payload import (
    _CALL_FAILED,
    _CREDENTIAL_REJECTED,
    _REFLECT_UNREADABLE_MESSAGE,
    _REQUEST_REJECTED,
    _RESPONSE_UNREADABLE,
    _bounded_text,
    _capability_message,
    _ceiling_admissible,
    _parse_reflection_result,
    _reflection_request_body,
)
from services.creek_vault_telemetry import (
    VaultCallTimedOutError,
    VaultTelemetryOutcome,
    code_for_error,
    outcome_for_error,
    record_vault_outcome,
)
from services.creek_vault_url import VaultUrlDefect, VaultUrlFinding, classify_vault_url

_LOGGER = logging.getLogger(__name__)

# Timeout (seconds) for a single HTTP call to the vault. Bounds how long a slow
# or hung vault can block a request before adepthood degrades to local.
_VAULT_TIMEOUT_SECONDS = 10.0

# The same budget applied to each phase of an HTTP call separately -- connect,
# read, write, and pool acquisition -- rather than as httpx's bare scalar. Naming
# every phase means none can silently inherit an unbounded default: a vault that
# accepts the connection and then goes quiet is bounded by the read phase, and a
# starved connection pool is bounded by the pool phase. These are per-phase
# budgets, *not* a request deadline -- httpx restarts the read budget on every
# socket read, so a vault that trickles stays inside all four indefinitely.
# Bounding the call as a whole is :data:`_VAULT_TOTAL_DEADLINE_SECONDS`'s job.
_VAULT_HTTP_TIMEOUT = httpx.Timeout(
    connect=_VAULT_TIMEOUT_SECONDS,
    read=_VAULT_TIMEOUT_SECONDS,
    write=_VAULT_TIMEOUT_SECONDS,
    pool=_VAULT_TIMEOUT_SECONDS,
)

# How many per-phase budgets one whole capability fetch may span. Three is the
# count of phases a single GET actually traverses -- pool acquisition, connect,
# read -- so a request that is legitimately slow at every one of them still
# finishes inside the deadline, while a vault that never finishes does not.
_VAULT_DEADLINE_PHASE_BUDGETS = 3

# Wall-clock ceiling (seconds) on one whole capability fetch. Necessary because
# httpx's phase budgets are not a request deadline: the ``read`` timeout is
# restarted by every socket read, so a vault trickling one byte just inside it
# stays within all four budgets forever while holding a pooled connection and a
# worker -- and the journal write path handshakes on every write.
_VAULT_TOTAL_DEADLINE_SECONDS = _VAULT_TIMEOUT_SECONDS * _VAULT_DEADLINE_PHASE_BUDGETS

# How a "MAJOR.MINOR.PATCH" version string decomposes, and how many of its
# leading components must match for two contract versions to interoperate. ADR
# 0004 Decision 4: while the contract is pre-1.0 a minor bump *is* the breaking
# change, so client and server must match on exact major.minor; from 1.0 onward
# minors are forward-compatible and only the major must match.
_VERSION_MAJOR_INDEX = 0
_PRE_1_0_MAJOR = "0"
_PRE_1_0_MATCHED_COMPONENTS = 2
_POST_1_0_MATCHED_COMPONENTS = 1

# Creek requires an ``X-Creek-Contract-Version: <major.minor>`` header on every
# ``/v1`` *capability* call and refuses a missing or mismatched one with
# ``409 incompatible_version`` before any vault read. ``GET /v1/capabilities`` is
# exempt by design -- the negotiation endpoint must never itself be able to fail
# to negotiate -- which is why sending it is a per-call decision rather than a
# default baked into the pooled client.
_CONTRACT_VERSION_HEADER = "X-Creek-Contract-Version"

# Creek admits every ``/v1`` request at the ceiling this header declares, and
# **defaults an absent one to ``open``** -- the most restrictive value, chosen so
# an omitted header can only ever fail closed on the server's side. That default
# is why the header is not optional here: ``open`` cannot admit a ``personal``
# write, and ``personal`` is adepthood's default journal classification, so a
# client that omits the header has every default entry refused and reads a wheel
# computed over open-tier material alone. It is one of the two standing ``Vary``
# tokens upstream, so it is also what keeps one caller's ceiling-filtered answer
# out of another's cache.
_CEILING_HEADER = "X-Creek-Tier-Ceiling"

# The ceiling a call carrying no user content declares. Only the capability
# handshake qualifies: it names no entry and reads no fragment, so the narrowest
# ceiling is the honest one, and declaring it explicitly means no request leaves
# this adapter relying on a server-side default to be what we assumed.
_CONTENT_FREE_CEILING = WireTierCeiling.OPEN

# The header carries ``major.minor`` wherever the contract sits relative to 1.0,
# so this is its own width rather than a reuse of the pre-1.0 match width above,
# which shares the value but not the meaning.
_CONTRACT_MINOR_COMPONENTS = 2
CONTRACT_MINOR = ".".join(CONTRACT_VERSION.split(".")[:_CONTRACT_MINOR_COMPONENTS])

# Every way an httpx call can fail to land, whether it left this process or
# not. ``OSError`` covers connection and timeout errors (the whole-request
# deadline raises ``TimeoutError``, an ``OSError`` subclass), and
# ``httpx.HTTPError`` covers every transport and status failure.
# ``httpx.InvalidURL`` has to be named separately because it is *not* an
# ``HTTPError`` -- httpx raises it, from outside its own hierarchy, while
# building the request, so an unparseable vault URL would otherwise escape every
# degrade set and turn an optional replication into an exception on the caller's
# request path. A URL httpx cannot build a request for is unreachable in exactly
# the sense a refused connection is (the construction-time validator already
# refused the *unsafe* URLs, which is a different question), so it degrades the
# same way rather than raising.
_HTTP_CALL_FAILED_ERRORS: tuple[type[Exception], ...] = (
    OSError,
    httpx.HTTPError,
    httpx.InvalidURL,
)

# The two ways a call can end because it ran out of time rather than because it
# failed to land. Both are already inside :data:`_HTTP_CALL_FAILED_ERRORS` --
# ``TimeoutError`` is an ``OSError`` and ``httpx.TimeoutException`` is an
# ``httpx.HTTPError`` -- so every ``except`` that wants to tell a slow vault from
# an absent one has to name this set *first* or the wider one silently swallows
# it. The distinction is worth the ordering: an operator reading "unreachable"
# goes looking for a network that is up, while a timeout says the vault answered
# and could not finish, whose remedy is capacity rather than connectivity.
_HTTP_CALL_TIMED_OUT_ERRORS: tuple[type[Exception], ...] = (
    TimeoutError,
    httpx.TimeoutException,
)

# Longest vault-issued fragment id adepthood will keep as an entry's durable
# reference. Opaque handles are short by nature -- a UUID is 36 characters -- so
# this is generous by nearly an order of magnitude, and it is a *bound*, not a
# format: the vault owns the shape of its own ids. It exists because that string
# is persisted verbatim into a journal entry's unbounded ``vault_ref`` text
# column on every save, which without a ceiling lets a compromised vault grow
# the operator's database by as much as it cares to answer with.
_MAX_FRAGMENT_ID_LENGTH = 256

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

# Payload-parsing failures. A malformed or wrong-typed handshake response should
# degrade to unavailable exactly like a transport error, never propagate.
_PARSE_ERROR_TYPES: tuple[type[Exception], ...] = (KeyError, TypeError, AttributeError, ValueError)


class _IncompatibleContractVersionError(Exception):
    """A vault advertised a contract version this client will not interoperate with.

    Module-private and control-flow only: it exists so a version mismatch stays
    *distinguishable* from an unreachable or malformed vault while still
    degrading to the same caller-visible unavailable result (ADR 0004
    Decision 4). It carries no payload, so it can never echo a vault response.
    Deliberately not a :class:`~domain.creek_vault.CreekVaultError`: it never
    escapes this module.
    """


# Where the vault lives. Public, and the only one of this seam's variable names
# that is, because :mod:`main` names it in the boot record it emits about it --
# exactly as ``client_ip`` publishes the throttle-prefix variable name, and for
# the same reason: one spelling, so a check and the record announcing it can
# never name different variables.
CREEK_VAULT_URL_ENV_VAR = "CREEK_VAULT_URL"

# Which transport a *configured* vault is reached over, and the one value that
# selector still admits. It survives as a selector at all so a stale setting left
# in a deployment's environment is never silently reinterpreted as the transport
# it is not: whatever else adepthood does about one, it does not guess.
_PROTOCOL_ENV_VAR = "CREEK_VAULT_PROTOCOL"
_PROTOCOL_HTTP = "http"

# The one selector adepthood used to honour and no longer does. Named as its own
# constant because it is the one stale value whose *intent* is knowable -- this
# repository's own env template prescribed it until the MCP application transport
# was retired -- which is what lets :func:`build_creek_vault_client` treat it
# differently from a value it never supported.
_PROTOCOL_RETIRED_MCP = "mcp"

# The one static log event this module emits, and the fields that travel with it.
# Static for the same reason every record in this seam is: a message assembled
# from configuration is a message that can carry the vault URL or the bearer
# credential into a log. Both field values are this module's own constants rather
# than anything read from the environment, so there is nothing here to scrub. The
# message carries the remedy because a record naming only the fault would leave an
# operator to rediscover which selector is still honoured.
_RETIRED_PROTOCOL_EVENT = (
    "creek vault protocol selector is retired; using the local fallback -- "
    "unset CREEK_VAULT_PROTOCOL or set it to http"
)
# The same shape for a selector adepthood never supported. A second message
# rather than one shared with the retired value, because the two are different
# news: "the transport you asked for is gone" tells an operator their deployment
# has drifted, while "nobody has heard of this" almost always means a typo, and a
# record that conflated them would send half its readers looking for the wrong
# thing. The offending value travels as a structured field rather than in the
# message so the message stays the static, greppable constant every record in
# this seam is -- the value is the operator's own configuration, never a
# credential and never anything a user or a vault chose.
_UNKNOWN_PROTOCOL_EVENT = (
    "creek vault protocol selector is not recognized; using the local fallback -- "
    "unset CREEK_VAULT_PROTOCOL or set it to http"
)
# The third way a deployment lands on the local fallback with something wrong in
# its environment: the selector is honoured, but the URL it points at is one no
# transport can be built for. A third message rather than a share of either
# protocol one, because an operator reading a degrade needs to know *which
# variable* to go and look at, and a record that named the selector for a typo in
# the URL would send them to the wrong file. Static and value-free like its
# siblings: what was configured travels as structured fields, and the one field
# that could carry a value carries a component name instead -- see
# :func:`~services.creek_vault_url.classify_vault_url`. One message for all four
# defects, with the defect itself as a field, on the same reasoning
# :mod:`dependencies.creek_vault`'s
# ``binding`` field follows: a dashboard should be able to count "the vault URL
# is unusable" without unioning four filters, and still break it down when it
# wants to.
_UNUSABLE_URL_EVENT = (
    "creek vault URL is unusable; using the local fallback -- "
    "fix CREEK_VAULT_URL or unset it to run without a vault"
)


def _protocol_fields(protocol: str) -> Mapping[str, str]:
    """Build the structured fields both unhonoured-selector records carry.

    One builder rather than two literals so the two branches cannot drift apart
    on a key name: a dashboard filtering on ``protocol`` should find the retired
    selector and the unrecognized one in the same query, since to an operator
    they are the same question ("what did my deployment ask for, and what will it
    actually do?") asked of two different answers.
    """
    return {"protocol": protocol, "supported_protocol": _PROTOCOL_HTTP}


# What the constructor says about each defect, keyed rather than branched so the
# refusal is a lookup and the four wordings sit where they can be read together.
# The environment variable's name is prefixed at the raise site rather than
# written into each clause, so no future member can be added that forgets to name
# the variable an operator has to go and fix. The forbidden-components and
# insecure-transport wordings are the ones this seam has always used and are
# preserved verbatim: they are in runbooks.
_REFUSAL_CLAUSES: Mapping[VaultUrlDefect, str] = {
    VaultUrlDefect.UNPARSEABLE: "is unusable: {detail}",
    VaultUrlDefect.FORBIDDEN_COMPONENTS: "must not carry these URL components: {detail}",
    VaultUrlDefect.MALFORMED: "is missing required URL components: {detail}",
    VaultUrlDefect.INSECURE_TRANSPORT: "must use https for a non-loopback host ({detail})",
}


def unusable_creek_vault_url() -> VaultUrlFinding | None:
    """Return what the runtime cannot use about the configured vault URL, else ``None``.

    Exists so a caller that *can* log once -- boot -- can say what the
    per-request path would otherwise only ever say at request rate, mirroring
    :func:`client_ip.unusable_throttle_prefix_config` for the same kind of
    setting.

    Unset and blank both answer ``None``. ``backend/.env.example`` ships
    ``CREEK_VAULT_URL`` present and empty, so treating blank as a fault would
    fire on every stock boot and teach operators to scroll past the finding that
    matters -- and running with no vault is this product's supported floor, not a
    misconfiguration. :func:`build_creek_vault_client` asks the same question the
    same way, deliberately: a variable holding nothing but a stray space would
    otherwise be unset to this check and configured-but-broken to the factory,
    which is the worst pairing available -- silence at boot, where an operator is
    actually looking, and a WARNING on every request, where it costs the most.
    """
    raw = os.getenv(CREEK_VAULT_URL_ENV_VAR)
    if raw is None or not raw.strip():
        return None
    return classify_vault_url(raw)


def _require_secure_vault_url(url: str) -> None:
    """Reject a vault URL that is unsafe to bind a credential to, failing closed.

    Guards the configured transport, :class:`HttpCreekVaultClient`, which sends
    the ``CREEK_VAULT_API_KEY`` bearer credential over the wire on every request
    -- so any future transport must keep calling it too. It is a free function
    rather than a method for exactly that reason: the rule belongs to the
    credential, not to whichever adapter happens to be carrying it today.

    It raises where :func:`build_creek_vault_client` degrades, and the asymmetry
    is the design rather than an oversight. The factory sits behind a per-request
    dependency, so a raise there costs the writer their entry over an optional
    capability. This constructor does not: a caller reaching it with a URL nobody
    classified is a programming error, and letting that through would bind the
    bearer credential to an endpoint no check approved. So it stays loud.

    The message names the variable an operator has to go and fix, repeats the
    finding's detail, and carries nothing else -- never the API key, never
    userinfo, never the configured value.

    ``from None`` is not decoration. The classifier
    (:func:`~services.creek_vault_url.classify_vault_url`) has already
    discarded the parser's exception, so nothing is being suppressed here today;
    the clause states the invariant at the boundary that must never regress,
    because the object it keeps out is the one guaranteed to quote a netloc --
    userinfo included -- into whatever traceback a 500 handler renders.
    :func:`_refuse_unratified` cuts its chain for the same reason.
    """
    finding = classify_vault_url(url)
    if finding is None:
        return
    clause = _REFUSAL_CLAUSES[finding.defect].format(detail=finding.detail)
    raise ValueError(f"{CREEK_VAULT_URL_ENV_VAR} {clause}") from None


def _url_defect_fields(finding: VaultUrlFinding) -> Mapping[str, str]:
    """Build the structured fields the unusable-URL degrade record carries.

    A builder rather than a literal at the call site, for the reason
    :func:`_protocol_fields` is one: the key names are what a dashboard groups
    on, so they belong in one place. Three fields and no fourth -- the variable,
    the defect, and the defect's value-free detail. What is deliberately absent
    is the configured URL itself: it is the one setting most likely to have a
    credential pasted into it, and this record is emitted on the writer's request
    path, at request rate, into whatever aggregator the deployment ships to.
    """
    return {
        "env_var": CREEK_VAULT_URL_ENV_VAR,
        "url_defect": finding.defect.value,
        "url_detail": finding.detail,
    }


def _require_str(payload: Mapping[str, object], key: str) -> str:
    """Return ``payload[key]`` as a ``str`` or raise so parsing fails closed.

    Raises ``KeyError`` when absent and ``TypeError`` when present but not a
    string; both are caught upstream and degrade the handshake to unavailable.
    """
    value = payload[key]
    if not isinstance(value, str):
        raise TypeError(f"handshake field {key!r} must be a string")
    return value


# Creek advertises its capabilities under these published names.
# :class:`CreekCapability` spells the same ideas as ``creek.*`` values, which are
# deliberately *adepthood's* vocabulary and telemetry keys rather than a claim
# about the wire (see that enum's docstring). The translation therefore lives
# here, at the parse boundary, and nowhere else.
#
# Five of the seven members have a published name. SAVE and CLASSIFY are
# adepthood-side concepts Creek does not advertise at all, so :meth:`supports`
# is permanently ``False`` for them and every capability-gated path degrades.
# That is the contract reporting a capability that does not exist, not a hole in
# this table -- do not invent wire names for them.
#
# ``upload`` is the one that moved. It was in that same list until contract
# 0.8.0 published it as a real ``/v1`` capability served by ``POST /v1/uploads``.
# Two things follow, and only the first is done here: the name is now
# recognised, so a vault advertising it is believed; and what a vault advertises
# is keyed upstream on the *caller's* contract minor, so a deployment pinned
# below 0.8 is never told about it and degrades exactly as before. Recognising
# the name is not the same as being able to call the route -- the adapter still
# refuses the call itself, because inventing a request shape is what this seam
# exists to prevent.
_CAPABILITY_BY_WIRE_NAME: Mapping[str, CreekCapability] = MappingProxyType(
    {
        "capabilities": CreekCapability.HANDSHAKE,
        "journal-upsert": CreekCapability.JOURNAL,
        "reflections": CreekCapability.REFLECT,
        "wheel": CreekCapability.WHEEL,
        "upload": CreekCapability.UPLOAD,
    }
)


def _coerce_capability(item: object) -> CreekCapability | None:
    """Map one advertised wire name to a capability, or ``None`` if unknown.

    Unknown/forward-compatible capability strings are dropped rather than
    erroring, so a vault can advertise new capabilities without breaking an
    older client.
    """
    if not isinstance(item, str):
        return None
    return _CAPABILITY_BY_WIRE_NAME.get(item)


def _parse_capabilities(raw: object) -> frozenset[CreekCapability]:
    """Narrow an advertised capability list to the known-capability set.

    Raises ``TypeError`` when ``raw`` is not a list (a malformed payload), which
    upstream degrades to unavailable. Unknown member strings are ignored.
    """
    if not isinstance(raw, list):
        raise TypeError("handshake capabilities must be a list")
    return frozenset(
        capability for item in raw if (capability := _coerce_capability(item)) is not None
    )


def _parse_attestation(raw: object) -> Mapping[str, object] | None:
    """Return the attestation mapping unchanged, or ``None`` when absent.

    Raises ``TypeError`` for a present-but-wrong-typed value so a malformed
    payload degrades to unavailable.
    """
    if raw is None:
        return None
    if isinstance(raw, Mapping):
        return raw
    raise TypeError("handshake attestation must be a mapping or null")


def _contract_version_compatible(advertised: str, pinned: str = CONTRACT_VERSION) -> bool:
    """Return whether a vault's ``advertised`` contract version is safe to call.

    Implements ADR 0004 Decision 4. While ``pinned`` is pre-1.0 the comparison is
    on exact ``major.minor``: with the major stuck at ``0`` a major-only check is
    a no-op, and a pre-1.0 minor bump is precisely the breaking change worth
    catching (``0.3.0`` against a ``0.2.x`` pin is rejected; ``0.2.7`` against
    ``0.2.1`` is accepted -- patch is free to vary). From 1.0 onward the rule
    relaxes to a major match, since minors are then forward-compatible.

    ``pinned`` is a parameter rather than a closed-over constant so the post-1.0
    branch is exercisable while the shipped pin is still pre-1.0.
    """
    pinned_components = pinned.split(".")
    matched = (
        _PRE_1_0_MATCHED_COMPONENTS
        if pinned_components[_VERSION_MAJOR_INDEX] == _PRE_1_0_MAJOR
        else _POST_1_0_MATCHED_COMPONENTS
    )
    return advertised.split(".")[:matched] == pinned_components[:matched]


def _require_str_sequence(payload: Mapping[str, object], key: str) -> Sequence[str]:
    """Return ``payload[key]`` as a sequence of strings or raise so parsing fails closed.

    Raises ``KeyError`` when absent and ``TypeError`` when present but not an
    array of strings; both are caught upstream and degrade the handshake to
    unavailable. A bare ``str`` is rejected rather than accepted as a
    one-element sequence, because iterating one would compare single characters
    and quietly find no match.
    """
    value = payload[key]
    if isinstance(value, str) or not isinstance(value, Sequence):
        raise TypeError(f"handshake field {key!r} must be an array of strings")
    if not all(isinstance(item, str) for item in value):
        raise TypeError(f"handshake field {key!r} must contain only strings")
    return cast("Sequence[str]", value)


def _contract_minor_supported(supported: Sequence[str], pinned: str = CONTRACT_VERSION) -> bool:
    """Return whether the vault still serves the contract minor adepthood speaks.

    The refinement of ADR 0004 Decision 4 recorded in that ADR's 2026-08-09
    amendment. The original rule compared adepthood's pin against the single
    version a server advertises as its own, which is strictly more brittle than
    the contract requires: Creek publishes ``supported_contract_minors``
    precisely so a server can widen its window without cutting clients off, and
    it did exactly that on moving to 0.3.0 while continuing to serve 0.2. Under
    the old rule adepthood refused that server while it was actively advertising
    that it would answer.

    Per entry the comparison is unchanged -- :func:`_contract_version_compatible`
    still decides what compatible means, including the post-1.0 relaxation to a
    major match -- so this widens *what* is compared against, not *how*.
    """
    return any(_contract_version_compatible(minor, pinned) for minor in supported)


def _parse_handshake(payload: Mapping[str, object]) -> HandshakeResult:
    """Parse a well-formed handshake payload into a populated result.

    Reads and version-checks the contract before anything else: an incompatible
    version raises :class:`_IncompatibleContractVersionError` (we will not call a
    surface we do not understand), which every caller degrades to unavailable.
    Then honors the vault's own availability, fail-closed: a reachable server is
    not necessarily an available vault, so anything other than a literal ``True``
    -- a missing ``vault`` object, a missing or wrong-typed ``available`` inside
    it -- degrades to unavailable. Creek publishes that flag *nested* under
    ``vault``; reading a top-level ``available`` (which its documents do not
    carry) is what made every handshake against a conformant vault report
    unavailable. Any missing key or wrong-typed field raises out of the helpers
    and is caught by :meth:`HttpCreekVaultClient._probe`.
    """
    contract_version = _require_str(payload, "contract_version")
    if not _contract_minor_supported(_require_str_sequence(payload, "supported_contract_minors")):
        raise _IncompatibleContractVersionError
    vault = payload.get("vault")
    if not isinstance(vault, Mapping) or vault.get("available") is not True:
        return HandshakeResult.unavailable()
    return HandshakeResult(
        available=True,
        contract_version=contract_version,
        ontology_version=_require_str(payload, "ontology_version"),
        capabilities=_parse_capabilities(payload["capabilities"]),
        attestation=_parse_attestation(payload.get("attestation")),
    )


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


def _unsupported_message(capability: CreekCapability) -> str:
    """Build the body/key-free message for an unsupported-capability error.

    Kept here so both the reachable-but-unadvertised paths in
    :class:`HttpCreekVaultClient` and the no-vault-configured paths in
    :class:`LocalFallbackCreekVaultClient` derive the wire name from
    :class:`~domain.creek_vault.CreekCapability` rather than duplicating it as a
    literal that could silently drift from the enum.
    """
    return f"creek vault capability unsupported: {capability.value}"


class _CountingOutcome:
    """Count whatever vault failure escapes this block, then let it go on its way.

    The failure half of "one attempt, one outcome". Every wired capability wraps
    its real body in one of these and the body records its *own* success on the
    way out, so exactly one outcome is counted whichever way the call ends: the
    wrapper only ever fires on the exception path and the body only ever on the
    return path. That is a property of the structure rather than of each branch
    remembering to do it.

    A plain synchronous context manager even though every block it guards is
    ``await``-ing. It needs nothing from the event loop -- it looks at an
    exception on the way out and nothing else -- and staying synchronous keeps it
    non-generic, so the four capabilities' four different return types travel
    through it unchanged and untyped-around.

    Three things it deliberately does not do. It never matches bare ``Exception``
    or ``BaseException``: a cancellation must pass through untouched, and an
    unrelated internal bug must stay the loud defect it is rather than being
    relabelled a vault fault. It returns ``None`` from :meth:`__exit__`, so
    nothing is ever swallowed -- the caller sees precisely the exception it would
    have seen before telemetry existed. And it holds no state beyond the
    capability label, so nesting or reusing one is meaningless rather than
    dangerous.

    :class:`~domain.creek_vault.CreekVaultCareEscalationError` is matched
    alongside the error hierarchy precisely because it sits deliberately outside
    it: it is a successful, published answer that happens to arrive as an
    exception, and an escalation nobody counted is an escalation nobody knows
    happened.
    """

    def __init__(self, capability: CreekCapability) -> None:
        """Store the capability every outcome counted here is labelled with."""
        self._capability = capability

    def __enter__(self) -> None:
        """Enter the guarded block; there is nothing to set up."""

    def __exit__(
        self,
        _exc_type: type[BaseException] | None,
        error: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        """Count a vault failure on the way out, and never suppress it."""
        if isinstance(error, CreekVaultError | CreekVaultCareEscalationError):
            record_vault_outcome(
                outcome_for_error(error), self._capability, code=code_for_error(error)
            )


class HandshakeDegradeReason(enum.StrEnum):
    """Why a handshake degraded to :meth:`HandshakeResult.unavailable`.

    Callers still see exactly one degraded state -- that is the whole point of
    the unavailable result -- but operators need these apart: a contract-version
    skew is a coordination problem with a specific remedy (align the two pins),
    while an unreachable vault is an infrastructure problem, and a malformed
    payload is a vault bug. Values are the wire strings telemetry counts by, so
    they are part of this module's contract and must not be reworded casually.

    ``UNREACHABLE`` is the widest of these and its name still slightly
    overstates it: a 500 (a vault-side fault) lands there too, so telemetry
    should read it as "the call did not complete", not strictly as "the network
    is down".

    ``TIMED_OUT`` and ``AUTH`` are each carved out of exactly that width, and
    both sit after the members that predate them because these values are
    appended, never inserted or reordered -- they are the strings telemetry
    counts by, so moving one silently re-labels a historical series.

    A refused connection and a probe that ran out of time are both "no usable
    vault" to a caller, but they are not the same problem: a refusal says nothing
    answered, while a timeout says something did answer and then could not
    finish, so one remedy is to restore the vault and the other is to give it
    capacity. Collapsed together, the second reads as the first and sends an
    operator hunting a network that is perfectly fine.

    ``AUTH`` splits off for the same shape of reason. A refused credential and an
    unreachable vault are both "no usable vault" too, but their remedies are
    opposite: rotate a key, or go and see whether the vault is up. Collapsed
    together -- as they were -- an operator whose key was rotated out from under
    them spends the incident checking a network that is perfectly healthy.
    """

    UNREACHABLE = "unreachable"
    MALFORMED_PAYLOAD = "malformed_payload"
    INCOMPATIBLE_VERSION = "incompatible_version"
    VAULT_REPORTED_UNAVAILABLE = "vault_reported_unavailable"
    TIMED_OUT = "timed_out"
    AUTH = "auth"


# Which outcome each handshake result is counted as. A table rather than a branch
# tree, so attributing a probe costs a lookup and adding a degrade reason costs a
# line: the ``None`` key is the successful probe, and the two availability
# reasons deliberately share :attr:`~VaultTelemetryOutcome.UNAVAILABLE` because a
# vault that reported itself unavailable and one that could not be reached are
# the same story to whoever is on call. The distinction they *do* keep lives in
# :attr:`HttpCreekVaultClient.last_degrade_reason`, which is a finer instrument
# for a narrower question.
_HANDSHAKE_OUTCOME_BY_DEGRADE_REASON: Mapping[
    HandshakeDegradeReason | None, VaultTelemetryOutcome
] = {
    None: VaultTelemetryOutcome.SUCCESS,
    HandshakeDegradeReason.TIMED_OUT: VaultTelemetryOutcome.TIMEOUT,
    HandshakeDegradeReason.UNREACHABLE: VaultTelemetryOutcome.UNAVAILABLE,
    HandshakeDegradeReason.VAULT_REPORTED_UNAVAILABLE: VaultTelemetryOutcome.UNAVAILABLE,
    HandshakeDegradeReason.MALFORMED_PAYLOAD: VaultTelemetryOutcome.SCHEMA_FAILURE,
    HandshakeDegradeReason.INCOMPATIBLE_VERSION: VaultTelemetryOutcome.INCOMPATIBLE_VERSION,
    HandshakeDegradeReason.AUTH: VaultTelemetryOutcome.AUTH_FAILED,
}

# The vault's capability document, relative to the configured base URL.
_CAPABILITIES_PATH = "/v1/capabilities"

# The collection a journal entry is upserted into, relative to the configured
# base URL. One entry is one resource: the write is a ``PUT`` of the entry's own
# id, which is what makes a re-send idempotent (the vault edits the fragment it
# already keyed off that id instead of appending a second one). This and the
# capability document are the only ``/v1`` shapes Creek has ratified.
_JOURNAL_ENTRIES_PATH = "/v1/journal-entries/"


# The whole-corpus frequency aggregate, relative to the configured base URL. Not
# a resource but a computation over every admitted fragment, so it is read from
# one collection-level URL that takes no identifier -- and, on the ratified
# surface, no parameter of any kind either.
_WHEEL_PATH = "/v1/wheel"

# Where a reflection is asked for, relative to the configured base URL. A
# reflection is requested rather than addressed: adepthood posts an ad-hoc body
# to the collection instead of naming a fragment the vault already stores, so
# there is no per-resource URL to ``PUT`` the way a journal entry has.
_REFLECTIONS_PATH = "/v1/reflections"

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

# The percent-encoded form of ``.``, used to neutralize a dot segment in an
# entry id (see :func:`_entry_path_segment`). Uppercase because RFC 3986 names
# uppercase hex the normal form for percent-encoding.
_ENCODED_DOT = "%2E"

# Statuses that mean "your credential was refused" rather than "the vault is
# missing". Checked before any body parsing, since a gateway rejecting the
# bearer will not answer in the vault's error vocabulary at all.
_CREDENTIAL_REJECTED_STATUSES: frozenset[int] = frozenset(
    {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}
)

# The two 4xx statuses that are *not* a statement about the request we sent.
# The rest of the 4xx range faults our payload, but 408 says the vault's own
# clock ran out waiting and 429 says it is shedding load: both are "come back
# later" -- an availability story identical to a 5xx, and both are cured by
# waiting rather than by changing anything in adepthood. Classifying them as
# contract defects would send an operator hunting a bug that is not there.
_RETRYABLE_CLIENT_STATUSES: frozenset[int] = frozenset(
    {HTTPStatus.REQUEST_TIMEOUT, HTTPStatus.TOO_MANY_REQUESTS}
)

# Vault error codes that mean adepthood got the call wrong -- a bad payload, a
# capability we should not have claimed, a version we should not have pinned, a
# path this server does not serve, or a request for material above the ceiling
# that was declared. Every one of them is fixed by changing adepthood, so they
# map to a contract error, and Creek's own ``retry-policy.json`` marks all five
# terminal: retrying without changing the request cannot help.
#
# ``NOT_FOUND`` is a *routing* code in Creek's vocabulary -- no such endpoint --
# and is never emitted for a vault object, so it faults our URL rather than
# reporting an absent vault. ``PRIVACY_REFUSED`` means we asked for material
# above the declared ceiling, which is likewise ours to correct.
#
# ``TEMPORARILY_UNAVAILABLE`` and ``UNAVAILABLE`` are deliberately absent: both
# are the vault reporting on *itself*, which is an availability fault, and that
# is the same rule that kept the first of them out from the start.
_CONTRACT_ERROR_CODES: frozenset[VaultErrorCode] = frozenset(
    {
        VaultErrorCode.INVALID_REQUEST,
        VaultErrorCode.UNSUPPORTED_CAPABILITY,
        VaultErrorCode.INCOMPATIBLE_VERSION,
        VaultErrorCode.PRIVACY_REFUSED,
        VaultErrorCode.NOT_FOUND,
    }
)


# The static, capability-named messages the ingest, wheel, and reflection paths
# may raise with, interned so each is value-identical wherever it is used.
_INGEST_FAILED_MESSAGE = _capability_message(_CALL_FAILED, CreekCapability.JOURNAL)
_INGEST_REJECTED_MESSAGE = _capability_message(_REQUEST_REJECTED, CreekCapability.JOURNAL)
_CREDENTIAL_REJECTED_MESSAGE = _capability_message(_CREDENTIAL_REJECTED, CreekCapability.JOURNAL)
_WHEEL_FAILED_MESSAGE = _capability_message(_CALL_FAILED, CreekCapability.WHEEL)
_WHEEL_UNREADABLE_MESSAGE = _capability_message(_RESPONSE_UNREADABLE, CreekCapability.WHEEL)
_REFLECT_FAILED_MESSAGE = _capability_message(_CALL_FAILED, CreekCapability.REFLECT)

# The one not-stored result every unreadable 2xx collapses to. Interned because
# it is value-identical on each of those paths, and named so no branch is
# tempted to invent a ``vault_ref`` the vault never issued.
_NOT_STORED_RESULT = VaultIngestResult(stored=False, vault_ref=None, action=None)


def _build_pooled_vault_client() -> httpx.AsyncClient:
    """Build the process-wide vault HTTP client: bare, credential-free, budget-bound.

    Deliberately carries no ``base_url`` and no authorization header. The pooled
    connection is shared by every :class:`HttpCreekVaultClient` in the process,
    so binding a URL or a credential to it would both leak the key into a
    long-lived object and invalidate the pool whenever the vault is
    reconfigured. Each adapter supplies its own absolute URL and builds its own
    header per request; the pool contributes only the reused connection and the
    timeout budget.
    """
    # ``follow_redirects`` is pinned rather than inherited from httpx's default:
    # not following redirects is a security property here, not a preference.
    # httpx preserves an *explicitly set* ``Authorization`` header across a
    # same-scheme cross-host redirect, so a hijacked or compromised vault could
    # 302 our bearer straight to an attacker's host. Refusing to follow turns
    # that into a non-2xx status, which degrades the handshake to unreachable.
    return httpx.AsyncClient(timeout=_VAULT_HTTP_TIMEOUT, follow_redirects=False)


class _VaultHttpPool:
    """Lazily built, closable holder for the shared vault HTTP client.

    An object rather than a module-level mutable, so building and closing the
    connection pool needs no ``global`` rebinding and so a test can substitute a
    pool with a scripted factory. Building is deferred until the first request:
    constructing a vault adapter must not open a connection pool, since an
    adapter is built per call site while a deployment with no reachable vault
    should never allocate one at all.
    """

    def __init__(self, build: Callable[[], httpx.AsyncClient] | None = None) -> None:
        """Store the client factory (defaulting to the production one) unbuilt."""
        self._build = build if build is not None else _build_pooled_vault_client
        self._client: httpx.AsyncClient | None = None

    def get(self) -> httpx.AsyncClient:
        """Return the pooled client, building it on first use and reusing it after."""
        if self._client is None:
            self._client = self._build()
        return self._client

    async def aclose(self) -> None:
        """Close the pooled client if one was built; idempotent by design.

        Clears the slot before awaiting the close so a repeat call (shutdown can
        be reached by more than one path) is a silent no-op, and so a later
        :meth:`get` builds a fresh client rather than handing back a closed one.
        """
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()


# The process-wide pool every HTTP vault adapter borrows its connection from.
_VAULT_HTTP_POOL = _VaultHttpPool()


async def close_creek_vault_http_pool() -> None:
    """Release the shared vault HTTP connection pool (call at app shutdown)."""
    await _VAULT_HTTP_POOL.aclose()


def _refuse_unratified(capability: CreekCapability) -> NoReturn:
    """Refuse a capability whose request/response shape adepthood cannot know yet.

    Raised with ``from None`` so no upstream exception rides along as a cause or
    context -- the same privacy discipline the transport-error paths follow.
    """
    raise CreekCapabilityUnsupportedError(_unsupported_message(capability)) from None


def _entry_path_segment(entry_id: int) -> str:
    """Encode an entry id into exactly one path segment that cannot climb out of it.

    ``quote(..., safe="")`` blocks the obvious escape by encoding ``/``, but it
    leaves a dot alone even with nothing marked safe -- so a segment of ``..``
    survives encoding intact and every URL parser (httpx included) then
    normalizes it away, aiming the ``PUT`` one level above the journal
    collection. Encoding the dot with :data:`_ENCODED_DOT` is what makes the
    segment inert; a percent-encoded dot is not a dot segment, so nothing
    normalizes it. An id is an integer today, so this changes no URL adepthood
    actually builds -- it is here because the entry *body* is what rides on this
    request, and a future identifier type must not be able to redirect it by its
    shape alone.
    """
    return _inert_path_segment(str(entry_id))


def _inert_path_segment(raw: str) -> str:
    """Encode ``raw`` into exactly one path segment that cannot climb out of it.

    Factored out of :func:`_entry_path_segment` so the upload path gets the same
    guarantee from the same code rather than a second implementation that has to
    remember the dot rule independently -- and an upload's id is a string from
    the start, which is exactly the case that rule exists for.
    """
    return quote(raw, safe="").replace(".", _ENCODED_DOT)


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


def _vault_error_code(response: httpx.Response) -> VaultErrorCode | None:
    """Read the vault's own error code from an error body, parsing only what we know.

    Four narrowing steps, each of which fails to ``None`` rather than raising: a
    body that is not JSON, JSON that is not an object, a ``code`` that is not a
    string, and a string that is not one of :class:`VaultErrorCode`'s members.
    The last step is the security-relevant one -- an unrecognized code is
    *dropped*, never stored or echoed, so a compromised vault cannot inject text
    (control characters and all) into an exception message or a log record.
    """
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, Mapping):
        return None
    return _coerce_error_code(payload.get("code"))


def _coerce_error_code(raw: object) -> VaultErrorCode | None:
    """Map a wire ``code`` string onto our enum, dropping anything unrecognized."""
    if not isinstance(raw, str):
        return None
    try:
        return VaultErrorCode(raw)
    except ValueError:
        return None


def _faults_our_request(response: httpx.Response) -> bool:
    """Return whether an uncoded status blames the request adepthood sent.

    True for the 4xx range, minus :data:`_RETRYABLE_CLIENT_STATUSES` -- a
    throttled or timed-out call says nothing about the payload, so treating it
    as a contract defect would be a false accusation an operator then has to
    disprove.
    """
    return response.is_client_error and response.status_code not in _RETRYABLE_CLIENT_STATUSES


def _write_failure(
    response: httpx.Response,
    *,
    call_failed: str,
    request_rejected: str,
    credential_rejected: str,
) -> CreekVaultError:
    """Classify a non-2xx write response into the failure it actually is.

    Shared by both write capabilities -- journal ingest and document upload --
    because the *classification* is a property of the answer rather than of what
    was being written. Only the three static messages differ, and they are
    parameters precisely so each capability names itself in what it raises.

    The order encodes what each answer tells an operator to do:

    1. A code we recognize is authoritative over the status class. Creek
       publishes ``privacy_refused`` at 403, and 403 is also a
       credential-rejected status -- so deciding on status first reported a
       privacy refusal as a rejected credential, sending an operator to rotate
       a key that was never refused while the actual remedy (ask for less
       material) went unmentioned. The read paths consulted the code first for
       exactly this reason; this path now matches them.
    2. With no readable code, a credential-rejected status is a configuration
       fault with its own remedy. This is where the status-first rule was
       genuinely right and is kept: a gateway that rejects our bearer never
       reaches the vault's error vocabulary, so an uncoded 401 or 403 really is
       a credential problem.
    3. Otherwise the status class decides: a 4xx means the vault faulted the
       request we sent (ours to fix), and everything else -- 5xx, a redirect we
       refuse to follow -- means the call did not land (not ours).
       :data:`_RETRYABLE_CLIENT_STATUSES` is the documented exception to that
       rule: two 4xx statuses describe the vault's own state rather than our
       request, so they answer to the availability story instead.
    """
    code = _vault_error_code(response)
    if code is not None:
        return (
            CreekVaultContractError(request_rejected, code=code)
            if code in _CONTRACT_ERROR_CODES
            else CreekVaultUnavailableError(call_failed)
        )
    return _uncoded_write_failure(
        response,
        call_failed=call_failed,
        request_rejected=request_rejected,
        credential_rejected=credential_rejected,
    )


def _failure_degrade_reason(exc: Exception) -> HandshakeDegradeReason:
    """Attribute a handshake call failure to AUTH or to the availability story.

    Folded into the existing catch-all rather than added as its own ``except``:
    ``httpx.HTTPStatusError`` is an ``httpx.HTTPError`` and so already inside
    :data:`_HTTP_CALL_FAILED_ERRORS`, and a separate clause only added a branch
    that put the caller over the repo's complexity budget.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        return _status_degrade_reason(exc.response)
    return HandshakeDegradeReason.UNREACHABLE


def _status_degrade_reason(response: httpx.Response) -> HandshakeDegradeReason:
    """Attribute a non-2xx handshake status to AUTH or to the availability story.

    Code first, then status -- the same rule the read and write paths follow,
    and for the same reason. Creek publishes ``privacy_refused`` at 403, which
    is also a credential-rejected status, so deciding on status alone would
    report a refusal as a bad key here exactly as it used to on the write path.
    Only an *uncoded* 401 or 403 is a credential problem: a gateway that rejects
    our bearer never reaches the vault's error vocabulary.
    """
    if (
        _vault_error_code(response) is None
        and response.status_code in _CREDENTIAL_REJECTED_STATUSES
    ):
        return HandshakeDegradeReason.AUTH
    return HandshakeDegradeReason.UNREACHABLE


def _uncoded_write_failure(
    response: httpx.Response,
    *,
    call_failed: str,
    request_rejected: str,
    credential_rejected: str,
) -> CreekVaultError:
    """Classify a write error from its status class, having read no usable code.

    The sibling of :func:`_uncoded_read_failure`, and split out for the same
    reason it was: "which code is this" and "what does this status mean" fail
    for unrelated reasons, and keeping them in one function put it over the
    repo's complexity budget.
    """
    if response.status_code in _CREDENTIAL_REJECTED_STATUSES:
        return CreekVaultAuthError(credential_rejected)
    if _faults_our_request(response):
        return CreekVaultContractError(request_rejected)
    return CreekVaultUnavailableError(call_failed)


def _ingest_failure(response: httpx.Response) -> CreekVaultError:
    """Classify a failed journal ingest, naming the JOURNAL capability."""
    return _write_failure(
        response,
        call_failed=_INGEST_FAILED_MESSAGE,
        request_rejected=_INGEST_REJECTED_MESSAGE,
        credential_rejected=_CREDENTIAL_REJECTED_MESSAGE,
    )


def _coded_read_failure(capability: CreekCapability, code: VaultErrorCode) -> CreekVaultError:
    """Classify a read error from the code the vault itself named.

    Total by construction: :data:`_CONTRACT_ERROR_CODES` names the codes that
    fault adepthood's own call, and everything else falls through to the
    availability story -- which today is exactly ``unavailable`` and
    ``temporarily_unavailable``, the two codes with which a vault reports on
    itself. Fall-through rather than a second membership test for the reason
    :func:`_ingest_failure` already gives: a code this module has not classified
    is far more likely a vault naming its own condition than a defect in our
    request, and guessing "contract" sends someone hunting a bug that is not
    there. The code travels on the error either way, since it is one of our own
    members by the time it gets here.
    """
    if code in _CONTRACT_ERROR_CODES:
        return CreekVaultContractError(
            _capability_message(_REQUEST_REJECTED, capability), code=code
        )
    return CreekVaultUnavailableError(_capability_message(_CALL_FAILED, capability), code=code)


def _uncoded_read_failure(capability: CreekCapability, response: httpx.Response) -> CreekVaultError:
    """Classify a read error from its status class, having read no usable code.

    A refused credential is still a credential to rotate; a 4xx that is not one
    of :data:`_RETRYABLE_CLIENT_STATUSES` still faults the request adepthood
    sent; everything else -- a 5xx, a redirect we refuse to follow -- means the
    call did not land.
    """
    if response.status_code in _CREDENTIAL_REJECTED_STATUSES:
        return CreekVaultAuthError(_capability_message(_CREDENTIAL_REJECTED, capability))
    if _faults_our_request(response):
        return CreekVaultContractError(_capability_message(_REQUEST_REJECTED, capability))
    return CreekVaultUnavailableError(_capability_message(_CALL_FAILED, capability))


def _read_failure(capability: CreekCapability, response: httpx.Response) -> CreekVaultError:
    """Classify a non-2xx response on any ``/v1`` read into the failure it actually is.

    One classifier parameterized by capability rather than one per read: the rule
    below is a property of Creek's error envelope, which every read answers in,
    so a per-capability copy would only be a second place for it to drift. The
    capability enters solely through the static message each branch names.

    The error **code** is consulted first and the status class only after. Creek
    publishes ``privacy_refused`` at 403, and 403 is in
    :data:`_CREDENTIAL_REJECTED_STATUSES`, so a status-first rule would report a
    privacy refusal as a rejected credential -- sending an operator to rotate a
    key that was never refused, while the actual remedy (ask for less material)
    goes unmentioned. Reading the code first is what makes the two answers
    distinguishable at all.

    Code first, status second is now the rule on **every** ``/v1`` path rather
    than a read-path convention: the reads held that order first, and
    :func:`_write_failure` and :func:`_status_degrade_reason` were aligned to it,
    so the same misreport is no longer reachable from a write or from the
    handshake either. What survives of the status-first rule, on all three paths,
    is its one sound case -- an *uncoded* credential status really is a credential
    to rotate, because a gateway that rejects our bearer never reaches the vault's
    error vocabulary.
    """
    code = _vault_error_code(response)
    if code is not None:
        return _coded_read_failure(capability, code)
    return _uncoded_read_failure(capability, response)


def _decoded_object(response: httpx.Response) -> Mapping[str, object] | None:
    """Return a response body decoded as a JSON object, or ``None`` if it is neither.

    Answers ``None`` rather than raising, so the caller's refusal is raised
    *outside* this ``except``. An exception raised inside it would carry the JSON
    decoder's own message -- which quotes the vault's bytes -- as its
    ``__context__`` into every traceback that renders it, which is exactly the
    leak the static messages elsewhere exist to prevent.
    """
    try:
        decoded = response.json()
    except ValueError:
        return None
    return decoded if isinstance(decoded, Mapping) else None


def _admissible_wheel(response: httpx.Response) -> Mapping[str, object] | None:
    """Return a 2xx wheel body only when it is readable, complete, and within our ceiling.

    Three refusals, in the order that makes each meaningful: a body that is not a
    JSON object, a body missing a field Creek's own schema marks required, and a
    body whose echoed ceiling is wider than the one adepthood was willing to
    accept (:func:`_ceiling_admissible`).
    """
    payload = _decoded_object(response)
    if payload is None or not all(name in payload for name in _WHEEL_RESPONSE_REQUIRED_FIELDS):
        return None
    if not _ceiling_admissible(payload["tier_ceiling"], _WHEEL_TIER_CEILING):
        return None
    return payload


def _http_wheel_balance(response: httpx.Response) -> VaultWheelBalance | None:
    """Project an admissible 2xx wheel body onto a domain balance, or ``None``.

    Reuses :func:`_parse_wheel` -- the one canonical Frequency-to-stage
    projection -- rather than repeating it. A second parser for one wire shape is
    how two readings of the same wheel come to disagree.
    """
    payload = _admissible_wheel(response)
    return None if payload is None else _parse_wheel(payload)


class HttpCreekVaultClient:
    """A :class:`CreekVaultClient` that speaks plain HTTP/JSON to a configured vault.

    Handshakes with a single ``GET /v1/capabilities`` carrying a bearer
    ``Authorization`` header, caches the result so :meth:`is_available` and
    :meth:`supports` stay cheap synchronous reads, and records
    :attr:`last_degrade_reason` when the probe fails. It **degrades, never
    crashes**: :meth:`handshake` collapses every transport, parsing, and version
    failure into :meth:`HandshakeResult.unavailable`.

    Journal ingest is the one capability whose ``/v1`` request/response shape
    Creek ratified first, so :meth:`ingest` is wired up: it gates on the
    handshake, sends a ``PUT`` to the entry's own URL, and splits the answer into
    a durable write, a not-stored write, or one of three failure types (contract,
    auth, unavailable) an operator can act on differently. A failed ingest is
    **dropped, not queued** -- there is no retry and no backlog today, and it
    does not need one, because the local Postgres row is the system of record and
    the user's save already succeeded.

    The wheel read is ratified too, so :meth:`wheel` is wired up: a parameterless
    ``GET`` of the whole-corpus aggregate, gated on the handshake first so an
    unadvertised capability never puts a request on the wire, and split into a
    projected balance or one of four failure types (payload, contract, auth,
    unavailable) an operator can act on differently.

    So is the reflection, so :meth:`reflect` is wired up: a ``POST`` of the
    ratified two-field request to the reflections collection, gated on the
    handshake first for the same reason -- and here that gate matters most, since
    a whole journal entry rides on the request. It answers a structured
    :class:`~domain.creek_vault.VaultReflection`, or raises the same four failure
    types, or -- for Creek's 200 care handoff -- raises
    :class:`~domain.creek_vault.CreekVaultCareEscalationError`, which sits
    outside that hierarchy so no caller can degrade an escalation into cloud
    prose.

    :meth:`classify` alone still refuses with
    :class:`CreekCapabilityUnsupportedError`, *including* when the vault
    advertises it. Its shape has not shipped upstream, and this adapter will not
    guess a wire format: a refusal degrades the caller onto its local pipeline,
    whereas a wrong guess would send real journal content into a surface nobody
    has agreed on. Wiring it up is follow-on work, gated on that document.

    Every public capability is a thin wrapper that hands its real body to
    :class:`_CountingOutcome`, which records whatever the body raised while the
    body records its own return-path outcome. That split is what makes "one
    attempt, one outcome" hold by construction rather than by every branch
    remembering: the wrapper only ever fires on the exception path, and the body
    only ever on the return path, so neither double-counts and neither can be
    forgotten.

    A plain class on purpose -- no dataclass, no custom ``__repr__`` -- so the
    default object repr can never render the bearer credential this instance
    holds.
    """

    def __init__(
        self, url: str, api_key: str, *, http_client: httpx.AsyncClient | None = None
    ) -> None:
        """Validate the URL, then bind the credential, the client, and a safe cache.

        :func:`_require_secure_vault_url` runs first, before the key is stored
        anywhere, so a plaintext remote URL fails closed with the credential
        still only a parameter. ``http_client`` is an injection seam for tests;
        production leaves it ``None`` and borrows the shared pool per call. The
        handshake cache is seeded unavailable so a client that never handshook
        supports nothing.
        """
        _require_secure_vault_url(url)
        self._api_key = api_key
        # Trailing slashes are stripped so a configured URL with or without one
        # yields the same capability URL rather than a double-slashed path.
        self._url = url.rstrip("/")
        self._http_client = http_client
        self._last_handshake = HandshakeResult.unavailable()
        self._degrade_reason: HandshakeDegradeReason | None = None

    def _active_client(self) -> httpx.AsyncClient:
        """Return the injected client, or borrow the shared pool's (built on demand).

        Resolved per call rather than in ``__init__`` so merely constructing an
        adapter never forces the pool into existence, and so a pool closed and
        later reopened is picked up without rebuilding the adapter.

        One narrow window remains, by choice: a request that has already taken
        the pooled client when :func:`close_creek_vault_http_pool` runs at
        shutdown will see httpx's ``RuntimeError("Cannot send a request, as the
        client has been closed.")``. That is deliberately *not* in any degrade
        set -- catching bare ``RuntimeError`` would mask genuine bugs, and this
        one can only surface as a process is already stopping. The pool
        self-heals for every later call, because :meth:`_VaultHttpPool.aclose`
        nulls the slot and the next :meth:`get` builds a fresh client.
        """
        if self._http_client is not None:
            return self._http_client
        return _VAULT_HTTP_POOL.get()

    async def _authorized_request(
        self,
        method: str,
        url: str,
        json_body: Mapping[str, object] | None = None,
        *,
        ceiling: WireTierCeiling,
        contract_versioned: bool = True,
    ) -> httpx.Response:
        """Send one authorized vault request under the whole-request deadline.

        The single place any request leaves this adapter, so the two properties
        that must hold for *every* call hold once. The authorization header is
        built here, per call, so the credential lives only for the duration of
        the request and never on the shared pooled client.

        ``ceiling`` carries :data:`_CEILING_HEADER`, the tier ceiling Creek
        admits the call at. It has **no default**, unlike ``contract_versioned``,
        and the asymmetry is the point: every capability declares a different
        ceiling, derived from the material that call actually touches, so a
        default would be a value somebody forgot to think about rather than one
        that is right for the next capability. Typed :class:`WireTierCeiling`
        rather than :class:`~domain.creek_vault.VaultTierCeiling` so an intimate
        ceiling is not merely refused here but unspellable at this signature.

        ``contract_versioned`` carries :data:`_CONTRACT_VERSION_HEADER`, which
        Creek requires on every ``/v1`` capability call and refuses a missing one
        with ``409 incompatible_version`` before any vault read. It defaults to
        ``True`` so a capability added later carries it without anyone
        remembering; the sole caller that opts out is the capability document
        fetch, which the contract exempts on purpose. No fixture can catch this
        omission -- the vendored bundle publishes schemas and examples, and says
        nothing about request headers -- so the test that guards it drives a fake
        which refuses requests lacking the header.

        The deadline is necessary because httpx's ``read`` budget is per
        socket-read rather than a deadline: a trickling vault would otherwise
        hold this coroutine (and its pooled connection) open indefinitely.
        Expiry raises ``TimeoutError``, an ``OSError`` subclass, so it lands in
        each caller's existing transport branch. The module constant is read at
        call time rather than captured, so a redeployment (or a test) can move
        the deadline without rebuilding the adapter.
        """
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            _CEILING_HEADER: ceiling.value,
        }
        if contract_versioned:
            headers[_CONTRACT_VERSION_HEADER] = CONTRACT_MINOR
        async with asyncio.timeout(_VAULT_TOTAL_DEADLINE_SECONDS):
            return await self._active_client().request(
                method,
                url,
                headers=headers,
                json=json_body,
            )

    async def _fetch_capabilities(self) -> Mapping[str, object]:
        """Fetch and minimally narrow the vault's capability document.

        A non-2xx status raises ``httpx.HTTPStatusError`` and a non-JSON body
        raises ``json.JSONDecodeError``; both are degraded by the caller. A body
        that decodes to something other than a JSON object is a malformed
        payload, so it raises ``TypeError`` rather than being cast.
        """
        response = await self._authorized_request(
            "GET",
            f"{self._url}{_CAPABILITIES_PATH}",
            ceiling=_CONTENT_FREE_CEILING,
            contract_versioned=False,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, Mapping):
            raise TypeError("creek vault capability payload must be a JSON object")
        return payload

    async def _fetch_handshake(self) -> HandshakeResult | HandshakeDegradeReason:
        """Parse the capability document, or answer with the reason the probe degraded.

        A union of two disjoint types rather than a result-plus-reason pair,
        because a failed probe has no result and a successful one has no reason:
        a pair would have to spell both of those as ``None`` and leave a
        ``(None, None)`` nobody can produce sitting in the type.

        The ``except`` clauses are split purely to attribute the degradation --
        every one of them means the same thing to a caller.
        :data:`_HTTP_CALL_TIMED_OUT_ERRORS` comes **first** and that ordering is
        load-bearing rather than stylistic: ``TimeoutError`` is an ``OSError``
        and ``httpx.TimeoutException`` is an ``httpx.HTTPError``, so the wider
        clause below would otherwise swallow both and report a slow vault as an
        unreachable one. :data:`_HTTP_CALL_FAILED_ERRORS` then covers connection
        failures, every non-2xx status raised by ``raise_for_status``, a
        socket-level failure escaping httpx's hierarchy, and a URL httpx will not
        build a request for.
        """
        try:
            return _parse_handshake(await self._fetch_capabilities())
        except _IncompatibleContractVersionError:
            return HandshakeDegradeReason.INCOMPATIBLE_VERSION
        except _HTTP_CALL_TIMED_OUT_ERRORS:
            return HandshakeDegradeReason.TIMED_OUT
        except _HTTP_CALL_FAILED_ERRORS as exc:
            return _failure_degrade_reason(exc)
        except _PARSE_ERROR_TYPES:
            return HandshakeDegradeReason.MALFORMED_PAYLOAD

    async def _probe(self) -> tuple[HandshakeResult, HandshakeDegradeReason | None]:
        """Run one capability probe, collapsing every failure to one canonical result.

        Whatever :meth:`_fetch_handshake` attributed the failure to, the caller
        gets the same :meth:`HandshakeResult.unavailable` -- that collapse is the
        whole point of the degraded result, and the reason travels alongside it
        for the operator rather than for the caller. A payload that parsed but
        whose vault reported itself unavailable is not an error at all -- it is
        the vault answering honestly -- and is recorded as its own reason.
        """
        parsed = await self._fetch_handshake()
        if isinstance(parsed, HandshakeDegradeReason):
            return HandshakeResult.unavailable(), parsed
        if not parsed.available:
            return parsed, HandshakeDegradeReason.VAULT_REPORTED_UNAVAILABLE
        return parsed, None

    async def handshake(self) -> HandshakeResult:
        """Probe the vault, cache the result and its degrade reason, and count it.

        The handshake is an attempt like any other, so it records one outcome of
        its own -- and it is the attempt most worth counting, since the write
        path handshakes on every write and a deployment whose vault has drifted
        out of contract shows up here long before any capability call does.

        Guarded by :class:`_CountingOutcome` like every capability call, and for
        the same structural reason rather than for a failure anyone has seen:
        :meth:`_probe` turns every failure it knows about into a degrade reason,
        so nothing vault-shaped should reach the wrapper. "Should" is the word
        that makes the guard worth its line -- with it, "one attempt, one
        outcome" holds because of how the method is built rather than because of
        which exceptions the probe happens to catch today.
        """
        with _CountingOutcome(CreekCapability.HANDSHAKE):
            self._last_handshake, self._degrade_reason = await self._probe()
            # Looked up with a default rather than subscripted, for the reason
            # :mod:`services.creek_vault_telemetry` gives for its own severity
            # table: the mapping is total today, but a degrade reason added later
            # without updating it in lockstep would raise a ``KeyError`` from a
            # telemetry call and turn an observability gap into a failure on a
            # user's request path. An unclassified degrade reads as unavailable,
            # which is what a degraded handshake means whatever attributed it.
            outcome = _HANDSHAKE_OUTCOME_BY_DEGRADE_REASON.get(
                self._degrade_reason, VaultTelemetryOutcome.UNAVAILABLE
            )
            record_vault_outcome(outcome, CreekCapability.HANDSHAKE)
            return self._last_handshake

    @property
    def last_degrade_reason(self) -> HandshakeDegradeReason | None:
        """Why the last handshake degraded, or ``None`` if it succeeded (or never ran)."""
        return self._degrade_reason

    def is_available(self) -> bool:
        """Return whether the cached handshake found a usable vault."""
        return self._last_handshake.available

    def supports(self, capability: CreekCapability, /) -> bool:
        """Return whether the cached handshake advertised ``capability``."""
        return capability in self._last_handshake.capabilities

    async def _put_journal_entry(self, request: VaultIngestRequest) -> httpx.Response:
        """Upsert one entry at its own URL, normalizing any transport failure.

        The entry id contributes exactly one inert path segment
        (:func:`_entry_path_segment`) -- an id is an integer today, but a URL
        assembled by concatenation is exactly where a future identifier type
        would otherwise smuggle in a path traversal, and the entry body is what
        rides on this request.

        Every transport failure (connection refused, a socket error, a URL httpx
        will not build a request for) becomes
        :class:`CreekVaultUnavailableError` with ``from None``: the original
        exception's text can carry the URL or the entry body, and neither its
        message nor its traceback context may ride along. A call that ran out of
        time raises the :class:`VaultCallTimedOutError` *subclass* of that same
        type, carrying the same static message -- so every caller degrades
        exactly as it always did while telemetry can still tell a slow vault from
        an absent one. Its clause is ordered first because both timeout types are
        already inside :data:`_HTTP_CALL_FAILED_ERRORS`.
        """
        entry_url = f"{self._url}{_JOURNAL_ENTRIES_PATH}{_entry_path_segment(request.entry_id)}"
        # Resolved *before* the try, and before any request exists: an entry
        # whose ceiling has no wire spelling is refused while its body is still
        # only a field on a frozen dataclass, and that refusal is a contract
        # fault rather than one of the transport failures normalized below.
        ceiling = wire_ceiling_for(request.tier_ceiling)
        try:
            return await self._authorized_request(
                "PUT", entry_url, _journal_entry_body(request), ceiling=ceiling
            )
        except _HTTP_CALL_TIMED_OUT_ERRORS:
            raise VaultCallTimedOutError(_INGEST_FAILED_MESSAGE) from None
        except _HTTP_CALL_FAILED_ERRORS:
            raise CreekVaultUnavailableError(_INGEST_FAILED_MESSAGE) from None

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Upsert ``request`` into the vault, requiring the JOURNAL capability.

        A thin wrapper over :meth:`_ingest` so the attempt is counted exactly
        once: :class:`_CountingOutcome` records whatever the body raised, and
        the body records its own return-path outcome, so neither path can produce
        two records or none.
        """
        with _CountingOutcome(CreekCapability.JOURNAL):
            return await self._ingest(request)

    async def _ingest(self, request: VaultIngestRequest) -> VaultIngestResult:
        """Perform the journal upsert and report how it ended.

        Gated on the cached handshake first: a vault that did not advertise
        JOURNAL is refused *locally*, so no entry body is ever put on the wire
        toward a surface that never claimed to accept it.

        The answer splits three ways. A 2xx is projected by
        :func:`_parse_http_ingest_result`, which reports not-stored rather than
        inventing a ref it could not read. A 2xx whose body will not decode at
        all is an unavailable vault, not a failed write -- we cannot tell what
        happened, and a proxy error page served as 200 is the usual cause. A
        non-2xx is classified by :func:`_ingest_failure` into the fault it
        represents. Every raise uses ``from None`` so no vault-supplied text
        reaches a traceback.

        A 2xx the parser could not read as a durable write is counted as a schema
        failure rather than a success, because that is what it is: the vault
        answered 200 and did not say -- in the shape it publishes -- that
        anything was stored. Reporting it as a success would put the one number
        an operator trusts in front of a write that may not exist.
        """
        if not self.supports(CreekCapability.JOURNAL):
            raise CreekCapabilityUnsupportedError(_unsupported_message(CreekCapability.JOURNAL))
        response = await self._put_journal_entry(request)
        if not response.is_success:
            raise _ingest_failure(response) from None
        try:
            payload = response.json()
        except ValueError:
            raise CreekVaultUnavailableError(_INGEST_FAILED_MESSAGE) from None
        result = _parse_http_ingest_result(payload)
        record_vault_outcome(
            VaultTelemetryOutcome.SUCCESS
            if result.stored
            else VaultTelemetryOutcome.SCHEMA_FAILURE,
            CreekCapability.JOURNAL,
        )
        return result

    async def upload(self, _request: VaultUploadRequest, /) -> VaultUploadResult:
        """Refuse a document upload: the route exists, this adapter does not call it.

        The reason for this refusal changed with the contract pin, and the
        distinction is the whole point of keeping it. It used to rest on there
        being no upload surface at all -- the ratified ``/v1`` vocabulary was a
        closed enum of four names under ``additionalProperties: false``, so no
        conformant vault could advertise one, and the earlier implementation had
        ``PUT`` a body at an invented ``/v1/uploads/{id}`` URL Creek never served.

        Contract 0.8.0 published a real one: ``POST /v1/uploads``, taking
        ``filename``, ``content_base64``, ``external_id`` and a required ``tier``.
        :data:`_CAPABILITY_BY_WIRE_NAME` recognises the name, so a vault that
        advertises it is believed and :meth:`supports` answers ``True``.

        What is still missing is this method: no request is built, no response is
        parsed, and no idempotency behaviour is exercised. Answering a call by
        guessing at those is the failure this seam exists to prevent, so it
        refuses instead -- counted under its own capability like every other
        refusal, so the gap is visible in telemetry rather than silent. A vault
        below contract 0.8 is never advertised the capability at all and degrades
        one step earlier, at the caller's gate.
        """
        with _CountingOutcome(CreekCapability.UPLOAD):
            return await self._upload()

    async def _upload(self) -> VaultUploadResult:
        """Refuse the upload, naming the capability and nothing else."""
        _refuse_unratified(CreekCapability.UPLOAD)

    async def classify(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Refuse classification: its ``/v1`` request/response shape is unratified.

        Guarded by :class:`_CountingOutcome` like every other capability
        rather than counted inline, so the refusal is labelled from the error it
        actually raises. A refusal is worth counting precisely because it is
        invisible: the caller degrades onto its local pipeline and nothing
        surfaces, so this tally is where a deployment repeatedly asking for an
        unwired capability becomes legible.
        """
        with _CountingOutcome(CreekCapability.CLASSIFY):
            return await self._classify()

    async def _classify(self) -> VaultClassification:
        """Refuse classification, naming the capability and nothing else."""
        _refuse_unratified(CreekCapability.CLASSIFY)

    async def _post_reflection(self, body: str, ceiling: WireTierCeiling) -> httpx.Response:
        """Ask the collection for a reflection, normalizing any transport failure.

        One ``POST`` of the ratified two-field request and nothing else: no
        ``entry_ref``, since adepthood reflects on an ad-hoc body rather than on a
        fragment the vault already stores, and no tier-ceiling *field* under any
        spelling, since the published request is ``additionalProperties: false``
        and names none -- inventing one would be guessing at a contract. The
        ceiling is declared in :data:`_CEILING_HEADER` instead, which is where
        Creek reads it, and the echo is still verified on the way back
        (:func:`_admissible_ceiling`): a ceiling declared and a ceiling honoured
        are two different claims.

        Every transport failure (connection refused, a socket error, a URL httpx
        will not build a request for) becomes
        :class:`CreekVaultUnavailableError` with ``from None``, and a call that
        ran out of time becomes the :class:`VaultCallTimedOutError` subclass of
        it -- same static message, same degrade for every caller, one more thing
        telemetry can tell apart. Its clause is ordered first for the reason
        :meth:`_put_journal_entry` gives.
        """
        try:
            return await self._authorized_request(
                "POST",
                f"{self._url}{_REFLECTIONS_PATH}",
                _reflection_request_body(body),
                ceiling=ceiling,
            )
        except _HTTP_CALL_TIMED_OUT_ERRORS:
            raise VaultCallTimedOutError(_REFLECT_FAILED_MESSAGE) from None
        except _HTTP_CALL_FAILED_ERRORS:
            raise CreekVaultUnavailableError(_REFLECT_FAILED_MESSAGE) from None

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Ask the vault to reflect on ``body``, requiring the REFLECT capability.

        A thin wrapper over :meth:`_reflect`, counted exactly once the way
        :meth:`ingest` is -- and the escalation path is why that matters here:
        Creek's care handoff leaves this method as an exception, so without the
        wrapper the one outcome nobody may miss would be the one outcome nobody
        counted.
        """
        with _CountingOutcome(CreekCapability.REFLECT):
            return await self._reflect(body, tier_ceiling)

    async def _reflect(self, body: str, tier_ceiling: VaultTierCeiling) -> VaultReflection:
        """Ask the vault for a reflection and report how the exchange ended.

        Gated on the cached handshake first, exactly as :meth:`_ingest` and
        :meth:`_wheel` are, and here that gate carries the most: a vault that did
        not advertise REFLECT is refused *locally*, so a whole journal entry is
        never put on a wire toward a capability nobody claimed to serve.

        The answer splits four ways. A transport failure is an absent vault. A
        non-2xx is classified by :func:`_read_failure`, which reads the vault's
        own code before the status class. A 2xx that will not decode as a JSON
        object, or that :func:`_parse_reflection_result` cannot read as the
        published shape, is a :class:`CreekVaultPayloadError` -- a vault that
        answered, unreadably, which is a different fault from a vault that was
        not there. Only the remainder is a reflection, and that same parse turns
        Creek's 200 care handoff into
        :class:`~domain.creek_vault.CreekVaultCareEscalationError`, which is
        outside the degrade hierarchy on purpose.

        The ceiling is resolved before the body is handed anywhere, so a tier
        Creek's wire cannot express refuses here rather than travelling.
        """
        if not self.supports(CreekCapability.REFLECT):
            raise CreekCapabilityUnsupportedError(_unsupported_message(CreekCapability.REFLECT))
        response = await self._post_reflection(body, wire_ceiling_for(tier_ceiling))
        if not response.is_success:
            raise _read_failure(CreekCapability.REFLECT, response) from None
        payload = _decoded_object(response)
        if payload is None:
            raise CreekVaultPayloadError(_REFLECT_UNREADABLE_MESSAGE)
        reflection = _parse_reflection_result(payload, tier_ceiling)
        record_vault_outcome(VaultTelemetryOutcome.SUCCESS, CreekCapability.REFLECT)
        return reflection

    async def _get_wheel(self) -> httpx.Response:
        """Read the whole-corpus wheel, normalizing any transport failure.

        A bare ``GET`` of one collection URL: no query parameters and no body,
        because the ratified surface publishes neither for this capability, and
        sending an undocumented one would be guessing at a contract. The ceiling
        it counts over is declared in :data:`_CEILING_HEADER`, which is the
        surface that *is* published for one -- without it Creek would default to
        ``open`` and answer a wheel over open-tier material alone.

        Every transport failure (connection refused, a socket error, a URL httpx
        will not build a request for) becomes
        :class:`CreekVaultUnavailableError` with ``from None``, so the original
        exception's text neither rides along nor is chained; a call that ran out
        of time becomes the :class:`VaultCallTimedOutError` subclass of it, whose
        clause is ordered first for the reason :meth:`_put_journal_entry` gives.
        """
        try:
            return await self._authorized_request(
                "GET", f"{self._url}{_WHEEL_PATH}", ceiling=_WHEEL_WIRE_CEILING
            )
        except _HTTP_CALL_TIMED_OUT_ERRORS:
            raise VaultCallTimedOutError(_WHEEL_FAILED_MESSAGE) from None
        except _HTTP_CALL_FAILED_ERRORS:
            raise CreekVaultUnavailableError(_WHEEL_FAILED_MESSAGE) from None

    async def wheel(self) -> VaultWheelBalance:
        """Read a Wheel-of-Wholeness balance from the vault, requiring the WHEEL capability.

        A thin wrapper over :meth:`_wheel`, counted exactly once the way
        :meth:`ingest` is.
        """
        with _CountingOutcome(CreekCapability.WHEEL):
            return await self._wheel()

    async def _wheel(self) -> VaultWheelBalance:
        """Read the whole-corpus wheel and report how the exchange ended.

        Gated on the cached handshake first, exactly as :meth:`_ingest` is: a
        vault that did not advertise WHEEL is refused *locally*, so no request
        leaves this process toward a capability nobody claimed to serve.

        The answer splits four ways. A transport failure is an absent vault. A
        non-2xx is classified by :func:`_read_failure`, which reads the vault's
        own code before the status class. A 2xx that will not decode, is missing
        a published required field, echoes a tier ceiling wider than the one
        adepthood was willing to accept, or carries a Frequency
        :func:`_parse_wheel` cannot read is a :class:`CreekVaultPayloadError` --
        a vault that answered, unreadably, which is a different fault from a
        vault that was not there. Only the remainder is a balance.

        **An all-zero wheel is a legitimate answer, not a malformed one.**
        ``/v1`` accepts no declared ceiling, so the server applies its published
        ``open`` default, and ``open`` excludes every not-yet-classified
        fragment -- which means a young corpus reads back as ten zeros while
        being perfectly healthy. That case is decided in exactly one place,
        ``_carries_signal`` in :mod:`services.creek_vault_wheel`, which falls
        back to the locally-computed balance without recording a failure.
        Nothing here branches on ``total_classified``: it is validated as a
        published required field and then left alone, because two
        implementations of one rule is how they come to disagree.
        """
        if not self.supports(CreekCapability.WHEEL):
            raise CreekCapabilityUnsupportedError(_unsupported_message(CreekCapability.WHEEL))
        response = await self._get_wheel()
        if not response.is_success:
            raise _read_failure(CreekCapability.WHEEL, response) from None
        balance = _http_wheel_balance(response)
        if balance is None:
            raise CreekVaultPayloadError(_WHEEL_UNREADABLE_MESSAGE)
        record_vault_outcome(VaultTelemetryOutcome.SUCCESS, CreekCapability.WHEEL)
        return balance


class LocalFallbackCreekVaultClient:
    """The no-vault :class:`CreekVaultClient`: local pipeline stays authoritative.

    Used whenever no vault is configured. It reports unavailable and supports
    nothing, so callers uniformly fall back to local behavior. Ingest is a
    silent no-op (``stored=False``) because the operator's Postgres remains the
    sole system of record; the read/compute capabilities raise
    :class:`CreekCapabilityUnsupportedError` since there is nothing to serve
    them. Unused parameters are underscore-prefixed to match the protocol
    positionally without pretending to consume them.

    Every capability records an outcome under its own name before answering,
    defaulting to :attr:`~VaultTelemetryOutcome.FALLBACK_UNCONFIGURED`. That is
    not a fault -- it is a deployment exercising its choice not to have a vault,
    which is why it is one of the outcomes logged at DEBUG -- but it is still
    worth counting per capability, because a single unlabelled tally would say a
    deployment has no vault without saying what it kept asking one for.
    :meth:`is_available` and :meth:`supports` record nothing: they are cache
    reads rather than attempts, and counting them would inflate the tallies with
    questions no vault was ever asked.

    The outcome is a constructor argument because "no vault here" is true of more
    than one situation, and they are not the same news. A deployment with a vault
    bound to one user serves this same client to everybody else
    (:mod:`dependencies.creek_vault` passes
    :attr:`~VaultTelemetryOutcome.FALLBACK_NOT_OWNER` for them), and counting
    those under the unconfigured name would report a choice nobody made. The
    behaviour is identical either way -- there is nothing behind this client in
    any case -- so what varies is only the name the degrade is counted under.
    The default keeps every existing construction, and every counter read off
    one, meaning exactly what it did before.
    """

    def __init__(
        self, outcome: VaultTelemetryOutcome = VaultTelemetryOutcome.FALLBACK_UNCONFIGURED
    ) -> None:
        """Bind the outcome every capability of this client will be counted under."""
        self._outcome = outcome

    async def handshake(self) -> HandshakeResult:
        """Report no usable vault."""
        record_vault_outcome(self._outcome, CreekCapability.HANDSHAKE)
        return HandshakeResult.unavailable()

    def is_available(self) -> bool:
        """Report unavailable -- there is no vault behind this client."""
        return False

    def supports(self, _capability: CreekCapability, /) -> bool:
        """Report every capability as unsupported."""
        return False

    async def ingest(self, _request: VaultIngestRequest, /) -> VaultIngestResult:
        """No-op ingest: report not stored without raising (Postgres is authoritative)."""
        record_vault_outcome(self._outcome, CreekCapability.JOURNAL)
        return VaultIngestResult(stored=False, vault_ref=None)

    async def upload(self, _request: VaultUploadRequest, /) -> VaultUploadResult:
        """No-op upload: report not stored without raising, exactly as ingest does.

        Not a raise, because an absent vault is not an error the uploader caused
        -- the write service turns this into an honest "no vault to keep it in"
        outcome, and a document nobody could store is the same non-event a
        journal entry's unreplicated copy is.
        """
        record_vault_outcome(self._outcome, CreekCapability.UPLOAD)
        return VaultUploadResult(stored=False, vault_ref=None, action=None, tags=())

    async def classify(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Raise: classification has no local vault to serve it."""
        record_vault_outcome(self._outcome, CreekCapability.CLASSIFY)
        raise CreekCapabilityUnsupportedError(_unsupported_message(CreekCapability.CLASSIFY))

    async def reflect(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Raise: reflection has no local vault to serve it."""
        record_vault_outcome(self._outcome, CreekCapability.REFLECT)
        raise CreekCapabilityUnsupportedError(_unsupported_message(CreekCapability.REFLECT))

    async def wheel(self) -> VaultWheelBalance:
        """Raise: a vault wheel read has no local vault to serve it."""
        record_vault_outcome(self._outcome, CreekCapability.WHEEL)
        raise CreekCapabilityUnsupportedError(_unsupported_message(CreekCapability.WHEEL))


def build_creek_vault_client() -> CreekVaultClient:
    """Return the vault client appropriate for the current configuration.

    **Tenancy-unaware by construction, and reached only through
    :func:`dependencies.creek_vault.get_creek_vault_client`.** This factory
    answers one question -- what transport, if any, this deployment's
    configuration describes -- and knows nothing about who is asking. It cannot:
    adepthood presents a single deployment-wide identity to a vault, and the
    contract carries no tenant field, so a client built here is a handle on one
    shared corpus rather than on any user's. Which user may hold that handle is
    the dependency's decision, and wiring this function into a request path
    directly would hand the same corpus to everybody -- so if a route needs a
    vault client, it depends on the dependency, never on this.

    When ``CREEK_VAULT_URL`` is unset or empty, no vault is configured and a
    :class:`LocalFallbackCreekVaultClient` is returned so the app runs fully on
    its local pipeline. That check comes **first**, before the protocol selector
    is so much as read, and the ordering is deliberate: a deployment that never
    had a vault must keep working even if a stale ``CREEK_VAULT_PROTOCOL`` is
    still sitting in its environment, since turning "no vault" into a startup
    failure would break the one configuration this seam exists to support.

    With a URL configured, :data:`_PROTOCOL_ENV_VAR` still gates the choice even
    though ``http`` is now the only transport, and defaults to it. Neither stale
    selector is reinterpreted as HTTP -- that would send an operator's vault
    traffic over a transport they did not choose, which is the guess this seam
    exists to refuse -- but the two are answered differently, because adepthood
    knows different things about them.

    :data:`_PROTOCOL_RETIRED_MCP` is the one value adepthood *did* honour and then
    retired, so its intent is not in doubt: the operator asked for the optional
    replication over a transport that no longer exists. The safe answer to "I can
    no longer do the optional thing you asked for" is to skip the optional thing,
    so it degrades to :class:`LocalFallbackCreekVaultClient` and warns. This
    factory runs inside a per-request dependency, where raising means the handler
    body never runs at all: a stale selector would turn every journal save into a
    500 and lose the writer's entry, which is precisely the loss the whole seam
    promises can never happen for a vault's sake.

    Any other unrecognized value degrades the same way, for the same reason.
    Adepthood knows less about it -- a value nobody ever supported is as likely a
    typo for ``http`` as a transport nobody implemented -- but knowing less is an
    argument for *more* caution, not for a harsher failure: whatever the operator
    meant, they did not mean "lose every journal entry until someone reads a
    traceback". So the honest answer is the same as for the retired value, skip
    the optional half and say so loudly, and the difference between the two shows
    up where it belongs, in what the WARNING says. What neither does is
    reinterpret an uninterpretable selector as ``http``: that would send a
    deployment's vault traffic over a transport nobody chose, which is the one
    guess this seam exists to refuse. Both records name the offending value and
    the supported one and nothing else -- they reach logs, so neither the URL nor
    the bearer credential may travel with them.

    Only with a selector this deployment will actually honour is the URL itself
    judged, by :func:`~services.creek_vault_url.classify_vault_url`, and a
    defective one degrades the same way for the same reason. The ordering
    carries two decisions. A deployment
    that will not use the URL at all has no business complaining about it, so a
    selector that already refused the transport short-circuits first and one
    misconfiguration stays one record. And the URL is judged *before*
    ``CREEK_VAULT_API_KEY`` is so much as read, because there is no reason to
    fetch a credential for an endpoint that is about to be refused.

    The refusal itself lives in :func:`_require_secure_vault_url`, which
    :class:`HttpCreekVaultClient` still calls, and the constructor below is
    therefore unreachable with a URL that would trip it. That is deliberately an
    *ordering* guarantee rather than a ``try``: catching the constructor's
    ``ValueError`` here would turn a genuine bug in it into a silent degrade, and
    a vault that quietly stopped replicating is the failure this seam is least
    able to notice.
    """
    # ``CREEK_VAULT_URL`` being unset or blank is the signal that no vault is
    # configured; the bearer credential is read only to build the adapter's
    # auth header and is never logged or placed in any exception message.
    # ``strip`` is asked only whether anything was configured at all, and the
    # answer is thrown away -- ``url`` travels on exactly as the operator wrote
    # it, since normalizing it here is the one thing this seam refuses to do.
    # Blank has to mean the same thing here as it does to
    # :func:`unusable_creek_vault_url`, or a stray space in an otherwise empty
    # variable would go unmentioned at boot and then warn on every request --
    # silence in the one place an operator is looking, noise in the one place
    # it costs.
    url = os.getenv(CREEK_VAULT_URL_ENV_VAR, "")
    if not url.strip():
        return LocalFallbackCreekVaultClient()
    protocol = os.getenv(_PROTOCOL_ENV_VAR, _PROTOCOL_HTTP).strip().lower()
    if protocol == _PROTOCOL_RETIRED_MCP:
        _LOGGER.warning(_RETIRED_PROTOCOL_EVENT, extra=_protocol_fields(_PROTOCOL_RETIRED_MCP))
        return LocalFallbackCreekVaultClient()
    if protocol != _PROTOCOL_HTTP:
        _LOGGER.warning(_UNKNOWN_PROTOCOL_EVENT, extra=_protocol_fields(protocol))
        return LocalFallbackCreekVaultClient()
    finding = classify_vault_url(url)
    if finding is not None:
        _LOGGER.warning(_UNUSABLE_URL_EVENT, extra=_url_defect_fields(finding))
        return LocalFallbackCreekVaultClient()
    # Reached only for a URL every check above approved, which is why the
    # constructor's own refusal is unreachable from here rather than caught: a
    # ``try`` around it would swallow a genuine bug in it as if it were a
    # misconfiguration.
    return HttpCreekVaultClient(url, os.getenv("CREEK_VAULT_API_KEY", ""))
