"""Tests for the startup email-backend configuration check.

Contract: the email backend defaults to console, which is right on a laptop and
silently catastrophic on a server. With ``EMAIL_BACKEND`` unset -- or set to a
name the factory does not recognise -- every password-reset mail is written to
the application log while the endpoint still answers 202, so "delivered" and
"the user is locked out of their account" look identical from outside. In
production that state refuses to boot, naming the variable and handing over the
remedy. Outside production the console default is the ordinary local case and
stays silent.

Unlike the journal-key check, this refusal may quote the value it was given: a
backend name is a mode selector, not a credential, and echoing ``sendgrid`` back
turns a typo from a bisect into a one-line fix.

The validator and the sender factory must agree on what counts as ``smtp``,
including case and stray whitespace. Any value the factory would route to the
console adapter has to be a value this check refuses -- a validator that
normalizes differently would pass a boot that then logs the mail anyway. That
agreement survives only while one function does the reading, so a sweep of the
backend sources enforces it rather than trusting the current arrangement.

``EMAIL_BACKEND=smtp`` with a missing ``SMTP_*`` variable is the other half of
the same promise: the sender is built eagerly at boot, so the first user to
request a reset is not the one who discovers the gap. A variable that is present
but unusable -- a port that is not a number, or a number no socket can be opened
on -- belongs to that same promise, and has to arrive as the same kind of
sentence rather than as whatever the conversion happened to throw.

The accepted set is wider than ``smtp`` alone, and the widening is the delicate
part. The deployment platform blocks outbound SMTP, so a relay configured there
hangs for its connect timeout and the endpoint answers 202 regardless -- the
original outage with the variable correctly set. An HTTPS backend is therefore
also a production-viable choice, which means this check must accept it while
refusing everything it still does not implement. Both directions are asserted,
because a check widened by deleting the comparison would pass the first half.

The web base URL belongs to the same boot. A delivered email whose only link
uses a custom scheme is unopenable in the browser that is the only shipping
platform, so the origin those links point at is production configuration on the
same footing as the backend switch -- and it must come from configuration rather
than from a request header, or an attacker who chooses the Host chooses where
the reset link lands.
"""

from __future__ import annotations

import ast
import logging
from collections.abc import AsyncGenerator, Generator, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import pytest
from cryptography.fernet import Fernet
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from conftest import test_engine
from main import app, lifespan, validate_app_base_url_config, validate_email_config
from services import app_links, email, journal_encryption
from tests.helpers.resend_env import RESEND_ENV_VALUES
from tests.helpers.smtp_env import SMTP_ENV_VALUES

ENV_VAR = "ENV"
MAIN_LOGGER = "main"

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_EXAMPLE = REPO_ROOT / "backend" / ".env.example"
DEPLOYMENT_DOC = REPO_ROOT / "DEPLOYMENT.md"
BACKEND_SRC = REPO_ROOT / "backend" / "src"
EMAIL_MODULE = BACKEND_SRC / "services" / "email.py"

# Both files the refusal hands the operator. Half a documented remedy reads as a
# whole one until someone follows it.
REMEDY_DOCUMENTS = [ENV_EXAMPLE, DEPLOYMENT_DOC]

# The single sanctioned reader of the backend selector, and the two shapes an
# environment read takes in this codebase.
READER_FUNCTION = email.configured_backend.__name__
ENVIRON_READ_CALLS = frozenset({"os.getenv", "os.environ.get", "getenv"})
ENVIRON_MAPPINGS = frozenset({"os.environ"})

# How the selector's name can reach such a read: as a literal, or through the
# module constant under either import style. Unparsing the argument makes all
# three comparable as text. An import that renames the constant on the way in
# would read as a fourth spelling and slip the sweep -- the one hole here, left
# open because closing it means resolving aliases across modules, and naming it
# is cheaper than a reader inferring a guarantee this does not give.
BACKEND_VAR_SPELLINGS = frozenset(
    {
        repr(email.EMAIL_BACKEND_ENV_VAR),
        "EMAIL_BACKEND_ENV_VAR",
        "email.EMAIL_BACKEND_ENV_VAR",
    }
)

# Values that mean "nobody chose a backend": unset, empty, whitespace. Each
# lands on the console adapter, so each must fail closed in production.
ABSENT_BACKEND_VALUES = [None, "", "   "]

