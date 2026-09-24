"""The private beta feedback contract: what it accepts, refuses, and returns.

The interesting assertions here are the negative ones. A feedback endpoint is
the most inviting place in an application to put a log bundle, and every one of
the shapes the issue forbids -- a URL carrying a query string, a stack trace, a
value past its bound, a whole diagnostic blob -- has to be refused *and* leave
nothing behind, because a row written before the refusal is the disclosure the
refusal was supposed to prevent.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from http import HTTPStatus
from itertools import pairwise
from statistics import mean
from typing import Any
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from main import app
from models.feedback import (
    FEEDBACK_BUILD_MAX_LENGTH,
    FEEDBACK_CONTROL_MAX_LENGTH,
    FEEDBACK_SCREEN_MAX_LENGTH,
    FEEDBACK_SUMMARY_MAX_LENGTH,
    PUBLIC_ID_ALPHABET,
    PUBLIC_ID_BODY_LENGTH,
    PUBLIC_ID_MAX_LENGTH,
    PUBLIC_ID_PATTERN,
    PUBLIC_ID_PREFIX,
    FeedbackControl,
    FeedbackReport,
    FeedbackScreen,
    mint_public_id,
)
from routers import feedback as feedback_router
from schemas.feedback import (
    ALLOWED_CONTEXT_KEYS,
    CONTROL_PATTERN,
    SCREEN_PATTERN,
    FeedbackContext,
)
from security.idempotency import IDEMPOTENCY_KEY_MAX_LENGTH
from tests.helpers.feedback_triage import make_account

_PROSE = "The habit card vanished when I tapped the offer."
_IDEMPOTENCY_HEADER = "Idempotency-Key"
_A_KEY = "beta-report-0001"  # pragma: allowlist secret
# The router's insert step, named once so the counting wrapper and its install agree.
_INSERT = "_insert_with_fresh_public_id"


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Create an account and return its auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _context(**overrides: object) -> dict[str, Any]:
    """A well-formed diagnostic envelope, with overrides applied."""
    return {
        "screen": "journal.shelf",
        "control": "shell.header.send_feedback",
        "platform": "ios",
        "app_build": "1.4.2+318",
        "viewport_class": "compact",
        "locale": "en-US",
        "correlation_id": str(uuid4()),
        **overrides,
    }


def _payload(**overrides: object) -> dict[str, Any]:
    """A well-formed report body, with overrides applied."""
    return {
        "category": "broken",
        "impact": "blocked",
        "summary": _PROSE,
        "intent": "Log today's sit.",
        "expected": "The card stays put.",
        "actual": "It disappeared.",
        "context": _context(),
        **overrides,
    }


def _leaf_strings(value: object) -> list[str]:
    """Every string a smuggling attempt carried, however deeply it was nested."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [leaf for item in value.values() for leaf in _leaf_strings(item)]
    return []


async def _report_count(session: AsyncSession) -> int:
    """How many feedback reports the database holds, read past the identity map."""
    total = await session.scalar(select(func.count()).select_from(FeedbackReport))
    return int(total or 0)


# ── Acceptance ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_well_formed_report_is_accepted_and_returns_a_public_reference(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The happy path, and the shape of what comes back."""
    headers = await _signup(async_client, "feedback_happy")

    resp = await async_client.post("/feedback/", json=_payload(), headers=headers)

    assert resp.status_code == HTTPStatus.CREATED
    body = resp.json()
    assert body["public_id"].startswith("FB-")
    assert len(body["public_id"]) == PUBLIC_ID_MAX_LENGTH
    assert body["category"] == "broken"
    assert body["impact"] == "blocked"
    assert await _report_count(db_session) == 1


@pytest.mark.asyncio
async def test_the_receipt_carries_no_prose_no_owner_and_no_triage_state(
    async_client: AsyncClient,
) -> None:
    """The receipt is a reference and a filing, not a copy of the report."""
    headers = await _signup(async_client, "feedback_receipt_shape")

    body = (await async_client.post("/feedback/", json=_payload(), headers=headers)).json()

    assert set(body) == {"public_id", "category", "impact", "created_at"}
    assert _PROSE not in json.dumps(body)


