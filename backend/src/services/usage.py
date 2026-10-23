"""BotMason usage accounting — monthly cap, wallet precedence, reset logic.

Every user gets ``BOTMASON_MONTHLY_CAP`` free BotMason messages each calendar
month.  Once the free allocation is spent, requests fall through to the
``offering_balance`` (purchased / gifted credits, no expiry).  When both
buckets are empty the router returns ``402 insufficient_offerings``.

This module intentionally contains no database access — it is a pure library
of helpers over configuration and datetime arithmetic so the router can wire
atomic SQL statements around them without duplicating policy.
"""

from __future__ import annotations

import os

from domain.dates import compute_next_reset

__all__ = [
    "DAILY_CLASSIFICATION_CEILING_ENV",
    "DAILY_GENERATION_CEILING_ENV",
    "DEFAULT_DAILY_CLASSIFICATION_CEILING",
    "DEFAULT_DAILY_GENERATION_CEILING",
    "DEFAULT_MONTHLY_CAP",
    "compute_next_reset",
    "get_daily_classification_ceiling",
    "get_daily_generation_ceiling",
    "get_monthly_cap",
]

# Default monthly cap when ``BOTMASON_MONTHLY_CAP`` is not set: the "monthly
# included balance" of the ratified launch economy (#623), lowered from 50 "until
# real usage establishes the cost curve" -- see
# ``prompts/claude-comms/2026-09-05-resonance-economy-decision.md``.  The wallet
# is shared, so this one allowance covers transcription, resonance passes and
# essay letters alike (BotMason chat, once a fourth spender, is retired).
DEFAULT_MONTHLY_CAP = 20

# Default daily ceiling on charged generations per user when
# ``BOTMASON_DAILY_GENERATION_CEILING`` is not set.  The owner ratified a
# "configurable launch ceiling of **100 charged generations/day/user**"
# (decision record §1); record §4 places it as a "database-backed daily
# ceiling, env-configurable".  ``0`` is a deliberate emergency brake that
# refuses every charged generation; BYOK generations are never charged, so
# they are never counted against it.
DEFAULT_DAILY_GENERATION_CEILING = 100
DAILY_GENERATION_CEILING_ENV = "BOTMASON_DAILY_GENERATION_CEILING"

# Default daily ceiling on server-paid corpus classifications per user when
# ``BOTMASON_DAILY_CLASSIFICATION_CEILING`` is not set.
#
# Classification is free to the account and is not a charged generation, so the
# wallet does not bound it and none of the three limits above counted it. This
# is the bound that does. It is a *cost* ceiling, not a product allowance:
# nobody is sold these, and the number exists to stop a scripted client
# spending the deployment's money, not to shape what a person may write.
#
# 200 is chosen against real use rather than against the bill. A heavy
# journaller writes tens of entries a day, and an edit that changes wording or
# privacy re-classifies, so a day of genuinely intense journalling lands an
# order of magnitude below this. The exposure it closes is the other end: at
# the ambient 60/minute rate limit an unbounded account sustains ~86,400 calls
# a day, and classification input is truncated at
# ``services.frequency_classification.MAX_FRAGMENT_CHARS`` so each is cheap but
# not free. 200 holds the worst case near a dollar a day per account instead.
#
# ``0`` is a deliberate emergency brake that refuses every server-paid
# classification, exactly as it does for charged generations. A BYOK or
# vault-bound writer's classification is not the app's bill, so neither is ever
# counted against this.
DEFAULT_DAILY_CLASSIFICATION_CEILING = 200
DAILY_CLASSIFICATION_CEILING_ENV = "BOTMASON_DAILY_CLASSIFICATION_CEILING"

# Minimum allowed configured cap.  A cap of ``0`` is a legitimate
# "pay-as-you-go only" configuration (no free tier, every request draws
# from ``offering_balance``).  Negative values are rejected as clearly
# misconfigured and fall back to the default.
_MIN_CAP = 0


def _non_negative_env_int(name: str, default: int) -> int:
    """Read ``name`` as a non-negative int, falling back to ``default``.

    Unset, empty, malformed and negative values all fall back; ``0`` is a
    legitimate setting and is returned as-is.
    """
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        parsed = int(raw)
    except ValueError:
        return default
    if parsed < _MIN_CAP:
        return default
    return parsed


def get_monthly_cap() -> int:
    """Return the configured monthly BotMason message cap.

    Reads ``BOTMASON_MONTHLY_CAP`` from the environment on every call so
    tests can ``monkeypatch.setenv`` without restarting the app.  Falls back
    to :data:`DEFAULT_MONTHLY_CAP` when the variable is unset, empty,
    malformed, or negative.
    """
    return _non_negative_env_int("BOTMASON_MONTHLY_CAP", DEFAULT_MONTHLY_CAP)


def get_daily_classification_ceiling() -> int:
    """Return the configured daily ceiling on server-paid corpus classifications.

    Read from the environment on every call, like the sibling ceilings, so an
    operator can tighten the brake without a restart. Unset, empty, malformed
    and negative values fall back to
    :data:`DEFAULT_DAILY_CLASSIFICATION_CEILING`; ``0`` is a legitimate
    setting and refuses every server-paid classification.
    """
    return _non_negative_env_int(
        DAILY_CLASSIFICATION_CEILING_ENV, DEFAULT_DAILY_CLASSIFICATION_CEILING
    )


def get_daily_generation_ceiling() -> int:
    """Return the configured daily ceiling on charged generations per user.

    Parsed exactly like :func:`get_monthly_cap` from
    :data:`DAILY_GENERATION_CEILING_ENV`: unset, empty, malformed or negative
    values give :data:`DEFAULT_DAILY_GENERATION_CEILING`, and ``0`` refuses
    every charged generation.
    """
    return _non_negative_env_int(DAILY_GENERATION_CEILING_ENV, DEFAULT_DAILY_GENERATION_CEILING)