# Spellings of the default that the factory strips and lowercases into
# ``console``. The validator has to refuse the same set, not just the exact
# lowercase token.
CONSOLE_BACKEND_VALUES = ["console", "Console", " CONSOLE "]

# The mirror image: spellings the factory accepts as smtp, which must therefore
# boot rather than be refused on a casing difference.
SMTP_BACKEND_VALUES = ["smtp", "SMTP", " Smtp "]

# The mirror image again, for the HTTPS backend: the platform blocks outbound
# SMTP, so this is the selector a production deploy actually ships with, and the
# same normalization has to reach it.
HTTPS_BACKEND_VALUES = ["resend", "RESEND", " Resend "]

# A plausible operator error -- a real provider that is not a backend this app
# implements. It must be named back to them rather than absorbed as "not smtp".
UNRECOGNIZED_BACKEND = "sendgrid"

# The origin the browser-followable reset links are built from. It is
# deployment configuration for the same reason the backend switch is: nothing in
# a running app can derive where its own web front end lives, and the one thing
# that claims to -- the request's Host header -- is attacker-supplied.
WEB_BASE_URL_ENV_VAR = "APP_BASE_URL"
WEB_BASE_URL = "https://app.aptitude.guru"

# Values a platform variable editor accepts and no emailed link can be followed
# to. The bare hostname is the realistic one rather than the contrived one:
# ``PROD_DOMAIN``, the CORS setting a few rows away in that same editor, is
# exactly this shape, so it is the likeliest paste in the building -- and it
# renders a string no mail client linkifies, which is this bug reproduced
# through the check written to prevent it. ``http://`` is refused separately
# because the link is a bearer token with a thirty-minute life.
UNFOLLOWABLE_WEB_BASE_URLS = [
    "",
    "   ",
    "app.aptitude.guru",
    "http://app.aptitude.guru",
    "javascript:alert(1)",
]

# The variables the HTTPS delivery path adds, which the same two documents owe
# an operator following the same refusals. Literals rather than module
# attributes so this list is readable before the code exists.
HTTPS_DELIVERY_ENV_VARS = ["RESEND_API_KEY", WEB_BASE_URL_ENV_VAR]

# Environments where logging the reset link is the point, not a leak.
NON_PRODUCTION_ENVS = [None, "development", "staging"]

# A relay port int() cannot read, and one it reads into a number nothing will
# answer on. Both are configured relays that cannot deliver, so both have to
# stop the deploy the way a missing variable does.
UNPARSEABLE_PORT = "eighty"
UNUSABLE_PORT = "70000"
MALFORMED_PORTS = [UNPARSEABLE_PORT, UNUSABLE_PORT]

# The variables an operator needs the template to name before they can act on
# the refusal. The backend switch comes from the module so a rename cannot leave
# the documentation silently pointing at a variable that no longer exists.
DOCUMENTED_ENV_VARS = [email.EMAIL_BACKEND_ENV_VAR, *SMTP_ENV_VALUES]


def _set_env(monkeypatch: pytest.MonkeyPatch, name: str, value: str | None) -> None:
    """Set ``name``, treating ``None`` as unset."""
    if value is None:
        monkeypatch.delenv(name, raising=False)
    else:
        monkeypatch.setenv(name, value)


def _set_smtp_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure a complete relay so the smtp path reaches its own subject."""
    for name, value in SMTP_ENV_VALUES.items():
        monkeypatch.setenv(name, value)


def _set_https_delivery_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure a complete HTTPS provider and a web origin for the links."""
    for name, value in RESEND_ENV_VALUES.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv(WEB_BASE_URL_ENV_VAR, WEB_BASE_URL)


