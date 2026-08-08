"""Counting what a Creek Vault call did, in a vocabulary no vault can choose.

Every path through the vault seam ends in silence by design. A failed write is
dropped rather than queued, because the local Postgres row is the system of
record and the user's save already succeeded. A failed read falls back to
something computed locally, so it looks exactly like a healthy one from the
outside. A deployment that never configured a vault simply never calls. All of
that is the right product behaviour -- nothing adepthood ships depends on a vault
being present -- and it is precisely why this module exists: with nothing
surfacing to a caller, an in-process tally plus one log line is the *only* place
an operator can see the seam at all.

What the tally is for is keeping the stories apart that a single "vault failure"
number collapses into one. A vault that is absent is infrastructure to restore; a
vault that is merely slow is capacity to add; a vault that refused the call is a
defect in adepthood's own request; a vault that answered unreadably is a bug to
report upstream; and a deployment that never had a vault is not a fault at all.
Those five call for five different actions, and a single counter would have made
an operator guess which one they were looking at.

**The fields are a closed vocabulary rather than redacted free text.** Redaction
is a promise that something was removed; a closed vocabulary is a proof that it
was never there to remove. Every value this module writes -- into a counter key
or onto a log record -- is a :class:`VaultTelemetryOutcome` member, a
:class:`~domain.creek_vault.CreekCapability` wire name, or one of adepthood's own
:class:`~domain.creek_vault.VaultErrorCode` members. The journal body, the note
text and the fragment id a vault answered with, the bearer credential, and every
other string a vault chose are therefore **absent by construction**: there is no
parameter they could arrive through and no branch that could interpolate them, so
there is nothing here to remember to scrub. The one static
:data:`VAULT_OUTCOME_EVENT` message carries the same property for the log line
itself -- everything variable travels in the structured fields, each of which is
one of ours.

Content-free fields are not the whole of privacy, though, and one outcome needed
a second decision: for a care escalation, the sensitive thing is not what the
record says but *that there is a record*. See :data:`_SEVERITY_BY_OUTCOME` for
why that one is tiered to DEBUG and stripped of trace correlation while its tally
is kept intact.

Shaped after the observability block in :mod:`services.creek_vault_read` rather
than shared with it, for the reason that module already gives about the write
path: a degrade *reason* answers "why did this one read fall back", while an
outcome answers "how did this attempt end", and success is an outcome with no
reason at all. Merging the two vocabularies would produce one that is wrong for
both.
"""

from __future__ import annotations

import enum
import logging
import threading
from collections import Counter
from collections.abc import Mapping

from domain.creek_vault import (
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultCareEscalationError,
    CreekVaultContractError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    VaultErrorCode,
)
from observability import SUPPRESS_TRACE_CORRELATION

_LOGGER = logging.getLogger(__name__)

# The one log event this module emits, and the only message string it has. Static
# so an operator greps for exactly one line to find every vault outcome, and
# static for the same privacy reason the read path's event is: a message that
# interpolated anything would be a message that could interpolate the wrong
# thing.
VAULT_OUTCOME_EVENT = "creek vault outcome"


class VaultTelemetryOutcome(enum.StrEnum):
    """How one attempt at one vault capability ended.

    Twelve members rather than "worked" and "did not", because the failures have
    different owners and different remedies: ``UNAVAILABLE`` is infrastructure to
    restore, ``TIMEOUT`` is a vault that is up and too slow, ``AUTH_FAILED`` is a
    credential to rotate, ``INCOMPATIBLE_VERSION`` is two pins to align,
    ``SCHEMA_FAILURE`` is a vault bug to report upstream, ``CONTRACT_FAILURE`` is
    a defect in adepthood's own request, ``CAPABILITY_UNSUPPORTED`` is a surface
    nobody offered, and ``REFUSED`` is adepthood asking for more material than it
    declared it would. ``FALLBACK_UNCONFIGURED`` is none of those -- it is a
    deployment exercising its choice not to have a vault -- and
    ``ESCALATED`` is not a failure either: it is Creek's care guard answering a
    person in acute distress, which is a successful outcome that happens to
    arrive as an exception.

    ``FALLBACK_NOT_OWNER`` is the twelfth, and it sits next to
    ``FALLBACK_UNCONFIGURED`` because it is the other half of the same sentence
    and emphatically not the same fact. This deployment *has* a vault; it is
    being asked for by a user it does not belong to. Adepthood reaches a vault
    with one deployment-wide identity, so one vault is one corpus, and a corpus
    stays one person's only if exactly one person is served from it -- everyone
    else is answered locally, and lands here. Folding the two together would
    report "the operator chose no vault" for a deployment that chose one, hiding
    both the operational question (is the binding pointed at the right person?)
    and the ordinary steady state (most users of a bound vault are not its
    owner), which have nothing to do with each other.

    Values are the wire strings a dashboard counts by, so they are this module's
    contract and must not be reworded casually; the member order is pinned by a
    test for the same reason.
    """

    SUCCESS = "vault_success"
    FALLBACK_UNCONFIGURED = "vault_fallback_unconfigured"
    FALLBACK_NOT_OWNER = "vault_fallback_not_owner"
    UNAVAILABLE = "vault_unavailable"
    TIMEOUT = "vault_timeout"
    AUTH_FAILED = "vault_auth_failed"
    INCOMPATIBLE_VERSION = "vault_incompatible_version"
    SCHEMA_FAILURE = "vault_schema_failure"
    CONTRACT_FAILURE = "vault_contract_failure"
    CAPABILITY_UNSUPPORTED = "vault_capability_unsupported"
    REFUSED = "vault_refused"
    ESCALATED = "vault_escalated"


