"""Environment resolution for the Postgres integration lane.

Both helpers are pure functions of the mapping they are handed: nothing here
reads ``os.environ``. The fixtures pass ``os.environ`` in explicitly, which
keeps the truth table below testable and stops a developer's shell from
deciding what CI does.

The asymmetry that matters is in :func:`resolve_integration_database_url`. An
unset URL means "no Postgres available, skip the lane" when a human runs the
suite, and "the service container never came up" in CI. Only the second is a
defect, so CI declares the lane required and the resolver raises instead of
handing the caller a skip.
"""

from __future__ import annotations

from collections.abc import Mapping

from database import normalize_database_url

#: Connection string for the live Postgres the lane runs against.
URL_ENV = "TEST_POSTGRES_URL"

#: Set truthy where a missing URL is a misconfiguration rather than an opt-out.
REQUIRE_ENV = "INTEGRATION_LANE_REQUIRE_POSTGRES"

#: pytest-xdist's per-worker identifier, absent outside a distributed run.
WORKER_ENV = "PYTEST_XDIST_WORKER"

_DATABASE_NAME_PREFIX = "adepthood_it_"

# The worker name a non-distributed run owns, so the database is named the same
# way whether or not xdist is in play.
_SERIAL_WORKER = "master"

# Spellings that read as "off". Anything else -- "1", "true", "TRUE", "yes" --
# arms the require flag, so a typo fails loudly rather than silently disarming.
_FALSEY = frozenset({"", "0", "false", "no", "off"})


class IntegrationLaneMisconfiguredError(RuntimeError):
    """The lane was declared required but cannot reach a live Postgres."""


def _is_truthy(value: str) -> bool:
    """Return whether an environment value reads as "on"."""
    return value.strip().casefold() not in _FALSEY


def resolve_integration_database_url(env: Mapping[str, str]) -> str | None:
    """Return the lane's database URL, ``None`` to skip, or raise if required.

    The URL is normalized through the application's own
    :func:`database.normalize_database_url` rather than re-parsed here, so the
    lane and the running app can never disagree about which driver a bare
    ``postgresql://`` URL means.

    Args:
        env: The environment to read. Never ``os.environ`` implicitly.

    Returns:
        The normalized URL, or ``None`` when no Postgres is configured and the
        lane is optional.

    Raises:
        IntegrationLaneMisconfiguredError: No usable URL while the require flag
            is set.
    """
    raw = env.get(URL_ENV, "").strip()
    if raw:
        return normalize_database_url(raw)
    if _is_truthy(env.get(REQUIRE_ENV, "")):
        msg = (
            f"{URL_ENV} is unset or blank while {REQUIRE_ENV} is truthy. "
            f"The integration lane was declared required, so it fails here "
            f"rather than skipping past a Postgres that never came up."
        )
        raise IntegrationLaneMisconfiguredError(msg)
    return None


def integration_database_name(env: Mapping[str, str]) -> str:
    """Return the database name this pytest worker owns exclusively.

    Each worker migrates and drops its own database, so two workers can never
    race on one schema or observe each other's rows.

    Args:
        env: The environment to read. Never ``os.environ`` implicitly.
    """
    worker = env.get(WORKER_ENV, "").strip() or _SERIAL_WORKER
    return f"{_DATABASE_NAME_PREFIX}{worker}"