@pytest.mark.asyncio
async def test_an_unauthenticated_submission_is_refused(async_client: AsyncClient) -> None:
    """Intake is authenticated; an anonymous firehose is not a feature."""
    resp = await async_client.post("/feedback/", json=_payload())

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── R1: the envelope is an allowlist ──────────────────────────────────────


@pytest.mark.asyncio
async def test_an_unknown_diagnostic_context_key_is_rejected_and_persists_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An eighth context key is a 422, and the refusal does not echo the prose.

    The status is asserted exactly rather than as "not 2xx": a bare inequality
    passes for entirely the wrong reason while the route is simply unmounted and
    404ing. ``stack_trace`` survives in the entry's ``loc`` (which is what makes
    the rejection legible to a client) while the submitted sentence does not,
    because ``errors.sanitized_validation_entries`` rebuilds every entry without
    ``input``.
    """
    headers = await _signup(async_client, "feedback_extra_key")
    payload = _payload(context=_context(stack_trace="Traceback (most recent call last): ..."))

    resp = await async_client.post(
        "/feedback/", json=payload, headers={**headers, _IDEMPOTENCY_HEADER: _A_KEY}
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    rendered = json.dumps(resp.json())
    assert "stack_trace" in rendered
    assert _PROSE not in rendered
    assert await _report_count(db_session) == 0


@pytest.mark.asyncio
async def test_the_refusal_detail_is_the_repositorys_sanitised_entry_list(
    async_client: AsyncClient,
) -> None:
    """422 ``detail`` is a list of ``{type, loc, msg}``, never a bare string.

    Pinned because a route answering a 422 with a string would break its own
    published response schema, and because ``input``/``ctx`` are exactly the two
    keys that would carry the submitted material back out.
    """
    headers = await _signup(async_client, "feedback_detail_shape")
    payload = _payload(context=_context(vault_address="https://vault.example.com/mine"))

    detail = (await async_client.post("/feedback/", json=payload, headers=headers)).json()["detail"]

    assert isinstance(detail, list)
    for entry in detail:
        assert set(entry) == {"type", "loc", "msg"}


# ── Rejection by value, not merely by key ─────────────────────────────────


@pytest.mark.parametrize(
    ("label", "context_override"),
    [
        ("url_with_query_string", {"screen": "https://app.example.com/journal?token=abc123"}),
        ("stack_trace_as_control", {"control": 'File "main.py", line 42, in handler'}),
        # Version-shaped, so only the length bound can be what refuses it.
        ("build_past_its_bound", {"app_build": "1." + "9" * FEEDBACK_BUILD_MAX_LENGTH}),
        ("log_bundle_shaped_screen", {"screen": "2026-09-17T10:00:00Z ERROR body={...}"}),
        # Word-bearing tokens: prose disguised in the token grammar. Only a
        # closed vocabulary refuses these; a shape pattern admits every one.
        ("journal_prose_as_screen", {"screen": "journal.i_miss_my_father"}),
        ("resonance_prose_as_control", {"control": "my_dead_mother.letter"}),
        ("passage_prose_as_screen", {"screen": "course.the_self_is_a_river"}),
        ("prose_as_build", {"app_build": "Dear-diary-I-cried"}),
        ("prose_as_build_suffix", {"app_build": "1.0.0-imissyoudad"}),
        # Every other forbidden class, cast as a value of an allowlisted key.
        ("route_query_as_screen", {"screen": "journal.shelf?entry=42"}),
        ("vault_address_as_screen", {"screen": "https://vault.example.com/mine"}),
        ("authorization_as_control", {"control": "Authorization: Bearer abc.def"}),
        ("cookie_as_screen", {"screen": "Cookie: session=abc"}),
        ("header_map_string_as_control", {"control": '{"x-api-key": "k"}'}),
        ("header_map_object_as_screen", {"screen": {"authorization": "Bearer abc.def"}}),
        ("request_body_as_screen", {"screen": '{"summary": "I miss my father"}'}),
        ("response_body_as_control", {"control": '{"detail": "Not authenticated"}'}),
        ("console_log_as_screen", {"screen": "console.error: TypeError at App.tsx:12"}),
        ("stack_trace_as_build", {"app_build": 'Traceback (most recent call last): File "a.py"'}),
        ("journal_prose_as_screen_value", {"screen": "I miss my father every morning"}),
        ("resonance_prose_as_control_value", {"control": "The river keeps returning to me"}),
        ("passage_prose_as_build", {"app_build": "The self is a river"}),
        ("prose_as_locale", {"locale": "en-US I miss him"}),
        ("prose_as_correlation_id", {"correlation_id": "i-miss-my-father"}),
        ("prose_as_platform", {"platform": "my private note"}),
        ("prose_as_viewport_class", {"viewport_class": "my private note"}),
    ],
)
@pytest.mark.asyncio
async def test_an_unsafe_context_value_is_rejected_and_persists_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    label: str,
    context_override: dict[str, Any],
) -> None:
    """Each forbidden *shape* is refused even though its *key* is allowlisted.

    The allowlist alone would happily take ``screen`` set to a URL carrying a
    session token. The patterns are what make the field narrow enough that the
    forbidden shapes cannot be spelled in it at all.
    """
    headers = await _signup(async_client, f"feedback_value_{label}")
    payload = _payload(context=_context(**context_override))

    resp = await async_client.post("/feedback/", json=payload, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, label
    assert await _report_count(db_session) == 0, label
    for smuggled in _leaf_strings(context_override):
        assert smuggled not in resp.text, label


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("authorization", "Bearer abc.def"),
        ("cookie", "session=abc; theme=dark"),
        ("headers", {"x-api-key": "k-4417", "user-agent": "Mozilla/5.0 private"}),
        ("request_body", '{"summary": "I miss my father"}'),
        ("response_body", '{"detail": "Not authenticated for my letter"}'),
        ("console_log", "console.error: TypeError at App.tsx:12"),
        ("vault_address", "https://vault.example.com/mine"),
        ("stack_trace", 'Traceback (most recent call last): File "a.py"'),
        ("route_query", "entry=42&note=grief"),
        ("journal_excerpt", "I miss my father every morning"),
    ],
)
@pytest.mark.asyncio
async def test_a_forbidden_context_key_is_rejected_and_persists_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    key: str,
    value: object,
) -> None:
    """An eighth key is refused whatever it is called, and its value is not echoed.

    The key itself may appear in the refusal's ``loc`` -- that is what tells a
    client which field to drop -- but nothing it carried may.
    """
    headers = await _signup(async_client, f"feedback_key_{key}")
    payload = _payload(context=_context(**{key: value}))

    resp = await async_client.post("/feedback/", json=payload, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, key
    assert await _report_count(db_session) == 0, key
    for smuggled in _leaf_strings(value):
        assert smuggled not in resp.text, key


@pytest.mark.parametrize(
    ("vocabulary", "grammar", "bound"),
    [
        (FeedbackScreen, SCREEN_PATTERN, FEEDBACK_SCREEN_MAX_LENGTH),
        (FeedbackControl, CONTROL_PATTERN, FEEDBACK_CONTROL_MAX_LENGTH),
    ],
)
def test_every_closed_token_satisfies_its_grammar(
    vocabulary: type[FeedbackScreen] | type[FeedbackControl], grammar: str, bound: int
) -> None:
    """Each vocabulary member is spelled in the token grammar and fits its column.

    The closed set is what the request enforces; the grammar and the column
    width are what the admin filter and the database still assume. A member
    added outside either would be accepted at intake and then be unfilterable
    or truncated.
    """
    for member in vocabulary:
        assert re.fullmatch(grammar, member.value), member
        assert len(member.value) <= bound, member


@pytest.mark.asyncio
async def test_prose_past_its_bound_is_rejected_and_persists_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The account's own words are bounded too, at the named constant."""
    headers = await _signup(async_client, "feedback_long_summary")
    payload = _payload(summary="x" * (FEEDBACK_SUMMARY_MAX_LENGTH + 1))

    resp = await async_client.post("/feedback/", json=payload, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert await _report_count(db_session) == 0


@pytest.mark.asyncio
async def test_an_unknown_top_level_field_is_rejected(async_client: AsyncClient) -> None:
    """``extra="forbid"`` on the body as well: no ``logs`` key, no ``headers`` key."""
    headers = await _signup(async_client, "feedback_extra_body")
    payload = _payload()
    payload["log_bundle"] = {"lines": ["..."]}

    resp = await async_client.post("/feedback/", json=payload, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_submitted_prose_is_unicode_normalised_before_storage(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The repository's normalisation applies here like everywhere else."""
    headers = await _signup(async_client, "feedback_normalise")
    payload = _payload(summary="  Café \u200b crashed  ")

    resp = await async_client.post("/feedback/", json=payload, headers=headers)

    assert resp.status_code == HTTPStatus.CREATED
    stored = (await db_session.execute(select(FeedbackReport))).scalars().one()
    assert stored.summary == "Café  crashed"


# ── Idempotency ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_retry_under_the_same_key_returns_the_same_report(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One tap, one row — however many times the client retries it."""
    headers = {**await _signup(async_client, "feedback_replay"), _IDEMPOTENCY_HEADER: _A_KEY}

    first = await async_client.post("/feedback/", json=_payload(), headers=headers)
    second = await async_client.post(
        "/feedback/", json=_payload(summary="A different sentence."), headers=headers
    )

    assert first.status_code == HTTPStatus.CREATED
    assert second.json()["public_id"] == first.json()["public_id"]
    assert await _report_count(db_session) == 1


@pytest.mark.asyncio
async def test_a_replay_is_read_only_and_logs_no_second_submission(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A retry answers from the stored report: no insert attempt, no second event.

    The response alone cannot tell a replay from a collision recovered after an
    insert. Both return the stored reference, so the side effects are what pin
    the replay path. A retry that reached the insert would roll back a write,
    burn a sequence value, and log ``feedback_submitted`` a second time for the
    same report, double-counting anything built on that event.
    """
    headers = {**await _signup(async_client, "feedback_quiet_replay"), _IDEMPOTENCY_HEADER: _A_KEY}
    real_insert: Callable[..., Awaitable[FeedbackReport]] = getattr(feedback_router, _INSERT)
    inserts: list[object] = []

    async def _counting_insert(*args: object, **kwargs: object) -> FeedbackReport:
        inserts.append(kwargs.get("hashed"))
        return await real_insert(*args, **kwargs)

    monkeypatch.setattr(feedback_router, _INSERT, _counting_insert)

    with caplog.at_level(logging.INFO):
        first = await async_client.post("/feedback/", json=_payload(), headers=headers)
        second = await async_client.post("/feedback/", json=_payload(), headers=headers)

    assert second.json()["public_id"] == first.json()["public_id"]
    assert len(inserts) == 1
    submitted = [r for r in caplog.records if r.message == "feedback_submitted"]
    assert [r.__dict__["public_id"] for r in submitted] == [first.json()["public_id"]]
    assert await _report_count(db_session) == 1


@pytest.mark.asyncio
async def test_the_raw_idempotency_key_is_never_stored(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """What lands in the column is the digest, not the header the client sent."""
    headers = {**await _signup(async_client, "feedback_key_hashed"), _IDEMPOTENCY_HEADER: _A_KEY}

    await async_client.post("/feedback/", json=_payload(), headers=headers)

    stored = (await db_session.execute(select(FeedbackReport))).scalars().one()
    assert stored.idem_key is not None
    assert _A_KEY not in stored.idem_key


@pytest.mark.asyncio
async def test_an_idempotency_key_past_its_bound_is_rejected_and_persists_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One character over ``IDEMPOTENCY_KEY_MAX_LENGTH`` is a 422, and no row."""
    headers = {
        **await _signup(async_client, "feedback_key_too_long"),
        _IDEMPOTENCY_HEADER: "k" * (IDEMPOTENCY_KEY_MAX_LENGTH + 1),
    }

    resp = await async_client.post("/feedback/", json=_payload(), headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert await _report_count(db_session) == 0


@pytest.mark.asyncio
async def test_an_idempotency_key_at_its_bound_is_accepted_and_replays(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Exactly ``IDEMPOTENCY_KEY_MAX_LENGTH`` characters is a key, not a refusal."""
    headers = {
        **await _signup(async_client, "feedback_key_at_bound"),
        _IDEMPOTENCY_HEADER: "k" * IDEMPOTENCY_KEY_MAX_LENGTH,
    }

    first = await async_client.post("/feedback/", json=_payload(), headers=headers)
    second = await async_client.post("/feedback/", json=_payload(), headers=headers)

    assert first.status_code == HTTPStatus.CREATED
    assert second.json()["public_id"] == first.json()["public_id"]
    assert await _report_count(db_session) == 1


@pytest.mark.asyncio
async def test_two_concurrent_submissions_under_one_idempotency_key_create_one_row(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The database serialises the race, not a process-local lock.

    Two identical posts sharing one key go out together against per-request
    sessions on a file-backed engine. Exactly one row may exist afterwards and
    both callers must be handed the same reference — a second row here is a
    duplicate report in somebody's inbox and a reference that resolves to only
    half of what they sent.
    """
    headers = {
        **await _signup(concurrent_async_client, "feedback_race"),
        _IDEMPOTENCY_HEADER: _A_KEY,
    }

    first, second = await asyncio.gather(
        concurrent_async_client.post("/feedback/", json=_payload(), headers=headers),
        concurrent_async_client.post("/feedback/", json=_payload(), headers=headers),
    )

    assert first.status_code == HTTPStatus.CREATED
    assert second.status_code == HTTPStatus.CREATED
    assert first.json()["public_id"] == second.json()["public_id"]
    async with concurrent_session_factory() as session:
        assert await _report_count(session) == 1


@pytest.mark.asyncio
async def test_an_unkeyed_submission_never_returns_an_earlier_reports_receipt(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A minted reference that collides must produce a NEW row, not a replay.

    The regression this locks is subtle and silent. ``feedbackreport`` carries
    two unique constraints, and resolving an ``IntegrityError`` by re-reading
    ``(user_id, idem_key)`` is right for the keyed case and catastrophic for the
    unkeyed one: ``col(X.idem_key) == None`` compiles to ``idem_key IS NULL``,
    which matches this caller's *earlier* unkeyed reports. The second report
    would be discarded and the person handed a receipt for something they wrote
    weeks ago, with a 201 and no error anywhere.

    The mint is forced to collide so the recovery branch is the one under test.
    """
    headers = await _signup(async_client, "feedback_unkeyed_collision")
    first = await async_client.post("/feedback/", json=_payload(), headers=headers)
    assert first.status_code == HTTPStatus.CREATED
    taken = first.json()["public_id"]

    minted = [taken, "FB-ZZZZZZZZ"]
    monkeypatch.setattr("routers.feedback.mint_public_id", lambda: minted.pop(0))

    second = await async_client.post(
        "/feedback/", json=_payload(summary="A wholly different report."), headers=headers
    )

    assert second.status_code == HTTPStatus.CREATED
    assert second.json()["public_id"] != taken
    assert await _report_count(db_session) == 2
    fresh = (
        (
            await db_session.execute(
                select(FeedbackReport).where(
                    col(FeedbackReport.public_id) == second.json()["public_id"]
                )
            )
        )
        .scalars()
        .one()
    )
    assert fresh.summary == "A wholly different report."


# ── Receipt lookup is owner-scoped ────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_owner_can_read_their_own_receipt(async_client: AsyncClient) -> None:
    """The reference resolves for the account that filed it."""
    headers = await _signup(async_client, "feedback_owner_read")
    public_id = (await async_client.post("/feedback/", json=_payload(), headers=headers)).json()[
        "public_id"
    ]

    resp = await async_client.get(f"/feedback/{public_id}/receipt", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["public_id"] == public_id


@pytest.mark.asyncio
async def test_another_accounts_reference_is_indistinguishable_from_a_missing_one(
    async_client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    """Byte-identical refusals, and an audit row on the cross-tenant probe.

    The reference is the only handle on the resource, so answering 403 for a
    real one would confirm that a guessed reference exists. The distinction the
    403 normally preserves is kept where it belongs -- in the log.
    """
    alice = await _signup(async_client, "feedback_alice")
    bob = await _signup(async_client, "feedback_bob")
    public_id = (await async_client.post("/feedback/", json=_payload(), headers=alice)).json()[
        "public_id"
    ]

    with caplog.at_level(logging.WARNING):
        cross = await async_client.get(f"/feedback/{public_id}/receipt", headers=bob)
    missing = await async_client.get("/feedback/FB-22222222/receipt", headers=bob)

    assert cross.status_code == missing.status_code == HTTPStatus.NOT_FOUND
    assert cross.json()["detail"] == missing.json()["detail"] == "feedback_report_not_found"
    assert cross.content == missing.content
    assert any(record.message == "resource_access_denied" for record in caplog.records)


@pytest.mark.asyncio
async def test_a_malformed_public_reference_is_refused_by_the_path_bound(
    async_client: AsyncClient,
) -> None:
    """The path parameter is bounded by pattern and length, not merely by lookup."""
    headers = await _signup(async_client, "feedback_bad_path")

    resp = await async_client.get(f"/feedback/{'A' * 64}/receipt", headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ── The published contract ────────────────────────────────────────────────


def _components(app_schema: dict[str, Any]) -> dict[str, Any]:
    """The document's component schema table."""
    return dict(app_schema["components"]["schemas"])


@pytest.mark.asyncio
async def test_the_published_context_component_forbids_additional_properties() -> None:
    """The privacy mutation's first half: the document itself refuses an eighth key.

    ``additionalProperties: false`` is what makes a generated client, a fuzzer
    and a reviewer all see the same rule the server enforces.
    """
    context = _components(app.openapi())["FeedbackContext"]

    assert context["additionalProperties"] is False


def test_the_allowlist_constant_equals_the_models_declared_field_set() -> None:
    """The privacy mutation's second half: two independent statements agree.

    ``ALLOWED_CONTEXT_KEYS`` is spelled out literally in ``schemas.feedback``
    rather than derived from ``model_fields``. That duplication is the whole
    point: a derived constant would make this assertion
    ``set(model_fields) == set(model_fields)``, which cannot fail for any
    mutation at all. Widening one declaration without the other fails here.
    """
    assert set(FeedbackContext.model_fields) == ALLOWED_CONTEXT_KEYS


@pytest.mark.parametrize("enum_name", ["FeedbackCategory", "FeedbackImpact"])
@pytest.mark.asyncio
async def test_the_report_enums_publish_as_named_components(enum_name: str) -> None:
    """A bare ``str`` on either side would erase the closed set from the contract."""
    components = _components(app.openapi())

    assert "enum" in components[enum_name]


@pytest.mark.asyncio
async def test_both_the_request_and_the_receipt_reference_the_same_enum_components() -> None:
    """The closed set is published on the way in *and* on the way out."""
    components = _components(app.openapi())
    create = json.dumps(components["FeedbackCreate"])
    receipt = json.dumps(components["FeedbackReceipt"])

    for enum_name in ("FeedbackCategory", "FeedbackImpact"):
        ref = f"#/components/schemas/{enum_name}"
        assert ref in create, enum_name
        assert ref in receipt, enum_name


@pytest.mark.asyncio
async def test_the_idempotency_key_is_a_header_parameter_and_not_a_body_field() -> None:
    """Where the three shipped idempotent surfaces put it, feedback puts it too."""
    document = app.openapi()
    operation = document["paths"]["/feedback/"]["post"]
    headers = {
        parameter["name"]
        for parameter in operation.get("parameters", [])
        if parameter["in"] == "header"
    }

    assert _IDEMPOTENCY_HEADER in headers
    assert "idempotency_key" not in _components(document)["FeedbackCreate"]["properties"]


@pytest.mark.parametrize("status_code", ["401", "404", "422", "429"])
@pytest.mark.asyncio
async def test_every_status_the_module_can_send_is_declared(status_code: str) -> None:
    """A status a route answers with and does not declare is a contract it breaks."""
    document = app.openapi()

    assert status_code in document["paths"]["/feedback/"]["post"]["responses"]
    assert status_code in document["paths"]["/feedback/{public_id}/receipt"]["get"]["responses"]


# ── The public reference ──────────────────────────────────────────────────

# Characters a person reading a reference down a phone line, or typing one back
# in, confuses with one another. None of them may be mintable.
_AMBIGUOUS_CHARACTERS = "ILOU01"

_MINTS_SAMPLED = 200


def test_the_public_reference_alphabet_excludes_the_confusable_characters() -> None:
    """A reference gets read aloud and typed back, so the lookalikes are not minted."""
    assert not set(_AMBIGUOUS_CHARACTERS) & set(PUBLIC_ID_ALPHABET)


def test_minted_references_are_non_sequential() -> None:
    """A counter would satisfy "all distinct, all well-formed"; it must not pass here.

    The first version of this test asserted that two hundred mints were distinct
    and matched the pattern -- which a straight counter does perfectly, so it
    proved nothing about the property in its own name. Two measurements separate
    a counter from ``secrets`` by orders of magnitude rather than by a margin:

    A counter varies its *last* character and essentially never its first, so the
    number of distinct leading characters across the sample is 1 or 2. Drawing
    200 characters uniformly from a 30-symbol alphabet leaves a symbol unseen
    with probability ``(29/30) ** 200`` -- about one in nine hundred -- so the
    expected count is very nearly all thirty and a floor of half the alphabet is
    unreachable by chance.

    And consecutive counter values differ in one position; consecutive random
    values differ in about ``8 * 29/30`` of their eight. A floor at half the body
    length sits far from both.
    """
    minted = [mint_public_id() for _ in range(_MINTS_SAMPLED)]
    bodies = [reference.removeprefix(PUBLIC_ID_PREFIX) for reference in minted]

    assert len(set(minted)) == _MINTS_SAMPLED
    for reference in minted:
        assert re.fullmatch(PUBLIC_ID_PATTERN, reference), reference

    leading = {body[0] for body in bodies}
    assert len(leading) >= len(PUBLIC_ID_ALPHABET) // 2, (
        f"only {len(leading)} distinct leading characters in {_MINTS_SAMPLED} mints; "
        "a sequential mint varies its last character, not its first"
    )

    drifts = [
        sum(before != after for before, after in zip(first, second, strict=True))
        for first, second in pairwise(bodies)
    ]
    assert mean(drifts) > PUBLIC_ID_BODY_LENGTH / 2, (
        f"consecutive mints differ in {mean(drifts):.2f} of {PUBLIC_ID_BODY_LENGTH} "
        "positions on average; a sequential mint differs in about one"
    )


@pytest.mark.asyncio
async def test_a_reference_is_minted_rather_than_derived(async_client: AsyncClient) -> None:
    """Neither the account nor the words it wrote can be read back out of a reference.

    The test this replaces asserted that the caller's ``user_id`` did not appear
    as a substring of their reference -- which the alphabet guarantees on its
    own, because it excludes every digit below 2. It was true before the feature
    was written.

    Two halves, because each kills a different wrong implementation and neither
    kills both. *Same account, two different reports*: an account-derived
    reference is a constant per account, so it collides here. *Two accounts,
    byte-identical prose*: a content hash is a constant per body, so it collides
    there. A mint gives four unrelated values.
    """
    first_headers = await _signup(async_client, "feedback_minted_one")
    second_headers = await _signup(async_client, "feedback_minted_two")
    payload = _payload()

    same_account_first = await async_client.post("/feedback/", json=payload, headers=first_headers)
    same_account_second = await async_client.post(
        "/feedback/", json=_payload(summary="A wholly different sentence."), headers=first_headers
    )
    other_account = await async_client.post("/feedback/", json=payload, headers=second_headers)

    for response in (same_account_first, same_account_second, other_account):
        assert response.status_code == HTTPStatus.CREATED

    assert same_account_first.json()["public_id"] != same_account_second.json()["public_id"]
    assert same_account_first.json()["public_id"] != other_account.json()["public_id"]


@pytest.mark.asyncio
async def test_a_mint_that_always_collides_surfaces_rather_than_hanging(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The retry loop is bounded, so a database fault becomes a 500, not a hang.

    An unbounded ``while`` here would be the worst available failure: a request
    that never returns, holding a connection, under a bug that by construction
    reproduces on every retry. The bound turns it into a 500 an operator can
    see, through the application's own sanitising handler. Driven by forcing
    every mint to return a reference already taken, which is the only way the
    exhaustion branch is reachable at all.

    The refusal body is asserted too: a 500 raised from this path must not
    reproduce what the caller wrote, and the handler's sanitisation is what
    keeps that true.
    """
    headers = await _signup(async_client, "feedback_mint_exhausted")
    first = await async_client.post("/feedback/", json=_payload(), headers=headers)
    assert first.status_code == HTTPStatus.CREATED
    taken = first.json()["public_id"]

    monkeypatch.setattr("routers.feedback.mint_public_id", lambda: taken)

    exhausted = await async_client.post("/feedback/", json=_payload(), headers=headers)

    assert exhausted.status_code == HTTPStatus.INTERNAL_SERVER_ERROR
    assert _PROSE not in exhausted.text
    assert await _report_count(db_session) == 1


# ── The receipt after triage (#2900) ──────────────────────────────────────


@pytest.mark.asyncio
async def test_the_receipt_is_byte_identical_before_and_after_triage(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Status, a duplicate link and a note change nothing the reporter can read."""
    headers = await _signup(async_client, "feedback_receipt_triage")
    filed = await async_client.post("/feedback/", json=_payload(), headers=headers)
    other = await async_client.post("/feedback/", json=_payload(), headers=headers)
    public_id, other_id = filed.json()["public_id"], other.json()["public_id"]
    receipt_path = f"/feedback/{public_id}/receipt"
    before = await async_client.get(receipt_path, headers=headers)
    admin = await make_account(db_session, "receipt_triage_admin@example.com", admin=True)

    for command in (
        {"action": "transition", "status": "triaged"},
        {"action": "transition", "status": "planned"},
        {"action": "link_duplicate", "target_public_id": other_id},
        {"action": "add_note", "body": "Operator only."},
    ):
        resp = await async_client.post(
            f"/admin/feedback/{public_id}/actions", json=command, headers=admin.headers
        )
        assert resp.status_code == HTTPStatus.OK, resp.text
    after = await async_client.get(receipt_path, headers=headers)

    assert before.status_code == after.status_code == HTTPStatus.OK
    assert after.content == before.content
    for leaked in ("planned", "triaged", "Operator only.", other_id, "duplicate", "note"):
        assert leaked not in after.text
