"""Watch, at the instant of every outbound call, whether this request still holds a connection.

The property
============

One sentence, and every row of the census below is an instance of it: **at the
moment adepthood dials anything off-box, the session serving that request must
not be in a transaction.** An open transaction is a checked-out pooled
connection. The engine takes SQLAlchemy's defaults -- five connections plus ten
of overflow, thirty-second checkout timeout -- so fifteen concurrent requests
that dial a language model under an open transaction hold the entire pool for
the length of a provider round trip, and the next request to *any*
database-backed endpoint blocks at checkout and then fails. Nothing about that
is visible in a handler: the code reads as an ordinary sequence of awaits.

The structural fact that makes it blameless everywhere
------------------------------------------------------

``get_current_user`` runs a token-revocation SELECT on the request's own
session. Every authenticated route therefore enters its handler body with a
transaction already open, opened by a dependency the handler never mentions. So
the question at a dial site is never "did this handler open a transaction" --
one is always open -- it is always and only **"did anything release it before
the dial"**. A reviewer reading a handler top to bottom and seeing no query
before the ``await`` is reading a defect that looks correct.

What this module is, and what it is not
---------------------------------------

It is a **runtime observer**, and in this first form it is **report-only**: it
records observations and never raises. The assertions live in the census test
file that drives each route; a row known to be defective ships there under
``xfail(strict=True)``, which keeps the suite green today and turns red the day
someone fixes the row without striking it from the census.

It is **blind to any path no test drives**. That blindness is not hypothetical
and it is not small: corpus consent defaults to off, so an ordinary
``POST /journal/`` never reaches the classifier chokepoint at all, and an
observer watching that leaf records nothing whether the site is fixed, broken,
or deleted. Absence of observation is not evidence of correctness, and this
module cannot tell the two apart. Enumerating the paths no test drives needs a
static sweep over the source, which is a separate piece of work; until it
exists, read a silent leaf as unexamined rather than as healthy. Every
assertion helper here therefore refuses to pass on an empty observation list.

Explicitly out of scope: the pool's own settings. Raising ``pool_size`` does not
shorten a hold whose duration is a language model's latency, and widening the
pool while seven sites still dial under an open transaction would suppress the
very signal this instrument exists to produce.

How it sees what it sees
========================

Four hooks, each answering an evasion the previous one admits.

**1. Session-level transaction listeners.** ``after_begin`` and
``after_transaction_end`` on the ORM ``Session`` class give a live set of
sessions currently holding a connection, process-wide, with no cooperation from
any session factory. That set is what distinguishes "this leaf ran with nobody's
transaction open" from "it ran with somebody's open, but not this request's".

**2. A context variable naming the request's own session.** The live set alone
is *not* the property: it is process-global, and a test that holds a seeding
session open across a request would read as a violation at every boundary. The
provider occupying ``app.dependency_overrides[get_session]`` is wrapped so the
session it yields is bound to a :class:`~contextvars.ContextVar` for the
duration of that request. Held-ness is then attributed to the request's own
session, which is correct under the shared-session client fixture and under the
per-request concurrent one alike.

**3. A module class with a ``__setattr__`` hook.** The suite stubs providers;
an observer that watched the socket would see nothing and pass everywhere. So
what is instrumented is not the network but *the seam a test replaces*. Each
module holding a binding to a registry leaf has its ``__class__`` swapped for a
:class:`ModuleType` subclass whose ``__setattr__`` wraps the incoming value --
so ``monkeypatch.setattr(module, name, stub)`` installs an instrumented stub,
and the observer rides whatever the test substitutes. Wrapping is idempotent
via a marker attribute, so ``monkeypatch.undo`` -- which re-sets the value it
saved, namely our wrapper -- unwraps first and cannot nest layers.

**4. An instrumenting ``dependency_overrides`` mapping.** Vault clients and
email senders are not module attributes; they are objects injected through
FastAPI. The overrides mapping is replaced by a ``dict`` subclass that wraps the
registered providers, and the object each yields has its dial verbs instrumented
**per instance, with ``setattr``, never behind a proxy** -- dozens of override
sites assert ``isinstance`` on the resolved client, and a proxy would break
every one of them.

Binding sites are found by **object identity** over the loaded source tree, not
by the spelling at a call site. ``from services.botmason import
generate_response as _llm`` binds a new name in a new module, which a text or
AST matcher walks straight past; ``value is origin`` cannot be walked past,
because the alias and the original are the same object.

Known limitations, stated rather than discovered
------------------------------------------------

* A leaf no test reaches is silent, as above.
* ``unittest.mock`` objects are left uninstrumented on purpose, because wrapping
  one would shadow the ``assert_called`` / ``call_count`` API its test asserts
  on. A row stubbed with a ``Mock`` therefore records nothing and fails its own
  non-emptiness guard -- loudly, as a broken test, rather than as a false pass.
* An object with ``__slots__`` cannot take a per-instance attribute; that is
  recorded as uninstrumentable rather than raised, so a future slotted double
  does not take the suite down.
* A boundary reached from a task spawned after the response was returned finds
  the session already closed and is a correct pass, not an evasion -- but it is
  also not an endorsement, since the deferred work then has no connection when
  it needs one.
* Deleting the module-class swap would quietly stop the observer seeing stubs
  while everything still passed. ``install`` therefore refuses to start if any
  registry leaf has no binding site at all.

The census
==========

Twenty-three rows: every site in the tree where an outbound call is reachable
from a request, including the ones that are *fine*, and why each is fine. A
census that lists only failures cannot tell a reader whether an unlisted site
was examined or missed.

Live and defective (eight)
--------------------------

**1. POST /journal/{entry_id}/resonance -> CreekVaultClient.handshake**, through
``run_resonance`` -> ``select_reflection_llm``. The handler loads the entry
(SELECT), stages a wallet deduction that deliberately does not commit, gathers
grounding (more SELECTs), and only then probes the vault's capabilities. The
first commit is far below. A dirty, write-holding transaction is held across an
HTTP handshake. The handler's docstring offers an atomicity argument for the
LLM pass that follows; that argument does not reach here, because a capability
probe's result is not something a rollback can undo.

**2. POST /journal/{entry_id}/resonance -> the reflection pass**, through
``_resonance_pass_or_care`` to either ``CreekVaultClient.reflect`` or
``generate_response``. The same open dirty transaction, held across a full
language-model reflection -- the longest hold in the repository alongside the
essay row. Unlike row 1 this is a genuine trade the handler argues for: the
pass, the persistence and the charge commit together, so a provider error rolls
the deduction back and a failed pass never charges. It is a correctness
decision, not an oversight, and it is one of the two rows an enforcing gate
should eventually allowlist in prose rather than "fix".

**3. POST /journal/marginalia/{marginalia_id}/essay -> generate_response**,
through ``_cache_essay`` -> ``generate_essay``. Two SELECTs, then the language
model, then a commit. Nothing about the essay is transactional; the commit is
simply in the wrong place.

**4. GET /invitations -> CreekVaultClient.handshake / .wheel**, through
``generate_invitation_signals`` -> ``_gather_aggregates`` ->
``_gather_corpus_themes``. The aggregate's four arguments evaluate in order:
three database gathers, then the vault. The transaction is open here regardless
of which vault branch the dependency took, because those three gathers reopen
it. On a polled list endpoint.

**5. POST /auth/password-reset/confirm -> EmailSender.send**, through
``_send_change_notification_safely``. ``_apply_reset_to_user`` commits and then
calls ``session.refresh`` on the very next line; the refresh emits a SELECT and
autobegins a fresh transaction, undoing the release the commit just made. The
notification email -- SMTP, capped at thirty seconds by its connect timeout --
is then sent under it. This is the sharpest row in the census, because its
sibling ``request_password_reset`` is safe and the two differ by exactly one
``session.refresh`` line.

**6. POST /auth/oauth/google and POST /auth/oauth/apple -> verify_aptitude_license
-> verify_license**, through ``_resolve_oauth_user`` -> ``_create_oauth_account``
-> ``_verify_oauth_license``. Resolving an existing account first issues an
identity SELECT and an email SELECT; on the create path those return nothing and
the handler dials a third-party licensing host, with its own retry loop, under
the transaction they opened.

**7. GET /stages/wheel -> CreekVaultClient.handshake / .wheel**, through
``select_wheel_balance`` -> ``fetch_vault_wheel``, for a caller served the
deployment-wide vault. **Closed by this change.** See "The one production
change" below.

**8. POST /corpus/import -> CreekVaultClient.handshake / .upload**, through
``import_document`` -> ``_to_vault``, under the same deployment-wide-vault
condition as row 7, and the router's commit comes after the call rather than
before it. **Closed by this change**, for the same reason and by the same line.

Live and deliberate (one)
-------------------------

**9. POST /journal/transcribe-page -> generate_response.** The wallet
deduction is staged and uncommitted, the vision model is called, and every one
of the three error arms rolls the deduction back so a provider failure never
charges. That is real atomicity, bought at the price of a pooled connection held
for the longest-latency provider shape in the repository. "Deliberate" is not
"exempt": it is the row most likely to be used to argue a gate down, so it wants
a written allowlist entry naming both the benefit and the cost, never a silent
omission.

Dead (one)
----------

**10. services/frequency_source.py.** No router, service, domain module,
dependency or script imports it; every reference outside the module is a
docstring cross-reference or a test. Its own docstring concedes the vault branch
is unreachable in this deployment. It takes no session, so it could not hold a
connection even if something called it. It should be deleted rather than carried
as a standing census exemption.

Already fixed, and listed so a reader can tell examined from missed (four)
-------------------------------------------------------------------------

**11. services/creek_vault_pipeline.py**, both the per-stage run and the whole
pipeline drive: a commit is the statement immediately before the classify and
link calls.

**12. services/corpus_ingest.py, ``_classify_and_record``.** A commit
immediately in front of the one provider call, at a chokepoint four callers pass
through -- the only fix in the repository shaped like a chokepoint rather than a
per-site patch, and the shape every future fix should copy: a fifth caller
inherits the release without knowing it exists.

**13. services/creek_vault_url_resolution.py, the off-the-pool classifier
seam**, called by the vault-connection route and by the vault dependency's
re-judgement of a stored host. It commits and then resolves. Note what it is
*not*: its signature takes a host and returns a URL finding, so it is a
two-line DNS fix in a helper's costume. Nothing that dials a language model, an
email host or a licensing API can call it, which is exactly why the invariant
needed an instrument rather than a shared helper.

**14. routers/journal.py, ``_record_vault_outcome`` and
``_record_corpus_fragment``.** The first commits immediately before the vault
store; the second commits after its ingest and says why -- the release now lives
inside the ingest chokepoint.

Safe, and why (nine)
--------------------

**15. POST /auth/signup -> verify_aptitude_license.** The licensing call is the
handler's first awaited statement, ahead of the duplicate-email check. Safe by
ordering -- and the ordering is load-bearing for account enumeration, so it is
stable for a reason that has nothing to do with the pool.

**16. POST /auth/password-reset/request -> EmailSender.send.** Mints and
persists the token, commits, and sends. No refresh follows the commit, and the
session factory does not expire on commit, so nothing lazy-loads. The safe twin
of row 5.

**17. POST /auth/oauth/* -> the identity-provider JWKS fetch.** The first
statement of the handler body, before any SELECT, on routes that do not depend
on ``get_current_user``. Safe by position only -- one reordering away from
defective, and the licensing call further down the same handler is already
row 6.

**18. PUT /corpus/consent/{source} -> ingest.** Reaches the ingest chokepoint,
which commits before the provider call -- landing the staged consent event early,
which the chokepoint names as intended. Safe because row 12 covers it: the
property belongs to the service, not to this router.

**19. DELETE /journal/{entry_id}.** Withdrawal is a delete plus a log line. No
provider call anywhere in the handler.

**20. POST /corpus/import -> drive_vault_pipeline.** The router commits before
the call, and the pipeline commits again before it dials. Safe on both counts;
distinct from row 8, which is the upload earlier in the same handler.

**21. services/creek_vault_pinned_transport.py -> resolve_host_addresses.** Not
an independent row: a name lookup inside the connect of whichever vault call is
in flight, inheriting that call's transaction state. It is listed because it
changes the *severity* of every vault row above -- each is really a vault call
plus an uncached lookup -- and because a resolver timeout frees the coroutine
but not the resolver thread.

**22. domain/entitlements.py -> verify_license.** Takes no session and cannot
hold a connection; its transaction state is decided entirely by its two callers,
rows 6 and 15. Listed to close the trace from the network leaf back to an HTTP
entrypoint.

**23. services/botmason.py -> the provider SDK calls.** The language-model leaf
behind ``generate_response``. No session parameter, holds nothing on its own.
Listed so rows 2, 3 and 9 all trace to one place.
"""