class VaultCallTimedOutError(CreekVaultUnavailableError):
    """A vault accepted the call and then did not finish it inside the deadline.

    A subclass rather than a sibling, and that is the whole design. Every caller
    written before this distinction existed catches
    :class:`~domain.creek_vault.CreekVaultUnavailableError` and degrades; a new
    peer type would have silently escaped all of them and turned an optional
    replication into an exception on a user's request path. Subclassing means the
    caller-visible behaviour is unchanged by construction, and the *only* thing
    that changed is that telemetry can now tell "the vault was not there" apart
    from "the vault was there and too slow" -- two conditions whose remedies
    (restore it, or give it more capacity) have nothing to do with each other.

    It carries no state of its own: the message is the same static,
    capability-named string the unavailable path already raises with.
    """


# Which outcome a coded contract failure is, when the vault named a reason we
# recognize. Only two codes earn their own outcome. ``privacy_refused`` says
# adepthood asked for material above the ceiling it declared, whose remedy is to
# ask for less, and ``incompatible_version`` says the two contract pins have
# drifted, whose remedy is to align them. Every other contract code -- and an
# uncoded refusal -- is the undifferentiated "the vault said no to what we sent",
# which is one story with one remedy: fix the request.
_OUTCOME_BY_CONTRACT_CODE: Mapping[VaultErrorCode, VaultTelemetryOutcome] = {
    VaultErrorCode.PRIVACY_REFUSED: VaultTelemetryOutcome.REFUSED,
    VaultErrorCode.INCOMPATIBLE_VERSION: VaultTelemetryOutcome.INCOMPATIBLE_VERSION,
}

# Every error type that maps onto an outcome by its class alone, most specific
# first. The ordering is load-bearing: :class:`VaultCallTimedOutError` is an
# unavailability subclass, so a table that tested the wide type first would
# collapse a slow vault back into an absent one -- which is the exact
# distinction the subclass exists to preserve. A tuple rather than a chain of
# ``isinstance`` branches so adding a type costs a line rather than a branch.
_OUTCOME_BY_ERROR_TYPE: tuple[tuple[type[BaseException], VaultTelemetryOutcome], ...] = (
    (VaultCallTimedOutError, VaultTelemetryOutcome.TIMEOUT),
    (CreekVaultCareEscalationError, VaultTelemetryOutcome.ESCALATED),
    (CreekVaultAuthError, VaultTelemetryOutcome.AUTH_FAILED),
    (CreekVaultPayloadError, VaultTelemetryOutcome.SCHEMA_FAILURE),
    (CreekCapabilityUnsupportedError, VaultTelemetryOutcome.CAPABILITY_UNSUPPORTED),
)

