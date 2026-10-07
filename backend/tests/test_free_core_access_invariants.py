"""The free core never depends on payment or on an AI allowance (#1938, B21).

Adepthood's floor is the journal: "you choose your depth", and the APTITUDE
membership's price floor is $0. This suite pins what a member holding a $0
license, with no AI allowance at all, can always do -- both while their
entitlement is live and after a refund revokes it (ADR 0008 Decision 4):

* write, edit, list, read and delete journal entries;
* export everything, as JSON and as Markdown;
* create habits and log practice sessions;
* read the course;
* delete the account.

Course reading after revocation is pinned as *today's* behaviour, not as a
product promise: what revocation should restrict is the owner's open
decision (#1938, B21 escalation E1). Until it is made, a revoked
entitlement restricts nothing, and a change that gates any route on it has
to change this suite on purpose.

None of these may charge the wallet, write an LLM usage row, or call Gumroad.
The allowance is zero on every axis -- ``BOTMASON_MONTHLY_CAP=0``, an empty
``offering_balance`` and ``BOTMASON_DAILY_GENERATION_CEILING=0`` -- and the
fixture asserts those preconditions itself, so it cannot silently drift into
testing a funded member. Every Gumroad seam is replaced by a recording guard
that raises, and each test asserts the guard saw nothing.

What this suite does *not* prove: that a $0 purchase classifies as VERIFIED.
The fixture overrides the auth router's verifier wholesale; the classifier
itself is pinned by
``tests/routers/test_auth_signup_license.py::test_zero_price_membership_license_creates_exactly_one_account``.
Reclaiming a deleted account's license is pinned by
``tests/routers/test_license_reclaim.py``.

The last section is static: the two modules that move money in response to
Gumroad (token-pack credit and purchase reversal) import nothing that holds
journal or corpus content, so a payment decision cannot read what someone
wrote.
"""

from __future__ import annotations

import ast
import importlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel, select

from domain.entitlements import (
    REASON_REFUND,
    AptitudeLicenseCheck,
    LicenseOutcome,
    has_course_access,
    revoke_course_access,
)
from models.course_stage import CourseStage
from models.llm_usage_log import LLMUsageLog
from models.practice import Practice
from models.stage_content import StageContent
from models.user import User
from models.wallet_audit import WalletAudit
from routers import auth as auth_router
from schemas.gumroad import GumroadPurchase
from services.usage import (
    DAILY_GENERATION_CEILING_ENV,
    get_daily_generation_ceiling,
    get_monthly_cap,
)

MONTHLY_CAP_ENV = "BOTMASON_MONTHLY_CAP"
ZERO = 0
ACTIVE = "active"
REVOKED = "revoked"
MEMBER_EMAIL = "free-member@example.com"
MEMBER_PASSWORD = "securepassword123"  # pragma: allowlist secret
ZERO_PRICE_PRODUCT_ID = "prod_free_floor"
ZERO_PRICE_SALE_ID = "S-free-floor"
FIRST_DRAFT = "A page I wrote with nothing in the wallet."
SECOND_DRAFT = "The same page, edited, still with nothing in the wallet."
STAGE_NUMBER = 1
SESSION_MINUTES = 5
INSUFFICIENT_OFFERINGS = "insufficient_offerings"
# Every seam through which the app reaches Gumroad, as (module path, attribute).
GUMROAD_SEAMS = (
    ("domain.entitlements", "verify_license"),
    ("integrations.gumroad", "verify_license"),
    ("routers.auth", "verify_aptitude_license"),
)
GUMROAD_GUARD_MESSAGE = "a free-core route reached Gumroad"


@dataclass(frozen=True)
class FreeMember:
    """A signed-up $0 member with zero allowance, plus what the guards saw."""

    state: str
    user_id: int
    headers: dict[str, str]
    gumroad_calls: list[str]
    wallet_audits_before: int
    usage_logs_before: int


def _zero_price_purchase() -> GumroadPurchase:
    """A live $0 membership purchase, parsed the way Gumroad's JSON arrives."""
    return GumroadPurchase.model_validate(
        {
            "email": MEMBER_EMAIL,
            "product_id": ZERO_PRICE_PRODUCT_ID,
            "sale_id": ZERO_PRICE_SALE_ID,
            "price": ZERO,
            "recurrence": "monthly",
            "subscription_ended_at": None,
            "subscription_cancelled_at": None,
        }
    )