from __future__ import annotations

import contextlib
import importlib
import inspect
import sys
import traceback
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
    Generator,
    Iterator,
    Mapping,
    Sequence,
)
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Final, Literal, cast
from unittest.mock import NonCallableMock

from fastapi import FastAPI
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from database import get_session
from dependencies.creek_vault import get_creek_vault_client
from services.email import get_email_sender

__all__ = [
    "ConnectionHeldAcrossOutboundCallError",
    "Observation",
    "OutboundBoundaryObserver",
    "assert_dialled_off_the_pool",
    "observe_outbound_boundaries",
]

# The tree whose name bindings are swept. Modules outside it -- the standard
# library, site-packages, the test tree itself -- are never instrumented.
_SRC_ROOT: Final = str(Path(__file__).resolve().parents[2] / "src")

# The marker that makes wrapping idempotent. ``monkeypatch.undo`` re-sets the
# value it saved, which is our wrapper; unwrapping through this attribute first
# means a test with many setattr/undo cycles never accumulates layers.
_BOUNDARY_MARKER: Final = "__wrapped_boundary__"

_SIGNATURE_ATTR: Final = "__signature__"

# How many source frames of the call stack an observation carries. Enough to
# name the route and the path it took, bounded so the record stays readable.
_FRAME_LIMIT: Final = 12