@pytest.fixture
def production_journal_key(monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    """Satisfy the earlier production precondition so a boot failure is attributable.

    Journal encryption is validated before email, so a lifespan test about the
    email rule has to configure a key or it proves the wrong refusal. The
    process-wide registry is cleared on both sides: ``monkeypatch`` restores the
    variable but not the cache built from it.
    """
    monkeypatch.setenv(journal_encryption.KEYS_ENV_VAR, Fernet.generate_key().decode())
    journal_encryption.reset_cache()
    yield
    journal_encryption.reset_cache()


@asynccontextmanager
async def _isolated_factory_patch() -> AsyncGenerator[None, None]:
    """Point main's session factory at the conftest SQLite engine for lifespan runs."""
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    with patch("main.async_session_factory", new=factory):
        yield


@pytest.mark.parametrize("backend", ABSENT_BACKEND_VALUES)
def test_production_without_a_chosen_backend_refuses_to_boot(
    backend: str | None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unchosen backend is the exact shape of the outage this check exists for.

    The realistic failure is not misuse: it is a deploy where nobody knew this
    variable existed, so password recovery answers 202 forever and the reset
    links accumulate in the log. Omission must not be a reachable way to ship
    that.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    _set_env(monkeypatch, email.EMAIL_BACKEND_ENV_VAR, backend)

    with pytest.raises(RuntimeError, match=email.EMAIL_BACKEND_ENV_VAR) as excinfo:
        validate_email_config()

    assert email.BACKEND_SMTP in str(excinfo.value)


@pytest.mark.parametrize("backend", CONSOLE_BACKEND_VALUES)
def test_production_with_the_console_backend_refuses_to_boot(
    backend: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Choosing console in production is the same outage, merely on purpose.

    The casing and whitespace variants are the point: the factory strips and
    lowercases before it compares, so a validator that does not would wave
    ``" CONSOLE "`` through and the deploy would log the mail anyway.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, backend)

    with pytest.raises(RuntimeError, match=email.EMAIL_BACKEND_ENV_VAR):
        validate_email_config()


def test_production_refusal_names_the_unrecognized_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A typo must come back as a typo, not as a generic "not configured".

    An unrecognized name falls through to console exactly like an unset one, so
    the operator's own log-line evidence would tell them nothing. The backend
    name carries no secret, so this seam can afford to quote it -- and quoting
    it is the difference between reading the message and reading the source.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, UNRECOGNIZED_BACKEND)

    with pytest.raises(RuntimeError, match=email.EMAIL_BACKEND_ENV_VAR) as excinfo:
        validate_email_config()

    assert UNRECOGNIZED_BACKEND in str(excinfo.value)


@pytest.mark.parametrize("backend", SMTP_BACKEND_VALUES)
def test_production_with_a_configured_relay_boots_silently(
    backend: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The configured case is the quiet case -- nothing to raise, nothing to warn.

    Paired with the console cases, this pins both edges of the same comparison:
    whatever normalization the factory applies, the validator applies too, so
    the set that boots and the set that sends mail are one set.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, backend)
    _set_smtp_env(monkeypatch)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_email_config()

    assert caplog.records == []


@pytest.mark.parametrize("backend", [None, "", email.BACKEND_CONSOLE])
@pytest.mark.parametrize("env_value", NON_PRODUCTION_ENVS)
def test_non_production_keeps_the_console_default(
    env_value: str | None,
    backend: str | None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Requiring a relay to run tests or a local server would be friction, not safety.

    Reading the reset link out of the log is how development works here, so this
    check must stop at the environment gate before it forms an opinion about the
    backend at all.
    """
    _set_env(monkeypatch, ENV_VAR, env_value)
    _set_env(monkeypatch, email.EMAIL_BACKEND_ENV_VAR, backend)

    validate_email_config()

    assert email.configured_backend() == email.BACKEND_CONSOLE


def test_production_with_smtp_and_a_missing_relay_variable_refuses_to_boot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Half-wired is worse than unconfigured, because it looks configured.

    ``EMAIL_BACKEND=smtp`` alone only defers the error to whoever first asks for
    a reset. Building the sender at boot moves that cost onto the deploy, where
    someone is already watching.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, email.BACKEND_SMTP)
    _set_smtp_env(monkeypatch)
    monkeypatch.delenv("SMTP_HOST", raising=False)

    with pytest.raises(RuntimeError, match="SMTP_HOST"):
        validate_email_config()


@pytest.mark.parametrize("port", MALFORMED_PORTS)
def test_production_with_smtp_and_an_unusable_port_refuses_to_boot(
    port: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A relay that cannot be reached is not a configured relay, however it got that way.

    A set variable reads as a satisfied requirement to everything that only
    checks for presence, so an unreadable or unreachable port is the missing-var
    outage with the evidence removed. Refusing it here keeps the promise the
    eager build makes -- and keeps the refusal a sentence, rather than whatever
    the conversion throws on its way out of a boot.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, email.BACKEND_SMTP)
    _set_smtp_env(monkeypatch)
    monkeypatch.setenv(email.SMTP_PORT_ENV_VAR, port)

    with pytest.raises(RuntimeError, match=email.SMTP_PORT_ENV_VAR) as excinfo:
        validate_email_config()

    assert port in str(excinfo.value)


@pytest.mark.asyncio
@pytest.mark.usefixtures("production_journal_key")
async def test_boot_refuses_under_a_production_configuration_with_an_unusable_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Driven through the real ``lifespan``: this is what the deploy actually sees.

    Everything the startup check promises about a half-wired relay is only worth
    the path it sits on, and the port is where that path currently ends in a
    traceback with no variable in it. The Gumroad pair is left unset on purpose
    -- that state only warns, so the refusal here can only have come from email.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv("SKIP_STARTUP_SEED", "1")
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, email.BACKEND_SMTP)
    _set_smtp_env(monkeypatch)
    monkeypatch.setenv(email.SMTP_PORT_ENV_VAR, UNPARSEABLE_PORT)
    monkeypatch.delenv("GUMROAD_API_TOKEN", raising=False)
    monkeypatch.delenv("GUMROAD_WEBHOOK_SECRET", raising=False)

    with pytest.raises(RuntimeError, match=email.SMTP_PORT_ENV_VAR):
        async with _isolated_factory_patch(), lifespan(app):
            pytest.fail("startup completed with a relay port nothing can connect to")


def test_non_production_with_smtp_and_a_missing_relay_variable_still_boots(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The lazy raise survives outside production, deliberately.

    A developer pointing at a relay they have not finished configuring should
    still get a server; they find out when they send, which is when they asked.
    """
    monkeypatch.setenv(ENV_VAR, "development")
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, email.BACKEND_SMTP)
    _set_smtp_env(monkeypatch)
    monkeypatch.delenv("SMTP_HOST", raising=False)

    validate_email_config()


@pytest.mark.asyncio
@pytest.mark.usefixtures("production_journal_key")
async def test_boot_refuses_under_a_production_configuration_with_no_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Driven through the real ``lifespan``: a validator nobody wired in guards nothing.

    Calling the function proves the rule; running the app's own startup proves
    the rule sits on the path a deployment actually takes. The Gumroad pair is
    left wholly unset on purpose -- that state only warns, so the refusal here
    can only have come from email.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv("SKIP_STARTUP_SEED", "1")
    monkeypatch.delenv(email.EMAIL_BACKEND_ENV_VAR, raising=False)
    monkeypatch.delenv("GUMROAD_API_TOKEN", raising=False)
    monkeypatch.delenv("GUMROAD_WEBHOOK_SECRET", raising=False)

    with pytest.raises(RuntimeError, match=email.EMAIL_BACKEND_ENV_VAR):
        async with _isolated_factory_patch(), lifespan(app):
            pytest.fail("startup completed with password-reset mail going to the log")


@pytest.mark.asyncio
async def test_boot_completes_in_development_with_no_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same startup path, console-backed, still boots a laptop -- the quiet side."""
    monkeypatch.setenv(ENV_VAR, "development")
    monkeypatch.setenv("SKIP_STARTUP_SEED", "1")
    monkeypatch.delenv(email.EMAIL_BACKEND_ENV_VAR, raising=False)

    async with _isolated_factory_patch(), lifespan(app):
        assert email.configured_backend() == email.BACKEND_CONSOLE


@pytest.mark.parametrize("document", REMEDY_DOCUMENTS, ids=lambda path: path.name)
@pytest.mark.parametrize("env_var", DOCUMENTED_ENV_VARS)
def test_the_remedy_documents_name_the_email_variables(env_var: str, document: Path) -> None:
    """The refusal sends operators to two files, so both of them have to answer.

    A message that names a variable and a file which does not mention it has
    handed over half a remedy, and checking only one of the two named files
    leaves the other half unguarded. The relay variables belong in each
    alongside the switch: setting the switch alone is what produces the second
    refusal.

    This is a floor, not a proof: it asks whether each name is present, not
    whether what surrounds it is still true. An edit that marked the switch
    optional again while keeping the name would pass here.
    """
    assert env_var in document.read_text(encoding="utf-8"), (
        f"{document} must document {env_var}: the production refusal points "
        f"operators here for the configuration it is asking them to supply."
    )


def _call_read_argument(node: ast.Call) -> str | None:
    """Return the unparsed name argument when ``node`` is an environment read."""
    if ast.unparse(node.func) in ENVIRON_READ_CALLS and node.args:
        return ast.unparse(node.args[0])
    return None


def _environment_read(node: ast.expr) -> str | None:
    """Return the variable-name expression ``node`` reads from the environment.

    Covers both spellings the codebase uses -- a call (``os.getenv``,
    ``os.environ.get``) and a subscript (``os.environ[...]``) -- and returns the
    argument unparsed, so a read through the module constant is recognised as
    readily as one through a bare literal.
    """
    if isinstance(node, ast.Call):
        return _call_read_argument(node)
    if isinstance(node, ast.Subscript) and ast.unparse(node.value) in ENVIRON_MAPPINGS:
        return ast.unparse(node.slice)
    return None


def _backend_variable_reads_in(path: Path) -> Iterator[int]:
    """Yield each line of ``path`` that reads the backend-selector variable."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.expr) and _environment_read(node) in BACKEND_VAR_SPELLINGS:
            yield node.lineno


def _backend_variable_reads() -> Iterator[tuple[Path, int]]:
    """Yield ``(path, line)`` for every read of the selector across ``backend/src``."""
    for path in sorted(BACKEND_SRC.rglob("*.py")):
        for lineno in _backend_variable_reads_in(path):
            yield path, lineno


def _reader_line_span() -> range:
    """Return the line range of ``configured_backend``, the one sanctioned reader."""
    tree = ast.parse(EMAIL_MODULE.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == READER_FUNCTION:
            return range(node.lineno, (node.end_lineno or node.lineno) + 1)
    pytest.fail(f"{EMAIL_MODULE} no longer defines {READER_FUNCTION}.")


def test_one_function_is_the_only_reader_of_the_backend_variable() -> None:
    """Two readers of this variable is the outage, and only a sweep can forbid it.

    The whole check rests on the validator and the sender factory comparing one
    normalized value. The moment a second ``os.getenv`` for it appears anywhere
    in the backend, that guarantee is decided by whichever normalization the new
    reader happens to use -- and a boot certified as smtp whose mail then goes
    to the console adapter is indistinguishable from delivery. Being true today
    is not a property; refusing the second reader is.
    """
    sanctioned = _reader_line_span()
    reads = list(_backend_variable_reads())
    strays = [
        f"{path.relative_to(REPO_ROOT)}:{lineno}"
        for path, lineno in reads
        if path != EMAIL_MODULE or lineno not in sanctioned
    ]

    assert reads, (
        f"No read of {email.EMAIL_BACKEND_ENV_VAR} was found at all, so this sweep is "
        f"proving nothing -- {READER_FUNCTION} must still read it."
    )
    assert not strays, (
        f"{READER_FUNCTION} in {EMAIL_MODULE.name} must be the only reader of "
        f"{email.EMAIL_BACKEND_ENV_VAR}; also read at: {', '.join(strays)}. Route the "
        f"value through {READER_FUNCTION}() so one normalization decides both the "
        f"startup refusal and the sender the factory builds."
    )


@pytest.mark.parametrize("backend", HTTPS_BACKEND_VALUES)
def test_production_with_the_https_backend_boots_silently(
    backend: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The backend a real deploy ships with has to be a backend this check accepts.

    The platform blocks outbound SMTP below its paid tier, so ``smtp`` on the
    deployed service hangs for its connect timeout and the endpoint answers 202
    anyway -- the original outage with the variable correctly set. An HTTPS
    sender is the production-viable choice, and a check that still admits only
    ``smtp`` makes shipping it impossible. The casing variants ride along for
    the reason they do for ``smtp``: the set this accepts and the set the
    factory builds have to be one set.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, backend)
    _set_https_delivery_env(monkeypatch)
    caplog.set_level(logging.WARNING, logger=MAIN_LOGGER)

    validate_email_config()

    assert caplog.records == []


@pytest.mark.parametrize("missing", sorted(RESEND_ENV_VALUES))
def test_production_with_the_https_backend_and_a_missing_variable_refuses_to_boot(
    missing: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The eager build is a promise about every backend, not only the relay.

    ``EMAIL_BACKEND=resend`` with no credential defers the failure to whoever
    first asks for a reset, and that request answers 202 on the way down. The
    smtp path already pays this cost at boot; a second backend that did not
    would reintroduce the deferred failure through the door that was just
    opened for it.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, email.BACKEND_RESEND)
    _set_https_delivery_env(monkeypatch)
    monkeypatch.delenv(missing, raising=False)

    with pytest.raises(RuntimeError, match=missing):
        validate_email_config()


def test_the_refusal_offers_both_backends_and_names_the_routable_one_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A remedy naming one of two working answers sends operators at the broken one.

    This is the direction a widening silently loses. The refusal's whole value
    is the sentence it hands over, and on this deployment the ``smtp`` it
    names is the choice that cannot work -- following it produces a green deploy
    that hangs on every send. Both accepted names have to appear, which is also
    what keeps the message honest about what the app implements.

    Order is part of the remedy, not presentation. An operator under a broken
    recovery flow tries the first thing offered, and the message's own docstring
    promises them "in the order an operator on the hosting platform should try
    them" -- a promise that is kept by a dict literal's declaration order and is
    therefore one careless reorder away from sending them at the transport the
    platform blocks.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, UNRECOGNIZED_BACKEND)

    with pytest.raises(RuntimeError) as excinfo:
        validate_email_config()

    message = str(excinfo.value)
    assert email.BACKEND_RESEND in message
    assert email.BACKEND_SMTP in message
    assert message.index(email.BACKEND_RESEND) < message.index(email.BACKEND_SMTP), (
        f"the refusal must offer {email.BACKEND_RESEND} before {email.BACKEND_SMTP}: "
        "the platform blocks outbound SMTP, so an operator who follows the first "
        "remedy offered would deploy the transport that cannot connect."
    )


@pytest.mark.parametrize("backend", [*ABSENT_BACKEND_VALUES, *CONSOLE_BACKEND_VALUES])
def test_production_still_refuses_a_backend_that_only_logs(
    backend: str | None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Widening the accepted set must not be implemented by deleting the comparison.

    The cheapest way to make an HTTPS backend pass this check is to soften the
    refusal into a warning, and every symptom of that is invisible: the deploy
    goes green, the endpoint answers 202, and the reset links accumulate in the
    log exactly as before. Pinning the refusal alongside the widening is what
    stops the fix from restoring the bug.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    _set_env(monkeypatch, email.EMAIL_BACKEND_ENV_VAR, backend)
    _set_https_delivery_env(monkeypatch)

    with pytest.raises(RuntimeError, match=email.EMAIL_BACKEND_ENV_VAR):
        validate_email_config()


@pytest.mark.asyncio
@pytest.mark.usefixtures("production_journal_key")
async def test_boot_completes_under_a_production_https_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Driven through the real ``lifespan``: the shipping configuration must start.

    The refusal tests all prove what stops a deploy. This one proves the
    configuration the deploy is being moved to is not itself refused somewhere
    further along the startup path -- which is the failure a widening made in
    only one of two places produces, and the one that would be discovered on the
    platform rather than here.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv("SKIP_STARTUP_SEED", "1")
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, email.BACKEND_RESEND)
    _set_https_delivery_env(monkeypatch)
    monkeypatch.delenv("GUMROAD_API_TOKEN", raising=False)
    monkeypatch.delenv("GUMROAD_WEBHOOK_SECRET", raising=False)

    async with _isolated_factory_patch(), lifespan(app):
        assert email.configured_backend() == email.BACKEND_RESEND


@pytest.mark.asyncio
@pytest.mark.usefixtures("production_journal_key")
async def test_boot_refuses_a_production_deploy_with_no_web_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A delivered email whose links nobody can open is delivery that does not recover.

    Web is the only platform shipping, so an unset origin means every reset
    email carries only a custom-scheme link and every recipient is still locked
    out -- delivery succeeds, the endpoint answers 202, and nothing reports a
    failure. That is the same silent shape as the console default, so it takes
    the same remedy. The delivery backend is fully configured here on purpose:
    the refusal can then only have come from the missing origin.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv("SKIP_STARTUP_SEED", "1")
    monkeypatch.setenv(email.EMAIL_BACKEND_ENV_VAR, email.BACKEND_RESEND)
    _set_https_delivery_env(monkeypatch)
    monkeypatch.delenv(WEB_BASE_URL_ENV_VAR, raising=False)
    monkeypatch.delenv("GUMROAD_API_TOKEN", raising=False)
    monkeypatch.delenv("GUMROAD_WEBHOOK_SECRET", raising=False)

    with pytest.raises(RuntimeError, match=WEB_BASE_URL_ENV_VAR):
        async with _isolated_factory_patch(), lifespan(app):
            pytest.fail("startup completed with no origin for the reset links")


@pytest.mark.parametrize("document", REMEDY_DOCUMENTS, ids=lambda path: path.name)
@pytest.mark.parametrize("env_var", HTTPS_DELIVERY_ENV_VARS)
def test_the_remedy_documents_name_the_https_delivery_variables(
    env_var: str, document: Path
) -> None:
    """The widened refusal points at the same two files, so both owe the new answer.

    An operator handed a backend name they cannot find in either document has
    been given a name, not a remedy -- and the variables behind it are exactly
    the ones the second refusal will stop them on.
    """
    assert env_var in document.read_text(encoding="utf-8"), (
        f"{document} must document {env_var}: the production refusal points "
        f"operators here for the configuration it is asking them to supply."
    )


def test_the_deployment_guide_records_that_the_platform_blocks_outbound_smtp() -> None:
    """The documented recipe walked this deployment straight into the outage.

    DEPLOYMENT.md presents an SMTP relay as the production-viable choice and
    names a relay host to point it at. On this platform that configuration
    cannot connect at all, so an operator following the guide gets a green
    deploy, a hung send, and a 202 -- and no way to tell from anything written
    down that the transport was never going to work. One sentence saying so is
    the difference between a five-minute fix and rediscovering this bug.
    """
    text = DEPLOYMENT_DOC.read_text(encoding="utf-8").lower()
    blocked = [line for line in text.splitlines() if "outbound" in line and "smtp" in line]

    assert blocked, (
        f"{DEPLOYMENT_DOC.name} must state that the platform blocks outbound SMTP: "
        "its current recipe reads as a working production setup and is not one."
    )


@pytest.mark.parametrize("origin", UNFOLLOWABLE_WEB_BASE_URLS)
def test_production_with_an_unfollowable_web_origin_refuses_to_boot(
    origin: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Presence is not usability, and a check that confuses them ships this bug.

    A validator that accepted any non-empty string would certify
    ``APP_BASE_URL=app.aptitude.guru`` -- a value the platform's editor takes
    happily, and the exact shape of the CORS variable a few rows above it. The
    link it renders is a string no mail client linkifies and no browser
    resolves: mail delivered, endpoint 202, user still locked out. That is the
    outage this refusal exists for, arriving with a green boot.

    ``http://`` is refused on its own terms. The link carries a bearer token
    with a thirty-minute life, and plaintext puts it on the wire.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(WEB_BASE_URL_ENV_VAR, origin)

    with pytest.raises(RuntimeError, match=WEB_BASE_URL_ENV_VAR):
        validate_app_base_url_config()


def test_production_accepts_the_origin_the_deployment_will_actually_carry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The refusals above are worthless if the shipping value is refused too.

    A scheme rule written one character wrong rejects everything, and every
    refusal test still passes -- the failure would surface on the platform, as a
    boot loop across the whole API rather than a password-reset bug.
    """
    monkeypatch.setenv(ENV_VAR, "production")
    monkeypatch.setenv(WEB_BASE_URL_ENV_VAR, WEB_BASE_URL)

    validate_app_base_url_config()


@pytest.mark.parametrize("env_value", NON_PRODUCTION_ENVS)
def test_a_developer_machine_is_not_held_to_the_origin_rule(
    env_value: str | None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The rule is about what a stranger's mail client can open, which dev has none of.

    Outside production the origin falls back to the Expo dev server over plain
    ``http``, and a developer reading the link out of the console log is the
    intended path. A scheme rule applied here would refuse every local boot.
    """
    _set_env(monkeypatch, ENV_VAR, env_value)
    monkeypatch.delenv(WEB_BASE_URL_ENV_VAR, raising=False)

    validate_app_base_url_config()


def test_the_configured_origin_is_read_without_its_trailing_slashes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pinned on its own, because the link tests would go red for other reasons.

    ``https://host//reset-password`` is a different path from
    ``https://host/reset-password``, and the servers that redirect between them
    drop the query string on the way -- which lands on the user as a dead link
    and on the operator as nothing at all. Asserting it here rather than only
    through a rendered email body means a regression in the stripping is
    attributable to the stripping.
    """
    monkeypatch.setenv(WEB_BASE_URL_ENV_VAR, f"{WEB_BASE_URL}//")

    assert app_links.configured_web_base_url() == WEB_BASE_URL
