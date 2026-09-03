"""Hermetic tests for the analyser itself, on source trees written for the purpose.

Every fixture here is a handful of files under ``tmp_path``. Nothing in this
file reads the real ``src`` tree, and nothing in it can rot as that tree moves:
these tests are about whether the analyser can *see*, and the tree it is pointed
at in production is asserted separately, in
``test_connection_not_held_across_dial.py``.

The separation matters because the two files fail for different reasons. A
failure here means the instrument is broken. A failure there means the codebase
moved. Reading one message and diagnosing the other is how a gate gets deleted.
"""

from __future__ import annotations

from pathlib import Path

from tests.architecture.pool_hold import analyse_tree
from tests.architecture.pool_hold_census import (
    CensusRow,
    Verdict,
    evidence_problems,
    runtime_tests,
)

# The runtime census carries one test per row plus the helpers around them; a
# read that finds fewer than this found the wrong file or parsed nothing.
_FEWEST_RUNTIME_ROWS = 9

# Marker shapes kept as real modules, because the validator's job is to read a
# file the way pytest would and a string fixture would not exercise that.
_MARKED_FIXTURES = Path(__file__).resolve().parent / "marked_fixtures"


def _write(root: Path, name: str, body: str) -> None:
    """Write one module of a fixture source tree."""
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body.lstrip("\n"), encoding="utf-8")


def test_a_dial_reached_through_an_aliased_import_is_still_seen(tmp_path: Path) -> None:
    """An import alias must not hide the call it renames.

    This is the exact shape that walks past a matcher comparing the spelling at
    the call site: the caller never writes the callee's real name anywhere near
    the call, so exact-equality on ``ast.Name.id`` reports nothing. Resolving the
    root of the callee expression through the module's own import table instead
    makes the alias irrelevant -- ``_dial`` and ``dial`` resolve to one qualified
    name, because they name one function.

    The fixture is two modules rather than one so the alias has somewhere to come
    from, and the dial is an HTTP verb on a transport object rather than a name
    the analyser could match textually.
    """
    _write(
        tmp_path,
        "seam.py",
        """
import httpx


async def dial() -> None:
    async with httpx.AsyncClient() as client:
        await client.post("https://example.invalid/")
""",
    )
    _write(
        tmp_path,
        "caller.py",
        """
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from seam import dial as _dial


async def handler(session: AsyncSession) -> None:
    await session.execute(select(1))
    await _dial()
""",
    )

    analysis = analyse_tree(tmp_path)

    held = analysis.dials_held_open("caller.handler")

    assert [(site.holder, site.dial) for site in held] == [("seam.dial", "client.post")]