# The severities that are deliberately *not* WARNING. A deployment that never had
# a vault is a choice rather than a fault, so it stays at DEBUG and never fills an
# operator's warning stream with a fact they already chose; a healthy answer is
# news worth one INFO line. Everything else is a fault somebody may need to act
# on.
#
# ``FALLBACK_NOT_OWNER`` joins the unconfigured path at DEBUG on that same
# reasoning: a user who is not the bound owner being served locally is the
# design working, once per request of theirs forever, so warning on it would bury
# the real faults under the loudest steady state the seam has. The one genuine
# misconfiguration in this neighbourhood -- a vault configured with no readable
# owner, and therefore inert for everybody -- is not this event: it is warned
# about once, where it is discovered, by :mod:`dependencies.creek_vault`.
#
# ``ESCALATED`` is the one entry here that is tiered for privacy rather than for
# noise, and it is a deliberate product decision rather than an oversight. Its
# fields are as content-free as every other outcome's -- but *that this line was
# written at all* says a particular person's writing tripped Creek's care guard,
# which is a special-category inference about their mental health. It would not
# have stayed abstract: every log record in the same request carries a trace id,
# and the journal router's own records carry a ``user_id``, so an escalation at
# INFO would be trivially joinable to a named user in ordinary production logs.
# For a journaling product whose whole promise is a private place to write the
# worst of it down, quietly accumulating a log-joinable record of who reached
# that state is the wrong trade -- so the event drops to DEBUG (absent from
# ordinary logs entirely) and additionally suppresses correlation below (see
# :data:`_CORRELATION_SUPPRESSED_OUTCOMES`) for the case where DEBUG is on. The
# operational signal an on-call actually needs -- how often the care guard fires
# -- is unharmed: it lives in the counters, which are per-capability aggregates
# with nobody's identity anywhere in them.
_SEVERITY_BY_OUTCOME: Mapping[VaultTelemetryOutcome, int] = {
    VaultTelemetryOutcome.FALLBACK_UNCONFIGURED: logging.DEBUG,
    VaultTelemetryOutcome.FALLBACK_NOT_OWNER: logging.DEBUG,
    VaultTelemetryOutcome.SUCCESS: logging.INFO,
    VaultTelemetryOutcome.ESCALATED: logging.DEBUG,
}

# Outcomes whose record must not carry the request's trace id, because the event
# itself is the sensitive fact. A set rather than a flag on the one member, so the
# property is stated once and a future outcome of the same character joins it by
# a line rather than by rediscovering the reasoning. Kept as narrow as it reads:
# an uncorrelatable record is a record an operator cannot follow, which is a real
# cost worth paying only where correlation would build a dossier.
_CORRELATION_SUPPRESSED_OUTCOMES = frozenset({VaultTelemetryOutcome.ESCALATED})

# Where an outcome the table above does not name is logged. A default rather than
# an exhaustive table on purpose: an outcome nobody has tiered yet is better read
# once too loudly than missed, and a ``KeyError`` raised from a telemetry call
# would turn an observability gap into a failure on a user's request path.
_DEFAULT_OUTCOME_SEVERITY = logging.WARNING

# One tally's key: which outcome, for which capability. The capability is part of
# the key rather than a second counter so a failing wheel can never hide behind a
# healthy ingest, and both halves are closed enums so a vault can never name one.
_CounterKey = tuple[VaultTelemetryOutcome, CreekCapability]


def outcome_for_error(error: BaseException) -> VaultTelemetryOutcome:
    """Attribute one failure to the outcome an operator would act on.

    :class:`~domain.creek_vault.CreekVaultContractError` is tested first because
    it is the one type whose outcome depends on more than its class -- the vault
    named a reason, and two of those reasons have remedies of their own. It is a
    sibling of every other type in :data:`_OUTCOME_BY_ERROR_TYPE`, never a parent
    or a child of one, so testing it early changes which member wins for nothing.

    ``UNAVAILABLE`` is the fall-through rather than a match, on the same
    reasoning :func:`~services.creek_vault_read._degrade_reason_for` gives: an
    error type this module has not heard of is far more likely an availability
    fault than a defect in adepthood's own request, and guessing "contract" sends
    someone hunting a bug that is not there. That is also why the parameter is
    typed ``BaseException`` and not a vault error -- a caller must be able to
    label whatever it caught without first proving it belongs to this seam.
    """
    if isinstance(error, CreekVaultContractError):
        return _coded_contract_outcome(error.code)
    for error_type, outcome in _OUTCOME_BY_ERROR_TYPE:
        if isinstance(error, error_type):
            return outcome
    return VaultTelemetryOutcome.UNAVAILABLE


def _coded_contract_outcome(code: VaultErrorCode | None) -> VaultTelemetryOutcome:
    """Narrow a contract failure by the reason the vault itself named, if any.

    A code adepthood does not classify -- and a refusal that named none at all --
    is the plain contract failure, for the same reason the fall-through above is
    availability: a reason nobody has separated out yet has no separate remedy to
    point at.
    """
    if code is None:
        return VaultTelemetryOutcome.CONTRACT_FAILURE
    return _OUTCOME_BY_CONTRACT_CODE.get(code, VaultTelemetryOutcome.CONTRACT_FAILURE)


