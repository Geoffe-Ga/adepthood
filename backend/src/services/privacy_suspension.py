"""Operator suspension switches for a privacy incident (#3075).

Two environment variables an operator flips, without a code change or a
deploy of new code, to put the deployment into a narrower, safer state:

``PRIVACY_SUSPEND_EXTERNAL_AI``
    Refuses every cloud language-model call -- server-paid **and**
    bring-your-own-key -- before any provider client is built. It is the only
    control that stops a BYOK key: ``BOTMASON_PROVIDER=stub`` does not (a BYOK
    key selects its own provider), and ``BOTMASON_DAILY_GENERATION_CEILING=0``
    does not (it counts charged generations only).

``PRIVACY_SUSPEND_VAULT_SEND``
    Refuses every content-bearing request to a Creek vault, while the
    content-free withdrawals and deletions keep running -- an incident is
    exactly when a stuck withdrawal must still be able to land.

Both switches are **default-off** and **strictly narrowing**: setting one only
ever refuses more. Parsing fails closed. Only unset, empty or ``false`` (case-
and whitespace-insensitive) means off; ``0``, ``off``, ``no`` and a typo all
mean *suspended*, so a mistyped value can never leave a switch the operator
meant to flip open.

Each switch is read at call time and never cached, so flipping it in the
platform's environment and restarting is the whole procedure, and a test can
flip it per case. Journal read and write, export and account deletion keep
working under every switch; the draft incident runbook
(``docs/ops/privacy-incident-response.md``) says what each refuses and what
continues.

This module imports nothing from ``services`` so the two leaves that consult it
(:mod:`services.botmason` and :mod:`services.creek_vault_client`) can do so
without an import cycle.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Final

from errors import service_unavailable

logger = logging.getLogger(__name__)

EXTERNAL_AI_SUSPEND_ENV_VAR: Final = "PRIVACY_SUSPEND_EXTERNAL_AI"
VAULT_SEND_SUSPEND_ENV_VAR: Final = "PRIVACY_SUSPEND_VAULT_SEND"

#: The stable refusal code an AI route answers with (HTTP 503) while suspended.
AI_SUSPENDED_DETAIL: Final = "ai_suspended"

#: The only spellings, after ``strip().lower()``, that leave a switch off.
_OFF_VALUES: Final = frozenset({"", "false"})
#: The spellings that are a deliberate decision either way. Anything else is
#: treated as suspended *and* warned about, by name only.
_RECOGNISED_VALUES: Final = frozenset({"", "true", "false"})

_STATE_EVENT: Final = "privacy_suspension_state"
_MALFORMED_EVENT: Final = "privacy_suspension_value_malformed"
_NONE_ACTIVE: Final = "none"


@dataclass(frozen=True, slots=True)
class PrivacySwitch:
    """One operator switch: its variable, its status field, and what it refuses."""

    env_var: str
    code: str
    controls: str


#: The closed registry of switches. The boot log, the admin probe and the
#: runbook drift test all iterate this, so a third switch cannot be wired into
#: one of them and silently missed by another.
PRIVACY_SUSPENSION_SWITCHES: Final[tuple[PrivacySwitch, ...]] = (
    PrivacySwitch(
        env_var=EXTERNAL_AI_SUSPEND_ENV_VAR,
        code="external_ai_suspended",
        controls="every cloud language-model call, server-paid and BYOK",
    ),
    PrivacySwitch(
        env_var=VAULT_SEND_SUSPEND_ENV_VAR,
        code="vault_send_suspended",
        controls="every content-bearing Creek vault request",
    ),
)


def _raw(var: str) -> str:
    """The switch's value, normalized for comparison; unset reads as empty."""
    return os.getenv(var, "").strip().lower()


def _switch_on(var: str) -> bool:
    """Whether ``var`` suspends: anything but unset, empty or ``false`` does."""
    return _raw(var) not in _OFF_VALUES


def external_ai_suspended() -> bool:
    """Whether every cloud language-model call is currently refused."""
    return _switch_on(EXTERNAL_AI_SUSPEND_ENV_VAR)


def vault_send_suspended() -> bool:
    """Whether every content-bearing Creek vault request is currently refused."""
    return _switch_on(VAULT_SEND_SUSPEND_ENV_VAR)


def require_external_ai_available() -> None:
    """Refuse an AI-reaching request with 503 ``ai_suspended`` while suspended.

    Each AI route calls this after its free exits (a cached letter, an intimate
    entry's care surface) and before the generation guardrails, the wallet, or
    any slot, so a suspended request is charged nothing and spends nothing.
    """
    if external_ai_suspended():
        raise service_unavailable(AI_SUSPENDED_DETAIL)


def suspension_state() -> dict[str, bool]:
    """Each switch's status field and whether it is on: content-free by construction."""
    return {switch.code: _switch_on(switch.env_var) for switch in PRIVACY_SUSPENSION_SWITCHES}


def log_suspension_state() -> None:
    """Log, once, which switches are on -- by variable name, never by value.

    One INFO line naming the active switches (``none`` when there are none), and
    one WARNING per switch whose value is neither a recognised spelling nor
    unset, saying it is being treated as suspended. The value itself is never
    logged: an operator who pasted the wrong thing into the variable should not
    find it in the log stream.
    """
    active = ",".join(_active_switches()) or _NONE_ACTIVE
    logger.info("%s active=%s", _STATE_EVENT, active)
    for env_var in _malformed_switches():
        logger.warning("%s env=%s treated_as=suspended", _MALFORMED_EVENT, env_var)


def _active_switches() -> list[str]:
    """The variable names of every switch that is on, in registry order."""
    return [s.env_var for s in PRIVACY_SUSPENSION_SWITCHES if _switch_on(s.env_var)]


def _malformed_switches() -> list[str]:
    """The variable names of every switch set to an unrecognised spelling."""
    return [
        s.env_var for s in PRIVACY_SUSPENSION_SWITCHES if _raw(s.env_var) not in _RECOGNISED_VALUES
    ]