_Kind = Literal["dial", "vault_factory"]

# Distinguishes "this class defined the method itself" from "it inherited one",
# so restoring never leaves a shadowing copy on a subclass.
_INHERITED: Final = object()

# The egress leaves. Every live census row passes through one of these five
# families, so an author cannot reach a provider without touching one -- which
# is the whole reason the registry keys on leaves rather than on call sites.
_DIAL_LEAVES: Final[tuple[tuple[str, str], ...]] = (
    ("services.botmason", "generate_response"),
    ("domain.entitlements", "verify_aptitude_license"),
    ("integrations.gumroad", "verify_license"),
    ("services.creek_vault_url_resolution", "resolve_host_addresses"),
)

# The two constructors that hand back a real vault client. Instrumenting them
# rather than the client's class means a double a test substitutes for either
# one is instrumented on its way out, without the test knowing this exists.
_CLIENT_FACTORIES: Final[tuple[tuple[str, str], ...]] = (
    ("services.creek_vault_client", "build_creek_vault_client"),
    ("services.creek_vault_client", "build_connected_vault_client"),
)

# The vault protocol's dialling verbs. ``is_available`` and ``supports`` are
# excluded on purpose: they report the last handshake's answer from memory and
# reach nothing.
_VAULT_DIAL_VERBS: Final[tuple[str, ...]] = (
    "handshake",
    "ingest",
    "upload",
    "classify",
    "classify_corpus",
    "link_corpus",
    "reflect",
    "wheel",
)