def code_for_error(error: BaseException) -> VaultErrorCode | None:
    """Return the vault's own reason, but only when it is one of *our* members.

    The two error types that carry a code have already dropped anything the vault
    sent that adepthood does not recognize, so what survives here is always a
    member of a closed enum -- which is what makes it safe to put on a log record
    at all. Every other error, and every non-vault exception, has no code to
    report.
    """
    if isinstance(error, CreekVaultContractError | CreekVaultUnavailableError):
        return error.code
    return None


class _VaultOutcomeCounters:
    """The process-local tallies, behind the lock that keeps them arithmetic.

    An object rather than a bare module-level mapping, for the reason
    :class:`~services.creek_vault_client._VaultHttpPool` is one: clearing and
    replacing state needs no ``global`` rebinding, and a test can hold the whole
    thing at arm's length.

    The lock is not decoration. These counters are shared by every coroutine in
    the worker *and* by the threadpool FastAPI runs sync endpoints on, and
    ``counter[key] += 1`` is a read, an add, and a write with two thread-switch
    points in the middle -- so an unguarded increment silently loses counts under
    exactly the load an operator would be reading these numbers to understand.
    The critical sections are three lines of dictionary work, so the contention
    this buys is not measurable next to the vault call it is counting.
    """

    def __init__(self) -> None:
        """Start with an empty tally and the lock that guards every touch of it."""
        self._counts: Counter[_CounterKey] = Counter()
        self._lock = threading.Lock()

    def increment(self, key: _CounterKey) -> None:
        """Add one to ``key``'s tally, atomically with respect to every other caller."""
        with self._lock:
            self._counts[key] += 1

    def snapshot(self) -> Mapping[_CounterKey, int]:
        """Return the tallies as they stand right now, copied.

        A copy rather than the live mapping, so a reader that walks it cannot
        observe it changing underneath, and so a caller can never mutate the
        counters by writing to what it was handed.
        """
        with self._lock:
            return dict(self._counts)

    def clear(self) -> None:
        """Drop every tally."""
        with self._lock:
            self._counts.clear()


# The tallies this process keeps. Deliberately in-memory and unexported to any
# metrics backend: adepthood has no metrics pipeline today, and inventing one
# here would be a second decision riding along with this one. The log line is
# what an operator reads; the counters are what a future exporter reads.
_VAULT_OUTCOME_COUNTERS = _VaultOutcomeCounters()


def _outcome_fields(
    outcome: VaultTelemetryOutcome, capability: CreekCapability, code: VaultErrorCode | None
) -> dict[str, object]:
    """Build the content-free structured fields describing one outcome.

    ``code`` is omitted entirely rather than written as ``None`` when the vault
    named no reason: an absent field says "nobody claimed anything", while a null
    one invites a reader to treat the absence as a value. The correlation-
    suppression marker is omitted on the same principle for every outcome that
    does not need it, so the flag reads as a deliberate mark on the few records
    that carry it rather than as a field with two settings.
    """
    fields: dict[str, object] = {"outcome": outcome.value, "capability": capability.value}
    if code is not None:
        fields["code"] = code.value
    if outcome in _CORRELATION_SUPPRESSED_OUTCOMES:
        fields[SUPPRESS_TRACE_CORRELATION] = True
    return fields


def record_vault_outcome(
    outcome: VaultTelemetryOutcome,
    capability: CreekCapability,
    *,
    code: VaultErrorCode | None = None,
) -> None:
    """Count one vault attempt and emit the single static record describing it.

    Exactly one increment and exactly one log record per call, which is what lets
    a caller keep the "one attempt, one outcome" property by construction rather
    than by inspection. The exception that produced ``outcome`` is deliberately
    neither formatted into the message nor passed as ``exc_info``: its text can
    quote the entry body or a vault's own prose, and this record is the one place
    either would otherwise escape.

    The increment happens whatever the severity, so an outcome quieted for
    privacy still reaches the tally: the aggregate carries no identity, and it is
    what an operator reads a rate off anyway.
    """
    _VAULT_OUTCOME_COUNTERS.increment((outcome, capability))
    _LOGGER.log(
        _SEVERITY_BY_OUTCOME.get(outcome, _DEFAULT_OUTCOME_SEVERITY),
        VAULT_OUTCOME_EVENT,
        extra=_outcome_fields(outcome, capability, code),
    )


def vault_outcome_counts() -> Mapping[_CounterKey, int]:
    """Return a snapshot of every outcome counted so far in this process."""
    return _VAULT_OUTCOME_COUNTERS.snapshot()


def reset_vault_telemetry_for_tests() -> None:
    """Empty the process-wide counters.

    The counters outlive any one test by design, so a suite that asserts on them
    needs a way back to zero; without one, a test would read whatever its
    neighbours happened to record first.
    """
    _VAULT_OUTCOME_COUNTERS.clear()
