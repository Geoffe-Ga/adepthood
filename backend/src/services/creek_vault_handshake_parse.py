"""Parse Creek's ``GET /v1/capabilities`` answer into a :class:`HandshakeResult`.

Split out of :mod:`services.creek_vault_client` (whose maintainability index
sits at the gate's floor) so the client keeps the call and its degrade policy
while this module owns the fail-closed reading of the payload: the contract
version check of ADR 0004 Decision 4, the vault's own ``available`` flag, and the
translation of Creek's published capability names into
:class:`~domain.creek_vault.CreekCapability`. Every malformed field raises
``KeyError`` or ``TypeError``; the client catches those and degrades the
handshake to unavailable.
"""

from collections.abc import Mapping, Sequence
from types import MappingProxyType
from typing import cast

from domain.creek_vault import CONTRACT_VERSION, CreekCapability, HandshakeResult
from services.creek_vault_agent_discovery import parse_agent_mcp
from services.creek_vault_relay import parse_request_key_providers

# How a "MAJOR.MINOR.PATCH" version string decomposes, and how many of its
# leading components must match for two contract versions to interoperate. ADR
# 0004 Decision 4: while the contract is pre-1.0 a minor bump *is* the breaking
# change, so client and server must match on exact major.minor; from 1.0 onward
# minors are forward-compatible and only the major must match.
_VERSION_MAJOR_INDEX = 0
_PRE_1_0_MAJOR = "0"
_PRE_1_0_MATCHED_COMPONENTS = 2
_POST_1_0_MATCHED_COMPONENTS = 1


class IncompatibleContractVersionError(Exception):
    """A vault advertised a contract version this client will not interoperate with.

    Control-flow only: it exists so a version mismatch stays
    *distinguishable* from an unreachable or malformed vault while still
    degrading to the same caller-visible unavailable result (ADR 0004
    Decision 4). It carries no payload, so it can never echo a vault response.
    Deliberately not a :class:`~domain.creek_vault.CreekVaultError`: it never
    escapes :mod:`services.creek_vault_client`, which raises it here and catches
    it in the handshake.
    """


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
# Seven of the nine members have a published name. SAVE and CLASSIFY are
# adepthood-side concepts Creek does not advertise, so :meth:`supports` is
# ``False`` for them and every capability-gated path degrades. That is the
# contract reporting a capability that does not exist, not a hole in this table
# -- do not invent wire names for them.
#
# ``upload`` was the fifth, published at contract 0.8.0, and it is the reason
# this list must be read as a fact about a *negotiated* handshake rather than
# about Creek in general. Every minor through 0.7 answered the same four names
# to every caller; 0.8.0 keys the advertisement on the caller's declared minor,
# so a vault's answer here now depends on what adepthood pinned. Recognising the
# name is all this table does: whether the client can *call* the route is a
# separate question, answered at that capability's own method.
#
# ``drive-connector`` (0.9.0) and ``pipeline`` (0.10.0) are the sixth and
# seventh, and they are the clearest case of that separation: adepthood has no
# route, no method and no caller for either. They are listed anyway because
# :func:`_coerce_capability` drops what it cannot name, so leaving them out
# would make a vault that advertises them indistinguishable from one that does
# not -- and "the vault offers it, we have not wired it" is a fact worth being
# able to read off a handshake.
_CAPABILITY_BY_WIRE_NAME: Mapping[str, CreekCapability] = MappingProxyType(
    {
        "capabilities": CreekCapability.HANDSHAKE,
        "reading-recommendations": CreekCapability.READING_RECOMMENDATIONS,
        "journal-upsert": CreekCapability.JOURNAL,
        "journal-withdraw": CreekCapability.JOURNAL_WITHDRAW,
        "reflections": CreekCapability.REFLECT,
        "wheel": CreekCapability.WHEEL,
        "upload": CreekCapability.UPLOAD,
        "drive-connector": CreekCapability.DRIVE_CONNECTOR,
        "pipeline": CreekCapability.PIPELINE,
        "voice-drafts": CreekCapability.VOICE_DRAFTS,
        "letters": CreekCapability.LETTERS,
        "agent-activity": CreekCapability.AGENT_ACTIVITY,
        "export": CreekCapability.EXPORT,
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


def contract_version_compatible(advertised: str, pinned: str = CONTRACT_VERSION) -> bool:
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

    Per entry the comparison is unchanged -- :func:`contract_version_compatible`
    still decides what compatible means, including the post-1.0 relaxation to a
    major match -- so this widens *what* is compared against, not *how*.
    """
    return any(contract_version_compatible(minor, pinned) for minor in supported)


def parse_handshake(payload: Mapping[str, object]) -> HandshakeResult:
    """Parse a well-formed handshake payload into a populated result.

    Reads and version-checks the contract before anything else: an incompatible
    version raises :class:`IncompatibleContractVersionError` (we will not call a
    surface we do not understand), which every caller degrades to unavailable.
    Then honors the vault's own availability, fail-closed: a reachable server is
    not necessarily an available vault, so anything other than a literal ``True``
    -- a missing ``vault`` object, a missing or wrong-typed ``available`` inside
    it -- degrades to unavailable. Creek publishes that flag *nested* under
    ``vault``; reading a top-level ``available`` (which its documents do not
    carry) is what made every handshake against a conformant vault report
    unavailable. Any missing key or wrong-typed field raises out of the helpers
    and is caught by :meth:`services.creek_vault_client.HttpCreekVaultClient._probe`.
    """
    contract_version = _require_str(payload, "contract_version")
    supported = _require_str_sequence(payload, "supported_contract_minors")
    if not _contract_minor_supported(supported):
        raise IncompatibleContractVersionError
    vault = payload.get("vault")
    if not isinstance(vault, Mapping) or vault.get("available") is not True:
        return HandshakeResult.unavailable()
    return HandshakeResult(
        available=True,
        contract_version=contract_version,
        ontology_version=_require_str(payload, "ontology_version"),
        capabilities=_parse_capabilities(payload["capabilities"]),
        attestation=_parse_attestation(payload.get("attestation")),
        request_key_providers=parse_request_key_providers(payload.get("request_key_providers")),
        keyless_inference=_parse_keyless_inference(payload.get("keyless_inference")),
        agent_mcp=parse_agent_mcp(payload.get("agent_mcp"), minor=payload.get("contract_minor")),
        supported_contract_minors=frozenset(supported),
    )


def _parse_keyless_inference(raw: object) -> bool | None:
    """Read Creek 0.20's ``keyless_inference`` leniently: a literal boolean, else ``None``.

    ``None`` means "the vault did not say", which changes nothing about a pass, so
    a vault that omits the field, or sends something other than a boolean, is
    treated exactly as an older vault is.
    """
    return raw if isinstance(raw, bool) else None