_EMAIL_DIAL_VERBS: Final[tuple[str, ...]] = ("send",)

# Stable census keys for the two injected families, so a label names the seam
# rather than whichever double a given test happened to install.
_VAULT_LABEL: Final = "CreekVaultClient"
_EMAIL_LABEL: Final = "EmailSender"

# The session serving the request currently in flight. Set by wrapping whatever
# provider occupies the ``get_session`` override, so held-ness is attributed to
# this request's session rather than to a process-global set.
_REQUEST_SESSION: ContextVar[Session | None] = ContextVar(
    "outbound_boundary_request_session", default=None
)


@dataclass(frozen=True)
class Observation:
    """One outbound call, and what the request was holding when it was issued."""

    leaf: str
    held: bool | None
    live_sessions: int
    frames: tuple[str, ...]


class ConnectionHeldAcrossOutboundCallError(AssertionError):
    """Raised when a request dialled out with its own transaction still open.

    Distinct from a bare :class:`AssertionError` so a census row marked
    ``xfail(raises=ConnectionHeldAcrossOutboundCallError)`` fails loudly when it goes
    red for any *other* reason -- a broken happy path, or a leaf the test never
    reached. Without that distinction an expected-red row could be satisfied by
    a setup mistake and nobody would learn anything.
    """


class OutboundBoundaryNotInstalledError(RuntimeError):
    """Raised when the observer cannot find a registry leaf to instrument.

    A leaf with no binding site anywhere in the source tree means the registry
    has drifted from the code, and an observer instrumenting nothing reports
    clean forever. Failing at install is the only moment that is cheap to
    notice.
    """


@dataclass(frozen=True)
class _LeafSpec:
    """What a guarded module attribute is, and what to record it as."""

    label: str
    kind: _Kind


@dataclass(frozen=True)
class _Guard:
    """The instrumentation one module is currently under."""

    observer: OutboundBoundaryObserver
    specs: Mapping[str, _LeafSpec]


# Keyed by module name, which is unique in ``sys.modules``. One observer is
# installed at a time, and ``uninstall`` empties this.
_GUARDS: dict[str, _Guard] = {}