async def _count(db_session: AsyncSession, model: type[SQLModel]) -> int:
    """Return the number of ``model`` rows."""
    result = await db_session.execute(select(func.count()).select_from(model))
    return int(result.scalar_one())


async def _signup_zero_price_member(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> tuple[dict[str, str], int]:
    """Sign up through a verifier answering one live $0 purchase."""

    async def _verified(
        license_key: str | None,  # noqa: ARG001 — any key: the purchase is fixed
        *,
        client: object | None = None,  # noqa: ARG001 — matches the real signature
    ) -> AptitudeLicenseCheck:
        return AptitudeLicenseCheck(LicenseOutcome.VERIFIED, _zero_price_purchase())

    monkeypatch.setattr(auth_router, "verify_aptitude_license", _verified)
    response = await client.post(
        "/auth/signup",
        json={"email": MEMBER_EMAIL, "password": MEMBER_PASSWORD, "license_key": "FREE-KEY"},
    )
    assert response.status_code == HTTPStatus.OK, response.text
    body = response.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


def _install_gumroad_guards(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Replace every Gumroad seam with a guard that records the call and raises."""
    calls: list[str] = []

    def _guard_for(seam: str) -> object:
        async def _guard(*_args: object, **_kwargs: object) -> None:
            calls.append(seam)
            raise AssertionError(GUMROAD_GUARD_MESSAGE)

        return _guard

    for module, attribute in GUMROAD_SEAMS:
        seam = f"{module}.{attribute}"
        monkeypatch.setattr(seam, _guard_for(seam))
    return calls


async def _assert_zero_allowance(db_session: AsyncSession, user_id: int) -> None:
    """Fail the fixture unless the member truly has no allowance on any axis."""
    user = await db_session.get(User, user_id)
    assert user is not None
    assert user.offering_balance == ZERO
    assert get_monthly_cap() == ZERO
    assert get_daily_generation_ceiling() == ZERO


@pytest_asyncio.fixture(params=[ACTIVE, REVOKED])
async def free_member(
    request: pytest.FixtureRequest,
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    disable_rate_limit: None,  # noqa: ARG001 — the suite drives many routes per test
) -> FreeMember:
    """A $0 member with zero allowance, live or refunded, with Gumroad walled off."""
    monkeypatch.setenv(MONTHLY_CAP_ENV, str(ZERO))
    monkeypatch.setenv(DAILY_GENERATION_CEILING_ENV, str(ZERO))
    headers, user_id = await _signup_zero_price_member(async_client, monkeypatch)
    assert await has_course_access(db_session, user_id)
    if request.param == REVOKED:
        await revoke_course_access(db_session, user_id, REASON_REFUND)
        assert not await has_course_access(db_session, user_id)
    await _assert_zero_allowance(db_session, user_id)
    calls = _install_gumroad_guards(monkeypatch)
    return FreeMember(
        state=request.param,
        user_id=user_id,
        headers=headers,
        gumroad_calls=calls,
        wallet_audits_before=await _count(db_session, WalletAudit),
        usage_logs_before=await _count(db_session, LLMUsageLog),
    )


async def _assert_nothing_charged(db_session: AsyncSession, member: FreeMember) -> None:
    """No wallet movement, no LLM usage, no Gumroad call -- and the guards are live."""
    assert await _count(db_session, WalletAudit) == member.wallet_audits_before
    assert await _count(db_session, LLMUsageLog) == member.usage_logs_before
    assert member.gumroad_calls == []
    for module, attribute in GUMROAD_SEAMS:
        installed = getattr(importlib.import_module(module), attribute)
        assert installed.__name__ == "_guard", f"{module}.{attribute} guard not installed"
    await db_session.rollback()
    user = await db_session.get(User, member.user_id)
    if user is not None:
        assert user.offering_balance == ZERO
        assert user.monthly_messages_used == ZERO


async def _write_entry(client: AsyncClient, member: FreeMember) -> int:
    """Write one journal entry and return its id."""
    response = await client.post("/journal/", json={"message": FIRST_DRAFT}, headers=member.headers)
    assert response.status_code == HTTPStatus.CREATED, response.text
    return int(response.json()["id"])


@pytest.mark.asyncio
async def test_journal_crud_is_free(
    async_client: AsyncClient, db_session: AsyncSession, free_member: FreeMember
) -> None:
    """Write, edit, list, read and delete: every one answers 2xx and charges nothing."""
    headers = free_member.headers
    entry_id = await _write_entry(async_client, free_member)

    edited = await async_client.patch(
        f"/journal/{entry_id}", json={"message": SECOND_DRAFT}, headers=headers
    )
    listed = await async_client.get("/journal/", headers=headers)
    read = await async_client.get(f"/journal/{entry_id}", headers=headers)
    deleted = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert edited.status_code == HTTPStatus.OK, edited.text
    assert listed.status_code == HTTPStatus.OK, listed.text
    assert read.status_code == HTTPStatus.OK, read.text
    assert read.json()["message"] == SECOND_DRAFT
    assert deleted.status_code == HTTPStatus.NO_CONTENT, deleted.text
    await _assert_nothing_charged(db_session, free_member)


@pytest.mark.asyncio
async def test_both_exports_are_free(
    async_client: AsyncClient, db_session: AsyncSession, free_member: FreeMember
) -> None:
    """The JSON export and the Markdown journal export both answer 200 and charge nothing."""
    await _write_entry(async_client, free_member)

    full = await async_client.get("/users/me/export", headers=free_member.headers)
    markdown = await async_client.get("/users/me/export/journal.md", headers=free_member.headers)

    assert full.status_code == HTTPStatus.OK, full.text
    assert markdown.status_code == HTTPStatus.OK, markdown.text
    assert FIRST_DRAFT in markdown.text
    await _assert_nothing_charged(db_session, free_member)


@pytest.mark.asyncio
async def test_habits_and_practice_are_free(
    async_client: AsyncClient, db_session: AsyncSession, free_member: FreeMember
) -> None:
    """Creating a habit, choosing a practice and logging a session all succeed."""
    headers = free_member.headers
    practice = Practice(
        stage_number=STAGE_NUMBER,
        name="Meditation",
        description="Sit quietly",
        instructions="Close your eyes and breathe",
        default_duration_minutes=10,
        approved=True,
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)

    habit = await async_client.post(
        "/habits/",
        json={
            "name": "Drink Water",
            "icon": "W",
            "start_date": "2024-01-01",
            "energy_cost": 1,
            "energy_return": 2,
            "stage": "aptitude",
        },
        headers=headers,
    )
    chosen = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": STAGE_NUMBER},
        headers=headers,
    )
    assert chosen.status_code == HTTPStatus.CREATED, chosen.text
    ended = datetime.now(UTC)
    logged = await async_client.post(
        "/practice-sessions/",
        json={
            "user_practice_id": chosen.json()["id"],
            "started_at": (ended - timedelta(minutes=SESSION_MINUTES)).isoformat(),
            "ended_at": ended.isoformat(),
        },
        headers=headers,
    )

    assert habit.status_code == HTTPStatus.OK, habit.text
    assert logged.status_code == HTTPStatus.CREATED, logged.text
    await _assert_nothing_charged(db_session, free_member)


@pytest.mark.asyncio
async def test_course_reading_is_free_whatever_the_entitlement(
    async_client: AsyncClient, db_session: AsyncSession, free_member: FreeMember
) -> None:
    """A $0 member reads the course live or refunded, and reading charges nothing.

    Pins today's behaviour for the revoked case (AC10/AC11). It stays pinned
    until the owner decides E1 -- what, if anything, a revoked entitlement
    should restrict. Gating course reading on it is that decision, not a fix.
    """
    stage = CourseStage(
        title="Stage 1",
        subtitle="Subtitle 1",
        stage_number=STAGE_NUMBER,
        overview_url="https://example.com/stage-1",
        category="test",
        aspect="test-aspect",
        spiral_dynamics_color="beige",
        growing_up_stage="archaic",
        divine_gender_polarity="masculine",
        relationship_to_free_will="active",
        free_will_description="Active Yes-And-Ness",
    )
    db_session.add(stage)
    await db_session.flush()
    db_session.add(
        StageContent(
            course_stage_id=stage.id,
            title="Day 1 Essay",
            content_type="essay",
            release_day=0,
            url="https://cms.example.com/s1-essay",
        )
    )
    await db_session.commit()

    listing = await async_client.get(
        f"/course/stages/{STAGE_NUMBER}/content", headers=free_member.headers
    )

    assert listing.status_code == HTTPStatus.OK, listing.text
    assert [item["title"] for item in listing.json()] == ["Day 1 Essay"]
    await _assert_nothing_charged(db_session, free_member)


@pytest.mark.asyncio
async def test_charged_resonance_is_refused_but_entry_is_kept(
    async_client: AsyncClient, db_session: AsyncSession, free_member: FreeMember
) -> None:
    """With no allowance a resonance pass is exactly 402, and the page it was asked of stays."""
    entry_id = await _write_entry(async_client, free_member)

    refused = await async_client.post(f"/journal/{entry_id}/resonance", headers=free_member.headers)
    kept = await async_client.get(f"/journal/{entry_id}", headers=free_member.headers)

    assert refused.status_code == HTTPStatus.PAYMENT_REQUIRED, refused.text
    assert refused.json()["detail"] == INSUFFICIENT_OFFERINGS
    assert kept.status_code == HTTPStatus.OK
    assert kept.json()["message"] == FIRST_DRAFT
    await _assert_nothing_charged(db_session, free_member)


@pytest.mark.asyncio
async def test_account_deletion_is_free(
    async_client: AsyncClient, db_session: AsyncSession, free_member: FreeMember
) -> None:
    """A $0 member with nothing in the wallet can always erase their account."""
    await _write_entry(async_client, free_member)

    response = await async_client.request(
        "DELETE", "/users/me", json={"confirm_email": MEMBER_EMAIL}, headers=free_member.headers
    )

    assert response.status_code == HTTPStatus.OK, response.text
    assert await db_session.get(User, free_member.user_id) is None
    await _assert_nothing_charged(db_session, free_member)


# ---------------------------------------------------------------------------
# Payment code never imports content code (AC13)
# ---------------------------------------------------------------------------
_SRC = Path(__file__).resolve().parents[1] / "src"
PAYMENT_MODULES = {
    "token_packs": _SRC / "services" / "token_packs.py",
    "gumroad_revocation": _SRC / "services" / "gumroad_revocation.py",
}
# Any module or imported name whose dotted path contains one of these, matched
# case-insensitively, holds, routes or derives from what someone wrote.
FORBIDDEN_FRAGMENTS = (
    "journal",
    "corpus",
    "reflection",
    "marginalia",
    "resonance",
    "botmason",
    "prompt_response",
    "creek_vault",
)
# Both modules debit or credit the wallet; seeing it proves the parse is real.
POSITIVE_CONTROL = "services.wallet"


def _absolute_imports(path: Path) -> set[str]:
    """Every module and name ``path`` imports directly, including under ``TYPE_CHECKING``.

    ``from X import Y`` records both ``X`` and ``X.Y``. A package re-exports its
    members (``models/__init__.py`` re-exports ``JournalEntry``), so
    ``from models import JournalEntry`` names the content only in ``Y``.
    """
    modules: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            modules.add(node.module)
            modules.update(f"{node.module}.{alias.name}" for alias in node.names)
    return modules


def _names_content(dotted: str) -> bool:
    """Whether ``dotted`` names a content holder (``JournalEntry`` matches ``journal``)."""
    lowered = dotted.lower()
    return any(fragment in lowered for fragment in FORBIDDEN_FRAGMENTS)


def _content_imports(path: Path) -> set[str]:
    """The direct imports of ``path`` that name a content-holding module or symbol."""
    return {module for module in _absolute_imports(path) if _names_content(module)}


@pytest.mark.parametrize("name", sorted(PAYMENT_MODULES))
def test_payment_modules_never_import_journal_or_corpus_code(name: str) -> None:
    """Token-pack credit and purchase reversal cannot reach what anyone wrote."""
    path = PAYMENT_MODULES[name]

    assert POSITIVE_CONTROL in _absolute_imports(path)
    assert _content_imports(path) == set()


@pytest.mark.parametrize(
    ("planted_import", "flagged"),
    [
        (
            "from models.journal_entry import JournalEntry",
            {"models.journal_entry", "models.journal_entry.JournalEntry"},
        ),
        ("from models import JournalEntry", {"models.JournalEntry"}),
        (
            "from services import corpus_store, journal_encryption",
            {"services.corpus_store", "services.journal_encryption"},
        ),
        ("import services.corpus_store", {"services.corpus_store"}),
    ],
    ids=["module-path", "package-reexport", "package-submodules", "plain-import"],
)
def test_import_guard_flags_a_content_import(
    tmp_path: Path, planted_import: str, flagged: set[str]
) -> None:
    """The guard bites on every spelling, including a package-level re-export."""
    planted = tmp_path / "planted.py"
    planted.write_text(
        "from typing import TYPE_CHECKING\n"
        "from services.wallet import grant_purchase_credit\n"
        "if TYPE_CHECKING:\n"
        f"    {planted_import}\n",
        encoding="utf-8",
    )

    assert _content_imports(planted) == flagged
