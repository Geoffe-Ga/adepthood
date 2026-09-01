"""Drift guards between the vault-egress note in ``DEPLOYMENT.md`` and the code.

Vault egress deliberately ignores the ambient proxy environment variables. That
is a security control rather than an oversight: a user's vault is dialled at the
address its URL was checked at, and a proxy handed the hostname would resolve it
itself -- the second lookup the pin exists to remove. It is also the kind of
control that looks like a bug from the outside. An operator who exported a proxy
for everything else sees vault calls, and only vault calls, failing; nothing in
the failure says "this was on purpose". The note in ``DEPLOYMENT.md`` is the
only place that connects the symptom to the decision, which makes every string
it restates from the code a string that can rot into a wrong instruction with no
signal that it has.

Three restatements carry the note and are pinned here from the code side.

*The attribution vocabulary.* :class:`~services.creek_vault_client.HandshakeDegradeReason`
says of itself that its values are the wire strings telemetry counts by, so they
are part of that module's contract. Two of them are what a proxy-shaped
misconfiguration actually looks like: a call that never completed, and a call
that answered and then ran out of time. The note names both, because naming only
one sends an operator with the other symptom looking for a different cause.

*The record an operator can actually grep.* The degrade reason is an in-process
property; the line that reaches a log aggregator is the single static
:data:`~services.creek_vault_telemetry.VAULT_OUTCOME_EVENT` message carrying a
:class:`~services.creek_vault_telemetry.VaultTelemetryOutcome` value. Both layers
are stated in the note -- the vocabulary that explains the attribution and the
string that finds the evidence -- so both are pinned. Pinning the reasons alone
would leave the note able to describe a symptom nobody can search for.

*The troubleshooting row.* The table under ``Troubleshooting`` is where someone
looks who does not yet know this note exists, so the outcomes have to appear
there too, on one row, alongside the word that makes it findable at all. Exactly
one row is required: a second row naming the same outcomes is a second answer to
the same question, and a table with two answers is one an operator has to
adjudicate mid-incident.

The last guard is about what the note must not quietly become. ``CREEK_VAULT_URL``
is a deprecated path (see ``backend/.env.example``), and it is exactly the lever
a future edit would reach for to explain how to work around this behaviour. A
note may mention it, but never as a live escape hatch: if it appears, the word
``deprecated`` has to appear with it in the same section. That is a
literal-string tripwire and not a semantic one -- a rewrite that steers an
operator to the same place while never spelling the variable walks past it --
which is the honest limit of what a substring guard can promise.

Both fixtures end their slice at the next markdown heading, so a fenced block
added inside either section whose content begins a line with ``##`` would cut
the slice short and fail a later assertion about text that is really there.
Nothing in either section is fenced today; if one ever is, that is the first
thing to check.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from services.creek_vault_client import HandshakeDegradeReason
from services.creek_vault_telemetry import VAULT_OUTCOME_EVENT, VaultTelemetryOutcome

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEPLOYMENT_DOC = _REPO_ROOT / "DEPLOYMENT.md"

# The note's own heading, and the pattern that ends it: the next heading at
# either level, since the note is a subsection of ``Monitoring and Operations``.
_EGRESS_HEADING = "### Vault egress ignores proxy environment variables"
_NEXT_HEADING = re.compile(r"^###? ", re.MULTILINE)

# The troubleshooting table's own heading, and the pattern that ends that section.
_TROUBLESHOOTING_HEADING = "## Troubleshooting"
_NEXT_SECTION = re.compile(r"^## ", re.MULTILINE)

# A markdown table row, header and separator included.
_TABLE_ROW = re.compile(r"^\|.*$", re.MULTILINE)

# The deprecated configuration path a workaround would be tempted to name.
_DEPRECATED_SETTING = "CREEK_VAULT_URL"
_DEPRECATION_WORD = re.compile(r"deprecated", re.IGNORECASE)

# The word that makes the troubleshooting row findable by the symptom's cause.
_PROXY_WORD = re.compile(r"proxy", re.IGNORECASE)

_EXPECTED_PROXY_ROWS = 1


@pytest.fixture
def egress_section() -> str:
    """The vault-egress note in ``DEPLOYMENT.md``, heading to next heading."""
    text = _DEPLOYMENT_DOC.read_text(encoding="utf-8")
    start = text.find(_EGRESS_HEADING)
    assert start != -1, f"{_DEPLOYMENT_DOC} has no '{_EGRESS_HEADING}' section"
    rest = text[start + len(_EGRESS_HEADING) :]
    end = _NEXT_HEADING.search(rest)
    return rest[: end.start()] if end else rest


@pytest.fixture
def troubleshooting() -> str:
    """The ``Troubleshooting`` section of ``DEPLOYMENT.md``, heading to heading."""
    text = _DEPLOYMENT_DOC.read_text(encoding="utf-8")
    start = text.find(_TROUBLESHOOTING_HEADING)
    assert start != -1, f"{_DEPLOYMENT_DOC} has no '{_TROUBLESHOOTING_HEADING}' section"
    rest = text[start + len(_TROUBLESHOOTING_HEADING) :]
    end = _NEXT_SECTION.search(rest)
    return rest[: end.start()] if end else rest


def test_egress_note_names_both_degrade_reasons_a_blocked_call_produces(
    egress_section: str,
) -> None:
    """The note names the unreachable *and* the timed-out attribution values."""
    expected = (HandshakeDegradeReason.UNREACHABLE, HandshakeDegradeReason.TIMED_OUT)
    missing = [reason.value for reason in expected if reason.value not in egress_section]
    assert not missing, (
        f"the vault-egress note omits degrade reason(s): {missing}; "
        "an operator seeing only the unnamed symptom is sent after a different cause"
    )


def test_egress_note_names_the_telemetry_record_an_operator_greps(
    egress_section: str,
) -> None:
    """The note quotes the log event and both outcome values it carries."""
    expected = (
        VaultTelemetryOutcome.UNAVAILABLE.value,
        VaultTelemetryOutcome.TIMEOUT.value,
        VAULT_OUTCOME_EVENT,
    )
    missing = [token for token in expected if token not in egress_section]
    assert not missing, (
        f"the vault-egress note omits {missing}; "
        "it would describe a symptom with no string to search the logs for"
    )


def _names_both_outcomes(row: str) -> bool:
    """Whether one table row mentions both of the outcomes this note is about."""
    return (
        VaultTelemetryOutcome.UNAVAILABLE.value in row
        and VaultTelemetryOutcome.TIMEOUT.value in row
    )


def test_troubleshooting_table_carries_exactly_one_proxy_row(troubleshooting: str) -> None:
    """One table row, and only one, ties both outcomes to a proxy as the cause."""
    rows = [row for row in _TABLE_ROW.findall(troubleshooting) if _names_both_outcomes(row)]
    assert len(rows) == _EXPECTED_PROXY_ROWS, (
        f"expected exactly {_EXPECTED_PROXY_ROWS} troubleshooting row naming both "
        f"{VaultTelemetryOutcome.UNAVAILABLE.value} and "
        f"{VaultTelemetryOutcome.TIMEOUT.value}, found {len(rows)}"
    )
    assert _PROXY_WORD.search(rows[0]), (
        f"the troubleshooting row {rows[0]!r} never says 'proxy', "
        "so nobody reaches it from the cause they are actually chasing"
    )


def test_egress_note_never_presents_the_deprecated_setting_as_live(
    egress_section: str,
) -> None:
    """If the note mentions the deprecated URL setting, it says it is deprecated."""
    if _DEPRECATED_SETTING in egress_section:
        assert _DEPRECATION_WORD.search(egress_section), (
            f"the vault-egress note names {_DEPRECATED_SETTING} without saying it is "
            "deprecated, which reads as the supported way around this control"
        )