class _WatchedModule(ModuleType):
    """A module whose registry names stay instrumented across substitution.

    ``monkeypatch.setattr``, ``unittest.mock.patch`` and a bare assignment all
    funnel through ``setattr`` on the module object, so a stub installed by any
    of them is wrapped on its way in. This is the whole answer to a stubbed
    suite: the observer does not watch the network, it watches the seam the test
    replaces.
    """

    def __setattr__(self, name: str, value: object) -> None:
        """Instrument a guarded name on its way into the module."""
        guard = _GUARDS.get(self.__name__)
        if guard is not None:
            spec = guard.specs.get(name)
            if spec is not None:
                value = guard.observer.instrument(_unwrap(value), spec)
        object.__setattr__(self, name, value)


def _unwrap(value: object) -> object:
    """Return the original behind an instrumented value, or the value itself."""
    return getattr(value, _BOUNDARY_MARKER, value)


def _is_async_callable(target: object) -> bool:
    """Report whether calling ``target`` returns an awaitable.

    Covers both a coroutine function and a callable *instance* whose
    ``__call__`` is one -- the shape the suite's language-model doubles use.
    """
    if inspect.iscoroutinefunction(target):
        return True
    # Fetched statically rather than through ``callable``, because the question
    # is not whether the object can be called -- it is whether calling it yields
    # an awaitable, which only the unbound ``__call__`` can answer.
    call = inspect.getattr_static(type(target), "__call__", None)
    return call is not None and inspect.iscoroutinefunction(call)


def _source_modules() -> list[ModuleType]:
    """Return every loaded module whose file lives under the backend source tree."""
    modules: list[ModuleType] = []
    for module in list(sys.modules.values()):
        path = getattr(module, "__file__", None)
        if path is None:
            continue
        if str(Path(path).resolve()).startswith(_SRC_ROOT):
            modules.append(module)
    return modules


def _frames() -> tuple[str, ...]:
    """Return the tail of the current stack, restricted to backend source frames."""
    named = [
        f"{Path(frame.filename).name}:{frame.name}"
        for frame in traceback.extract_stack()
        if frame.filename.startswith(_SRC_ROOT)
    ]
    return tuple(named[-_FRAME_LIMIT:])


def assert_dialled_off_the_pool(observations: Sequence[Observation], *, what: str) -> None:
    """Assert that every recorded outbound call was issued with no connection held.

    The order of these three checks is load-bearing and must not be relaxed.
    An empty list is a test that never reached its leaf, and ``not any([])`` would
    call that a pass -- so non-emptiness is asserted first, and the failure says
    so in the words the existing per-site assertions already use. An observation
    the observer could not attribute to a request's own session is likewise a
    silent hole rather than a clean read. Only then is the property itself
    asserted, and it raises its own exception type so an expected-red row cannot
    be satisfied by either of the first two failures.

    Args:
        observations: What the observer recorded for the act under test.
        what: The thing that should have been observed, named for the message.
    """
    assert observations, f"no {what} was observed"
    unattributed = [record for record in observations if record.held is None]
    assert not unattributed, (
        f"no request session was bound for {unattributed}; "
        "the get_session override was not instrumented"
    )
    held = [record for record in observations if record.held]
    if held:
        raise ConnectionHeldAcrossOutboundCallError(
            f"connection held across {what}: {held}",
        )