def test_a_transaction_opened_only_by_session_get_is_seen(tmp_path: Path) -> None:
    """``session.get`` autobegins, so a handler whose only query is one is not clean.

    Leaving ``get`` out of the opener list is the tempting mistake, because
    ``get`` is also how one reads a dictionary. The receiver's annotation is what
    tells the two apart, and the sibling test below holds the other side of it.
    """
    _write(
        tmp_path,
        "handler.py",
        """
import httpx
from sqlalchemy.ext.asyncio import AsyncSession


async def only_a_get(session: AsyncSession, user_id: int) -> None:
    await session.get(dict, user_id)
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    held = analyse_tree(tmp_path).dials_held_open("handler.only_a_get")

    assert [site.dial for site in held] == ["client.get"]


def test_a_get_on_something_that_is_not_a_session_opens_nothing(tmp_path: Path) -> None:
    """Reading a mapping is not a query, and must not be mistaken for one.

    This is the cost of admitting ``get`` as an opener, and the reason the
    receiver has to be resolved rather than matched by name: without it the
    analyser would flag every handler that reads a dictionary before it dials,
    and a gate that cries wolf gets deleted rather than fixed.
    """
    _write(
        tmp_path,
        "handler.py",
        """
import httpx


async def reads_a_mapping(settings: dict[str, str]) -> None:
    settings.get("timeout")
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    assert analyse_tree(tmp_path).dials_held_open("handler.reads_a_mapping") == ()


def test_a_session_hiding_behind_a_local_type_alias_is_still_a_session(tmp_path: Path) -> None:
    """A project-local alias of the session type must not blind the analysis.

    ``Db = AsyncSession`` is an ordinary and reasonable thing to write. Matching
    the annotation's spelling would make every handler in the module that used it
    read clean at once -- a single line silencing a whole file, with nothing in
    the diff that looks like a suppression.
    """
    _write(
        tmp_path,
        "aliases.py",
        """
from sqlalchemy.ext.asyncio import AsyncSession

Db = AsyncSession
""",
    )
    _write(
        tmp_path,
        "handler.py",
        """
import httpx
from sqlalchemy import select

from aliases import Db


async def handler(session: Db) -> None:
    await session.execute(select(1))
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    held = analyse_tree(tmp_path).dials_held_open("handler.handler")

    assert [site.dial for site in held] == ["client.get"]


def test_a_release_in_front_of_the_dial_is_believed(tmp_path: Path) -> None:
    """The fix must read as fixed, or the gate is red at every site and worth nothing."""
    _write(
        tmp_path,
        "handler.py",
        """
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def handler(session: AsyncSession) -> None:
    await session.execute(select(1))
    await session.commit()
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    assert analyse_tree(tmp_path).dials_held_open("handler.handler") == ()


def test_an_early_return_carries_its_open_transaction_out_with_it(tmp_path: Path) -> None:
    """A branch that returns before the release leaves the transaction open for its caller.

    This is the shape that made a resolver with two exits release down only one
    of them, and it is invisible to any analysis that tracks a single state per
    function: the second exit's caller inherits an open transaction the first
    exit's caller does not. Joining a returned path as merely clean is how the
    whole branch reads healthy.
    """
    _write(
        tmp_path,
        "resolver.py",
        """
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def resolve(session: AsyncSession, wanted: int) -> str:
    row = await session.execute(select(wanted))
    if row is None:
        return "deployment-wide"
    await session.commit()
    return "personal"


async def handler(session: AsyncSession) -> None:
    await resolve(session, 1)
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    held = analyse_tree(tmp_path).dials_held_open("resolver.handler")

    assert [site.dial for site in held] == ["client.get"]


def test_a_dependency_opens_the_transaction_before_the_handler_body(tmp_path: Path) -> None:
    """A handler is never entered clean, and its dependencies are why.

    Every authenticated route in this application runs a token-revocation query
    in a dependency the handler never mentions. An analysis that starts the
    handler body clean would report the whole application healthy.
    """
    _write(
        tmp_path,
        "api.py",
        """
import httpx
from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Annotated


async def current_user(session: AsyncSession) -> int:
    await session.execute(select(1))
    return 1


async def handler(who: Annotated[int, Depends(current_user)]) -> None:
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    held = analyse_tree(tmp_path).dials_held_open("api.handler")

    assert [site.dial for site in held] == ["client.get"]


def test_a_dial_handed_to_a_thread_is_resolved_rather_than_guessed(tmp_path: Path) -> None:
    """``asyncio.to_thread`` is a trampoline, and what it runs decides whether it dials.

    Treating the trampoline itself as a leaf reports a password hash and a
    blocking socket send identically, and only one of the two is worth a pooled
    connection.
    """
    _write(
        tmp_path,
        "worker.py",
        """
import asyncio
import smtplib
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


def _hash_it(secret: str) -> str:
    return secret[::-1]


def _post_it(body: str) -> None:
    smtplib.SMTP("localhost").sendmail("a", "b", body)


async def hashes(session: AsyncSession) -> None:
    await session.execute(select(1))
    await asyncio.to_thread(_hash_it, "secret")


async def sends(session: AsyncSession) -> None:
    await session.execute(select(1))
    await asyncio.to_thread(_post_it, "body")
""",
    )

    analysis = analyse_tree(tmp_path)

    assert analysis.dials_held_open("worker.hashes") == ()
    assert [site.dial for site in analysis.dials_held_open("worker.sends")] == ["smtplib.SMTP"]


def test_the_route_a_handler_serves_carries_its_router_prefix(tmp_path: Path) -> None:
    """A route is keyed by the path the application serves, prefix included."""
    _write(
        tmp_path,
        "api.py",
        """
from fastapi import APIRouter

router = APIRouter(prefix="/journal", tags=["journal"])


@router.post("/{entry_id}/resonance")
async def run_resonance(entry_id: int) -> None:
    return None
""",
    )

    routes = analyse_tree(tmp_path).route_handlers()

    assert [(entry.route, entry.handler) for entry in routes] == [
        ("POST /journal/{entry_id}/resonance", "api.run_resonance")
    ]


def _row(
    verdict: Verdict = Verdict.KNOWN,
    reason: str = "a reason",
    costs: str = "",
    observed_by: str = "",
) -> CensusRow:
    """Build a census row for the evidence checker to judge."""
    return CensusRow(
        route="GET /somewhere",
        holder="services.thing.dial_it",
        dial="handshake",
        verdict=verdict,
        reason=reason,
        costs=costs,
        observed_by=observed_by,
    )


def test_a_row_that_claims_the_analyser_is_wrong_must_name_a_test_that_passes() -> None:
    """The escape hatch opens for a green assertion, and for nothing else.

    A static analysis will eventually be wrong about a genuinely safe site, and a
    gate with no way to say so gets deleted rather than corrected. So there is a
    way to say so -- and it costs a runtime test at the same dial, carrying no
    expected-failure marker, which is a thing the checker can verify rather than
    a paragraph it has to take on trust.
    """
    row = _row(verdict=Verdict.MISMODELLED, observed_by="test_it_releases_first")

    assert evidence_problems((row,), {"test_it_releases_first": False}) == []


def test_a_row_that_claims_the_analyser_is_wrong_and_names_nothing_is_refused() -> None:
    """Prose does not buy an exemption; that is the whole point of having one rule."""
    row = _row(verdict=Verdict.MISMODELLED, reason="it is fine, honestly")

    problems = evidence_problems((row,), {})

    assert len(problems) == 1
    assert "no runtime test proving the release" in problems[0]


def test_a_row_backed_only_by_an_expected_failure_is_refused() -> None:
    """A test marked expected-to-fail proves the opposite of what such a row claims.

    This is the shape the rule exists to catch, because it is the shape that
    would otherwise pass: the row names a real test, at the right dial, that
    genuinely runs -- and the marker on it says the connection *is* held. Checking
    only that the test exists would accept it.
    """
    row = _row(verdict=Verdict.MISMODELLED, observed_by="test_it_releases_first")

    problems = evidence_problems((row,), {"test_it_releases_first": True})

    assert len(problems) == 1
    assert "proves the opposite or nothing" in problems[0]


def test_a_row_naming_a_test_that_does_not_exist_is_refused() -> None:
    """An evidence column that can name anything records nothing."""
    row = _row(observed_by="test_that_was_renamed_last_month")

    problems = evidence_problems((row,), {"test_something_else": False})

    assert len(problems) == 1
    assert "does not exist" in problems[0]


def test_a_deliberate_hold_must_name_what_it_costs_as_well_as_what_it_buys() -> None:
    """An exemption naming only its benefit is an argument with one side.

    Every hold in the census can be justified by whoever wrote it; that is why
    they are all still there. Requiring the cost in its own field means the
    trade has to be written out before it can be accepted, and read by whoever
    inherits it.
    """
    row = _row(verdict=Verdict.ALLOWED, reason="the rollback keeps a failed pass free")

    problems = evidence_problems((row,), {})

    assert len(problems) == 1
    assert "naming what the hold costs" in problems[0]


def test_the_runtime_census_is_read_from_the_file_rather_than_imported() -> None:
    """The evidence check must not need the runtime suite to be importable.

    Reading the names out of the source means the question 'does this test exist,
    and is it expected to fail' can be answered when the module it lives in
    cannot be collected -- which is exactly the moment somebody would otherwise
    reach for deleting the check.
    """
    found = runtime_tests()

    assert len(found) >= _FEWEST_RUNTIME_ROWS
    assert found["test_the_essay_llm_is_dialled_off_the_pool"] is True
    assert found["test_the_deployment_wide_vault_wheel_is_dialled_off_the_pool"] is False


def test_a_loop_that_breaks_before_its_release_carries_the_transaction_out(tmp_path: Path) -> None:
    """A ``break`` leaves the loop, not the function, and takes its state with it.

    Folding it as though it ended the function loses the state entirely: the
    branch that broke contributes nothing, the arm that reached the release
    contributes everything, and the code after the loop is read as though the
    iteration that abandoned early had finished. The connection is genuinely
    still checked out on that path.
    """
    _write(
        tmp_path,
        "handler.py",
        """
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def handler(session: AsyncSession, items: list[str]) -> None:
    for item in items:
        await session.execute(select(item))
        if item == "stop":
            break
        await session.commit()
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    held = analyse_tree(tmp_path).dials_held_open("handler.handler")

    assert [site.dial for site in held] == ["client.get"]


def test_a_loop_that_continues_past_its_release_carries_the_transaction_round(
    tmp_path: Path,
) -> None:
    """A ``continue`` skips the rest of the iteration, including the release in it.

    The same loss as ``break`` and one step further out of sight, because the
    loop does finish: an author reading the body sees a commit on every pass and
    the analysis agrees with them, when the last pass may have jumped over it.
    """
    _write(
        tmp_path,
        "handler.py",
        """
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def handler(session: AsyncSession, items: list[str]) -> None:
    for item in items:
        await session.execute(select(item))
        if item == "skip":
            continue
        await session.commit()
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    held = analyse_tree(tmp_path).dials_held_open("handler.handler")

    assert [site.dial for site in held] == ["client.get"]


def test_a_loop_that_releases_down_every_way_out_is_believed(tmp_path: Path) -> None:
    """Collecting the escaping states must not invent a hold that is not there.

    Joining more paths can only move a state toward open, so the correction above
    is exactly the kind that buys false positives if it is written carelessly.
    A loop that commits before it breaks is clear, and has to read as clear.
    """
    _write(
        tmp_path,
        "handler.py",
        """
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def handler(session: AsyncSession, items: list[str]) -> None:
    for item in items:
        await session.execute(select(item))
        if item == "stop":
            await session.commit()
            break
        await session.commit()
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    assert analyse_tree(tmp_path).dials_held_open("handler.handler") == ()


def test_a_finally_is_read_even_when_the_try_body_returns_down_every_path(
    tmp_path: Path,
) -> None:
    """``finally`` runs on every way out, so it must be walked on every way out.

    This is not a wrong state but a skipped subtree. When the body and every
    handler end in a ``return`` or a ``raise``, the state falling out of them is
    dead -- and a walk that folds the ``finally`` from that state stops at its
    first line and never visits it. A dial written there, reached with the
    transaction the body opened and never released, is invisible: the strongest
    possible form of the silence this whole package exists to break.
    """
    _write(
        tmp_path,
        "handler.py",
        """
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def handler(session: AsyncSession) -> None:
    try:
        await session.execute(select(1))
        return
    finally:
        async with httpx.AsyncClient() as client:
            await client.get("https://example.invalid/")
""",
    )

    held = analyse_tree(tmp_path).dials_held_open("handler.handler")

    assert [site.dial for site in held] == ["client.get"]


def test_a_try_that_releases_down_every_arm_leaves_the_code_after_it_clear(
    tmp_path: Path,
) -> None:
    """Entering the ``finally`` pessimistically must not make the code after it pessimistic.

    An exception can be raised anywhere in a ``try`` body, so the ``finally`` is
    entered at the join of every state control could arrive in -- but the
    statement is *left* by whichever arm survived. Conflating the two would
    report a handler that commits down both arms as still holding, and a gate
    that flags a correct release is a gate somebody deletes.
    """
    _write(
        tmp_path,
        "handler.py",
        """
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def handler(session: AsyncSession) -> None:
    await session.execute(select(1))
    try:
        await session.commit()
    except ValueError:
        await session.rollback()
    finally:
        pass
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    assert analyse_tree(tmp_path).dials_held_open("handler.handler") == ()


def test_a_name_lookup_on_the_event_loop_is_a_dial(tmp_path: Path) -> None:
    """DNS is a network round trip, and it is spelled as a method on the loop.

    ``socket.getaddrinfo`` as a qualified name is not how this application asks:
    it awaits ``loop.getaddrinfo``, on an object no import graph names. Missing
    it is what made the vault-resolution row unfalsifiable -- the one census row
    written about a lookup that costs a connection, asserting a release the
    analysis could not have noticed the absence of.
    """
    _write(
        tmp_path,
        "resolve.py",
        """
import asyncio
import socket
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def handler(session: AsyncSession, host: str) -> object:
    await session.execute(select(1))
    loop = asyncio.get_running_loop()
    return await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
""",
    )

    held = analyse_tree(tmp_path).dials_held_open("resolve.handler")

    assert [site.dial for site in held] == ["getaddrinfo"]


def test_a_session_reached_through_an_attribute_is_still_a_session(tmp_path: Path) -> None:
    """A session carried on a context object opens a transaction like any other.

    Requiring the receiver to be a bare parameter name reads ``ctx.session.execute``
    as a call on something unknown -- neither opener nor releaser -- and this
    repository already writes that shape.
    """
    _write(
        tmp_path,
        "handler.py",
        """
import httpx
from dataclasses import dataclass
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class Context:
    session: AsyncSession


async def handler(context: Context) -> None:
    await context.session.execute(select(1))
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    held = analyse_tree(tmp_path).dials_held_open("handler.handler")

    assert [site.dial for site in held] == ["client.get"]


def test_a_release_through_an_attribute_chain_is_believed(tmp_path: Path) -> None:
    """The same shape on the releasing side, which is the false-positive direction.

    A missed opener hides a defect; a missed *release* invents one. Both follow
    from the same omission, and the second is the one that gets a gate deleted.
    """
    _write(
        tmp_path,
        "handler.py",
        """
import httpx
from dataclasses import dataclass
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class Context:
    session: AsyncSession


async def handler(context: Context) -> None:
    await context.session.execute(select(1))
    await context.session.commit()
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    assert analyse_tree(tmp_path).dials_held_open("handler.handler") == ()


def test_a_session_behind_an_annotated_alias_is_still_a_session(tmp_path: Path) -> None:
    """A dependency alias is a subscript, and a subscript is still a name for a type.

    ``SessionDep = Annotated[AsyncSession, Depends(get_session)]`` is the tidy
    spelling of the annotation every handler in this application writes out in
    full. Resolving only bare names would make adopting it silence the whole
    file, and the resulting green is indistinguishable from a fix.
    """
    _write(
        tmp_path,
        "deps.py",
        """
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession


async def get_session() -> AsyncSession: ...


SessionDep = Annotated[AsyncSession, Depends(get_session)]
""",
    )
    _write(
        tmp_path,
        "handler.py",
        """
import httpx
from sqlalchemy import select

from deps import SessionDep


async def handler(session: SessionDep) -> None:
    await session.execute(select(1))
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    held = analyse_tree(tmp_path).dials_held_open("handler.handler")

    assert [site.dial for site in held] == ["client.get"]


def test_match_arms_are_joined_rather_than_folded_one_after_another(tmp_path: Path) -> None:
    """One arm's release must not pay for another arm's dial.

    A ``match`` is a branch, and folding its cases in sequence lets the commit in
    the first case set the state the last case is read in -- the same defect as
    treating a ``break`` as a function exit, in the newer syntax.
    """
    _write(
        tmp_path,
        "handler.py",
        """
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def handler(session: AsyncSession, kind: str) -> None:
    await session.execute(select(1))
    match kind:
        case "settled":
            await session.commit()
        case _:
            pass
    async with httpx.AsyncClient() as client:
        await client.get("https://example.invalid/")
""",
    )

    held = analyse_tree(tmp_path).dials_held_open("handler.handler")

    assert [site.dial for site in held] == ["client.get"]


def test_a_jwks_fetch_behind_a_thread_is_a_dial(tmp_path: Path) -> None:
    """Fetching a provider's signing keys is a provider round trip, not a local check.

    ``get_signing_key_from_jwt`` reads like verifying a signature and, on a cache
    miss, fetches the JWKS document over HTTPS. It is reached here through a
    thread trampoline, on a receiver injected as a protocol -- so it is a dial
    the analysis can only know about because the verb is declared to be one.
    """
    _write(
        tmp_path,
        "verify.py",
        """
import asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def handler(session: AsyncSession, keys: object, token: str) -> object:
    await session.execute(select(1))
    return await asyncio.to_thread(keys.get_signing_key_from_jwt, token)
""",
    )

    held = analyse_tree(tmp_path).dials_held_open("verify.handler")

    assert [site.dial for site in held] == ["get_signing_key_from_jwt"]


def test_a_dial_behind_a_callable_parameter_is_not_seen(tmp_path: Path) -> None:
    """The named blind spot, asserted rather than described.

    A callee chosen by the caller and awaited by name inside the callee is not in
    any import graph, and this is the shape the OAuth routes use to share one
    refusal between two providers: the identity verifier is passed in, so the
    JWKS fetch at the end of it is invisible even though the verb is modelled.

    Written as a test so the limit is checked rather than claimed, and so the day
    it is closed this file says so by failing.
    """
    _write(
        tmp_path,
        "indirect.py",
        """
import asyncio
from collections.abc import Callable
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def _fetch(keys: object, token: str) -> object:
    return await asyncio.to_thread(keys.get_signing_key_from_jwt, token)


async def handler(session: AsyncSession, verifier: Callable[..., object], token: str) -> object:
    await session.execute(select(1))
    return await verifier(token)
""",
    )

    assert analyse_tree(tmp_path).dials_held_open("indirect.handler") == ()


def test_a_module_scope_marker_is_seen_as_an_expected_failure() -> None:
    """A mark applied to the whole module marks every test in it.

    Reading only a function's own decorators means one ``pytestmark`` line at the
    top of the runtime census turns every row's evidence from expected-red into
    apparently-green, and every exemption in this file becomes purchasable with
    it. The hatch's entire guarantee is that a marker proves the opposite of the
    row's claim, so the marker has to be found wherever pytest would find it.
    """
    module = _MARKED_FIXTURES / "module_scope_xfail.py"

    assert runtime_tests(module) == {"test_it_releases_first": True}


def test_a_disabled_test_cannot_prove_that_a_site_releases() -> None:
    """A skipped test does not run, so it asserts nothing about anything.

    ``xfail`` at least executes. ``skip`` and ``skipif`` do not, and accepting
    either as evidence would let a row claim the analysis is wrong on the
    strength of a test nobody has run since it was written.
    """
    module = _MARKED_FIXTURES / "skipped.py"

    assert runtime_tests(module) == {"test_skipped": True, "test_conditionally_skipped": True}


def test_a_mismodelled_row_may_not_borrow_another_rows_evidence() -> None:
    """One green test cannot vouch for a second, different dial.

    Naming any unmarked test in the file would let a row about the invitation
    handshake be excused by a test about the deployment vault's wheel. Requiring
    the evidence to be this row's alone does not prove the test is about the
    right dial -- nothing cheap does -- but it stops the copy-and-paste that
    makes the field meaningless.
    """
    borrowed = "test_the_essay_llm_is_dialled_off_the_pool"
    rows = (
        _row(verdict=Verdict.KNOWN, observed_by=borrowed),
        _row(verdict=Verdict.MISMODELLED, observed_by=borrowed),
    )

    problems = evidence_problems(rows, {borrowed: False})

    assert len(problems) == 1
    assert "already the evidence for another row" in problems[0]