class OutboundBoundaryObserver:
    """Records every outbound call the app makes, and what it was holding."""

    def __init__(self, app: FastAPI) -> None:
        """Bind the application whose overrides and modules will be instrumented."""
        self._app = app
        self.observations: list[Observation] = []
        self.uninstrumentable: list[str] = []
        self._live: set[Session] = set()
        self._detached = False
        self._listening = False
        self._patched: list[tuple[ModuleType, type[ModuleType], dict[str, object]]] = []
        self._patched_classes: list[tuple[type, str, object]] = []
        self._original_overrides: dict[Callable[..., object], Callable[..., object]] | None = None
        self._provider_handlers: dict[object, Callable[[object], object]] = {
            get_session: self._bind_request_session,
            get_creek_vault_client: self.watch_vault_client,
            get_email_sender: self._watch_email_sender,
        }

    # -- observation ------------------------------------------------------

    def reset(self) -> None:
        """Forget everything recorded so far, and unbind the request session.

        Called between the arrange and act phases of a census test, because
        signing a user up already dials the licensing leaf and those
        observations belong to nothing under test.
        """
        self.observations.clear()
        self.uninstrumentable.clear()
        _REQUEST_SESSION.set(None)

    def _record(self, label: str) -> None:
        # A wrapper can outlive its observer: ``monkeypatch`` saves whatever the
        # module attribute held when it patched -- which is our wrapper -- and
        # restores it on undo, *after* this fixture has already put the original
        # back. The residue is unavoidable (nothing can make a teardown run after
        # monkeypatch's) so it is made inert here instead, rather than left to
        # append to a list nobody will ever read for the rest of the session.
        if self._detached:
            return
        session = _REQUEST_SESSION.get()
        self.observations.append(
            Observation(
                leaf=label,
                held=None if session is None else session.in_transaction(),
                live_sessions=len(self._live),
                frames=_frames(),
            )
        )

    def _after_begin(self, session: Session, _transaction: object, _connection: object) -> None:
        self._live.add(session)

    def _after_transaction_end(self, session: Session, _transaction: object) -> None:
        if not session.in_transaction():
            self._live.discard(session)

    def _bind_request_session(self, value: object) -> None:
        if isinstance(value, AsyncSession):
            _REQUEST_SESSION.set(value.sync_session)
        elif isinstance(value, Session):
            _REQUEST_SESSION.set(value)

    # -- instrumentation --------------------------------------------------

    def instrument(self, target: object, spec: _LeafSpec) -> object:
        """Return ``target`` wrapped so its calls are observed, or unchanged.

        A mock is returned unchanged on purpose: wrapping one would hide the
        ``assert_called`` / ``call_count`` API its test asserts on, and a row
        stubbed with a mock is better off failing its own non-emptiness guard.
        """
        if isinstance(target, NonCallableMock) or not callable(target):
            self.uninstrumentable.append(spec.label)
            return target
        if spec.kind == "dial":
            wrapper = self._dial_wrapper(target, spec.label)
        else:
            wrapper = self._vault_factory_wrapper(target)
        setattr(wrapper, _BOUNDARY_MARKER, target)
        return wrapper

    def _dial_wrapper(self, target: object, label: str) -> Callable[..., object]:
        if _is_async_callable(target):
            awaitable_call = cast("Callable[..., Awaitable[object]]", target)

            async def watched_async(*args: object, **kwargs: object) -> object:
                self._record(label)
                return await awaitable_call(*args, **kwargs)

            return watched_async

        plain_call = cast("Callable[..., object]", target)

        def watched(*args: object, **kwargs: object) -> object:
            self._record(label)
            return plain_call(*args, **kwargs)

        return watched

    def _vault_factory_wrapper(self, target: object) -> Callable[..., object]:
        if _is_async_callable(target):
            awaitable_call = cast("Callable[..., Awaitable[object]]", target)

            async def built_async(*args: object, **kwargs: object) -> object:
                return self.watch_vault_client(await awaitable_call(*args, **kwargs))

            return built_async

        plain_call = cast("Callable[..., object]", target)

        def built(*args: object, **kwargs: object) -> object:
            return self.watch_vault_client(plain_call(*args, **kwargs))

        return built

    def watch_vault_client(self, client: object) -> object:
        """Instrument every dialling verb on one vault client instance."""
        return self._watch_instance(client, _VAULT_DIAL_VERBS, _VAULT_LABEL)

    def _watch_email_sender(self, sender: object) -> object:
        return self._watch_instance(sender, _EMAIL_DIAL_VERBS, _EMAIL_LABEL)

    def _watch_instance(self, obj: object, verbs: tuple[str, ...], prefix: str) -> object:
        """Wrap ``obj``'s dialling methods, per instance where that is possible.

        ``setattr`` on the instance rather than a wrapping proxy, because dozens
        of call sites assert ``isinstance`` on the object this returns and a
        proxy would break every one of them.

        A slotted class takes no per-instance attribute, and that is not a
        hypothetical: the recording email sender this suite injects everywhere is
        a ``dataclass(slots=True)``, so the email row would have recorded nothing
        at all and passed as clean. Such an object is instrumented on its class
        instead -- which keeps ``isinstance`` intact, since the class itself is
        unchanged -- and the class method is put back at uninstall.
        """
        for verb in verbs:
            bound = getattr(obj, verb, None)
            if bound is None or not callable(bound):
                continue
            if getattr(bound, _BOUNDARY_MARKER, None) is not None:
                continue
            label = f"{prefix}.{verb}"
            wrapper = self._dial_wrapper(bound, label)
            setattr(wrapper, _BOUNDARY_MARKER, bound)
            try:
                setattr(obj, verb, wrapper)
            except (AttributeError, TypeError):
                self._watch_class(type(obj), verb, label)
        return obj

    def _watch_class(self, owner: type, verb: str, label: str) -> None:
        """Instrument one dialling method on a class, reversibly."""
        function = getattr(owner, verb, None)
        if function is None or not callable(function):  # pragma: no cover - defensive
            self.uninstrumentable.append(label)
            return
        wrapper = self._dial_wrapper(function, label)
        setattr(wrapper, _BOUNDARY_MARKER, function)
        self._patched_classes.append((owner, verb, owner.__dict__.get(verb, _INHERITED)))
        setattr(owner, verb, wrapper)

    def _restore_classes(self) -> None:
        for owner, verb, original in reversed(self._patched_classes):
            if original is _INHERITED:
                delattr(owner, verb)
            else:
                setattr(owner, verb, original)
        self._patched_classes.clear()

    # -- provider overrides -----------------------------------------------

    def wrap_provider(self, key: object, provider: Callable[..., object]) -> Callable[..., object]:
        """Return a provider that reports the object it yields, or the original."""
        handler = self._provider_handlers.get(key)
        if handler is None:
            return provider
        original = cast("Callable[..., object]", _unwrap(provider))
        wrapper = _provider_wrapper(original, handler)
        setattr(wrapper, _BOUNDARY_MARKER, original)
        return wrapper

    # -- lifecycle --------------------------------------------------------

    def install(self) -> None:
        """Register the listeners, install the module guards, and take the overrides.

        Raises:
            OutboundBoundaryNotInstalledError: If another observer is already
                installed. The module guard table is process-wide, so a nested
                install would silently strand the outer observer's wrappers.
        """
        if _GUARDS:
            raise OutboundBoundaryNotInstalledError("an observer is already installed")
        event.listen(Session, "after_begin", self._after_begin)
        event.listen(Session, "after_transaction_end", self._after_transaction_end)
        self._listening = True
        self._install_module_guards()
        self._install_overrides()

    def uninstall(self) -> None:
        """Undo everything :meth:`install` did, in reverse."""
        self._uninstall_overrides()
        self._restore_classes()
        self._uninstall_module_guards()
        if self._listening:
            event.remove(Session, "after_transaction_end", self._after_transaction_end)
            event.remove(Session, "after_begin", self._after_begin)
            self._listening = False
        self._live.clear()
        self._detached = True
        _REQUEST_SESSION.set(None)

    def _install_module_guards(self) -> None:
        for module_name, specs in _BINDING_SITES.items():
            module = sys.modules[module_name]
            originals = {name: _unwrap(vars(module)[name]) for name in specs}
            self._patched.append((module, type(module), originals))
            _GUARDS[module_name] = _Guard(observer=self, specs=specs)
            module.__class__ = _WatchedModule
            for name, value in originals.items():
                setattr(module, name, value)

    def _uninstall_module_guards(self) -> None:
        for module, original_class, originals in reversed(self._patched):
            _GUARDS.pop(module.__name__, None)
            module.__class__ = original_class
            for name, value in originals.items():
                setattr(module, name, value)
        self._patched.clear()

    def _install_overrides(self) -> None:
        original = self._app.dependency_overrides
        self._original_overrides = original
        self._app.dependency_overrides = _InstrumentingOverrides(self, original)

    def _uninstall_overrides(self) -> None:
        original = self._original_overrides
        if original is None:
            return
        current = dict(self._app.dependency_overrides)
        original.clear()
        for key, value in current.items():
            original[key] = cast("Callable[..., object]", _unwrap(value))
        self._app.dependency_overrides = original
        self._original_overrides = None


class _InstrumentingOverrides(dict[Callable[..., object], Callable[..., object]]):
    """The ``dependency_overrides`` mapping, instrumenting what is registered in it.

    A ``dict`` subclass rather than a wrapper object, because the client fixture
    calls ``.clear()`` and asserts the mapping is falsy at teardown, and other
    fixtures ``.pop()`` a single key -- all of which a subclass satisfies
    unchanged.
    """

    def __init__(
        self,
        observer: OutboundBoundaryObserver,
        initial: Mapping[Callable[..., object], Callable[..., object]],
    ) -> None:
        super().__init__()
        self._observer = observer
        for key, value in initial.items():
            self[key] = value

    def __setitem__(self, key: Callable[..., object], value: Callable[..., object]) -> None:
        """Instrument a registered provider on its way in."""
        super().__setitem__(key, self._observer.wrap_provider(key, value))


def _provider_wrapper(
    provider: Callable[..., object], handler: Callable[[object], object]
) -> Callable[..., object]:
    """Return a provider of the same kind that reports the object it produces.

    FastAPI decides how to call a provider by introspecting it -- async
    generator, sync generator, coroutine function, or plain callable -- and
    builds its dependant from ``inspect.signature``. So the wrapper preserves
    the kind and carries the original's signature, with string annotations
    already evaluated in the *provider's* module rather than left for FastAPI to
    resolve against this one's.
    """
    wrapper = _wrapper_of_matching_kind(provider, handler)
    with contextlib.suppress(TypeError, ValueError, NameError):
        setattr(wrapper, _SIGNATURE_ATTR, inspect.signature(provider, eval_str=True))
    return wrapper


def _wrapper_of_matching_kind(
    provider: Callable[..., object], handler: Callable[[object], object]
) -> Callable[..., object]:
    if inspect.isasyncgenfunction(provider):
        async_gen = cast("Callable[..., AsyncGenerator[object, None]]", provider)

        async def provide_async_iter(*args: object, **kwargs: object) -> AsyncIterator[object]:
            iterator = async_gen(*args, **kwargs)
            async with contextlib.aclosing(iterator):
                async for value in iterator:
                    handler(value)
                    yield value

        return provide_async_iter

    if inspect.isgeneratorfunction(provider):
        sync_gen = cast("Callable[..., Generator[object, None, None]]", provider)

        def provide_iter(*args: object, **kwargs: object) -> Iterator[object]:
            with contextlib.closing(sync_gen(*args, **kwargs)) as iterator:
                for value in iterator:
                    handler(value)
                    yield value

        return provide_iter

    if _is_async_callable(provider):
        awaitable_call = cast("Callable[..., Awaitable[object]]", provider)

        async def provide_async(*args: object, **kwargs: object) -> object:
            value = await awaitable_call(*args, **kwargs)
            handler(value)
            return value

        return provide_async

    def provide(*args: object, **kwargs: object) -> object:
        value = provider(*args, **kwargs)
        handler(value)
        return value

    return provide


def _sweep_binding_sites() -> dict[str, dict[str, _LeafSpec]]:
    """Map every source module to the registry names it binds, found by identity.

    Identity, not spelling: an aliased import binds a new name in a new module
    and a matcher on the call site walks past it, while ``value is origin``
    cannot be walked past because the alias and the original are one object.

    Swept **once, at import**, and never again -- which is the correction that
    makes it work at all. An identity sweep sees only bindings still holding the
    real object, so any name a fixture has already substituted is invisible to
    it: the suite's autouse licence-gate stub replaces the binding in the auth
    router before any test body runs, and a sweep at install time would conclude
    that router does not reach the licensing leaf. At import, before a single
    fixture has run, every binding is still pristine.

    Raises:
        OutboundBoundaryNotInstalledError: If any registry leaf has no binding site,
            which means the registry has drifted from the code and the observer
            would report clean forever.
    """
    # The application, so the sweep reads the whole tree rather than the handful
    # of modules this one happens to import. Loud by construction: a tree that
    # failed to load leaves a registry leaf with no binding site, which raises.
    importlib.import_module("main")
    origins: list[tuple[object, _LeafSpec]] = [
        *(
            (_origin(module_name, attr), _LeafSpec(f"{module_name}.{attr}", "dial"))
            for module_name, attr in _DIAL_LEAVES
        ),
        *(
            (_origin(module_name, attr), _LeafSpec(f"{module_name}.{attr}", "vault_factory"))
            for module_name, attr in _CLIENT_FACTORIES
        ),
    ]
    guards: dict[str, dict[str, _LeafSpec]] = {}
    seen: set[str] = set()
    for module in _source_modules():
        for name, value in list(vars(module).items()):
            for origin, spec in origins:
                if value is origin:
                    guards.setdefault(module.__name__, {})[name] = spec
                    seen.add(spec.label)
    missing = sorted({spec.label for _origin_obj, spec in origins} - seen)
    if missing:
        raise OutboundBoundaryNotInstalledError(f"no binding site found for {missing}")
    return guards


def _origin(module_name: str, attr: str) -> object:
    return getattr(importlib.import_module(module_name), attr)


# The binding map, frozen at import for the reason ``_sweep_binding_sites``
# gives. Every observer installed in this process reuses it.
_BINDING_SITES: Final = _sweep_binding_sites()


@contextlib.contextmanager
def observe_outbound_boundaries(app: FastAPI) -> Iterator[OutboundBoundaryObserver]:
    """Install the observer around a block, and take it back off afterwards."""
    observer = OutboundBoundaryObserver(app)
    try:
        observer.install()
        yield observer
    finally:
        observer.uninstall()
