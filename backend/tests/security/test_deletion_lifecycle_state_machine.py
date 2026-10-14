"""Deletion survives crashes, replays and restores without resurrecting anything (#3162, C21).

The claim (#3069, C21) as audited: *deleting or marking Intimate removes all
prior copies immediately* -- **False**. The honest replacement, which this
module holds the code to, is narrower: local deletion hides the page at once,
remote cleanup may be pending and is said to be, and account deletion and
backup expiry have scopes of their own. So the property asserted is not "every
copy is gone" but "nothing is re-sent, nothing comes back, and nothing is
reported gone that is not".

The machine
===========

Hypothesis is not a backend dev dependency, so this is the equivalent bounded
explicit enumeration: a :class:`Machine` whose rules are the lifecycle steps
(:class:`Rule`) -- write a page with a mirrored essay, reclassify it to
Intimate, delete it, erase it here only, erase the account, vault outage on and
off, restart (resume durable pipeline runs, then the withdrawal and retraction
sweep), snapshot the database, restore a snapshot and reapply tombstones -- and
a fixed set of programs over them. Every rule is a step; after **every** step
:meth:`Machine.check` asserts the invariant.

The crash rule is enumerated, not sampled. :class:`CommitTrap` wraps
``AsyncSession.commit`` and kills the process (a :class:`ProcessKilledError`
``BaseException``, so no ``except Exception`` can absorb it) right after the
k-th commit of one operation. Each crash cell runs k = 1, 2, ... on a fresh
account until the operation completes without reaching commit k, so every
commit boundary on the delete, erase-here, Intimate-withdraw, background
sweep, account-erasure and tombstone-reapply paths is the last thing a process
did at least once. The boundaries reached are named by the source function that
committed, and each cell must have crashed after every boundary
:data:`MUST_CRASH_AT` names for it, so the enumeration stays tied to the
commits the code really makes.

The invariant (:func:`violations`)
==================================

For every page the model has seen go -- soft-deleted, ``pending_delete``,
Intimate, or its account erased -- from the step it went on:

* its canary is in no provider prompt, classifier input or vault write, and in
  no corpus fragment;
* it never comes back: once gone, a later state that is not gone is a
  resurrection (this is how a restore that forgets a deletion is caught);
* every remote copy the modelled vault still holds is owed by an open,
  durable record -- a ``pending_delete`` or ``unconfirmed`` obligation, a
  ``pending`` or ``mirror_intent`` essay retraction, the held vault marker of a
  live Intimate page, or (account erased) a receipt that said the vault was not
  purged -- and the API never told the writer it was withdrawn;
* a page whose deletion is in progress is reported so: an edit answers 409
  ``journal_entry_deletion_pending``.

Between a restore and the end of its tombstone reapply the restored app is held
shut by the startup gate (``assert_restore_reapplied``), so the invariant is
checked once reapply finishes, and the gate is asserted closed until then.

Recovery, then clean
--------------------

After a crash the writer behaves as a person would: they reread the page and
repeat the request only if it still looks undone. The vault comes back and the
process restarts. Then every cell must be **clean**: no copy left, no
obligation open -- except where the honest answer is permanent: a copy made
before destination binding stays ``unconfirmed`` forever (#3180), and an erased
account's manual vault is the owner's to purge, as its receipt says.

What the machine found
---------------------

* A process killed between the Intimate PATCH's tier commit and its local
  withdrawal left a corpus copy and a mirrored essay nothing would ever
  withdraw: the page already read Intimate, so neither writer nor sweep
  retried. The two now share one commit (``routers.journal``).
* A new account handed an erased account's id (a restore rewinds the
  sequence) had its own deleted pages left out of the tombstone export, so a
  second restore resurrected them. Every soft-deleted page is now exported.
* A restore still forgets an Intimate reclassification and a deletion in
  progress, because neither is a tombstone: two strict-xfail reproducers below,
  owned by #3214.

Out of reach here, and named in the manifest as gaps: provider-side backup
erasure, vendor copies (#3065) and manually managed vaults.
"""

from __future__ import annotations

import contextlib
import enum
import inspect
import json
import shutil
import uuid
from collections.abc import AsyncGenerator, Awaitable, Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from pathlib import Path
from typing import TYPE_CHECKING, Final

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import (
    get_creek_vault_client,
    get_reflection_boundary,
    vault_destination_fingerprint,
)
from domain.creek_vault import (
    CreekVaultUnavailableError,
    VaultPipelineStage,
    VaultTierCeiling,
    VaultVoiceDraftDeleteResult,
)
from domain.frequencies import Frequency
from main import app
from models.corpus_fragment import CorpusFragment, CorpusSource
from models.journal_entry import JournalClassification, JournalEntry
from models.journal_withdrawal_obligation import (
    OPEN_STATES,
    JournalWithdrawalObligation,
    JournalWithdrawalState,
)
from models.marginalia import Marginalia, MarginaliaKind
from models.restore_marker import RestoreMarker, RestoreState
from models.user import User
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from models.voice_draft_retraction import VoiceDraftRetraction, VoiceDraftRetractionState
from rate_limit import limiter
from services import creek_vault_pipeline as pipeline
from services import journal_vault_withdrawal, restore_suppression
from services.creek_vault_pipeline import VaultPipelineTrigger
from services.creek_vault_voice_drafts import (
    JournalRetrySchedule,
    resume_voice_draft_retractions,
    voice_draft_external_id,
)
from services.reflection_boundary import ReflectionBoundary
from services.restore_suppression import (
    RESTORE_ID_ENV_VAR,
    RESTORE_SUPPRESSION_REQUIRED_ENV_VAR,
    RestoreNotReappliedError,
    TombstoneSet,
    assert_restore_reapplied,
    export_tombstones,
    reapply_tombstones,
)
from services.user_vault_config import store_vault_config
from tests.helpers.telemetry_canaries import SHORT_CANARY
from tests.support.egress_recorders import (
    Ledger,
    Recorder,
    RecordingVault,
    carries,
    corpus_fragments,
    record_classifier_inputs,
    record_provider_dials,
)

if TYPE_CHECKING:
    from httpx import AsyncClient, Response
    from sqlalchemy.ext.asyncio import async_sessionmaker

_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
_VAULT_URL: Final = "https://vault-a.example.com"
_VAULT_KEY: Final = "key-a-0123456789"  # pragma: allowlist secret

#: A reply the classifier's parser accepts, so a written page reaches the corpus.
_CLASSIFIED_REPLY: Final = json.dumps(
    {"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9}
)
#: The pipeline's retry backoff, shortened: what is sent is the property, not the clock.
_FAST_RETRY_SECONDS: Final = 0.001
#: How far the sweep's clock moves per restart: past every retraction backoff.
_RESTART_INTERVAL: Final = timedelta(days=1)
#: More commits than any one operation here makes; reaching it means a loop.
_MAX_COMMITS_PER_OPERATION: Final = 60

_DB_FILE: Final = "concurrent.db"
_SNAPSHOT_FILE: Final = "snapshot.db"

_DELETION_PENDING: Final = "journal_entry_deletion_pending"
_UNRECORDED_VAULT: Final = "vault_withdrawal_unrecorded_vault"
_OPEN_RETRACTIONS: Final = frozenset(
    {VoiceDraftRetractionState.PENDING.value, VoiceDraftRetractionState.MIRROR_INTENT.value}
)


# ── Crashing after a commit ──────────────────────────────────────────────────


class ProcessKilledError(BaseException):
    """The process died right after a commit returned."""


def _committer() -> str:
    """The application function that called ``commit``: the boundary's name."""
    frame = inspect.currentframe()
    while frame is not None:
        source = frame.f_code.co_filename.replace("\\", "/")
        if "/backend/src/" in source:
            return f"{frame.f_globals.get('__name__')}.{frame.f_code.co_qualname}"
        frame = frame.f_back
    return "<outside the application>"


@dataclass
class CommitTrap:
    """Counts one operation's commits and kills the process after the k-th."""

    crash_at: int | None = None
    seen: list[str] = field(default_factory=list)
    armed: bool = False
    #: Every boundary any cell crashed at, for the enumeration guard.
    crashed_at: set[str] = field(default_factory=set)

    def after_commit(self) -> None:
        """Called after every real commit; raises :class:`ProcessKilledError` at the armed one."""
        if not self.armed:
            return
        self.seen.append(_committer())
        if len(self.seen) == self.crash_at:
            self.armed = False
            self.crashed_at.add(self.seen[-1])
            raise ProcessKilledError(self.seen[-1])

    @contextlib.contextmanager
    def crashing_after(self, k: int | None) -> Iterator[CommitTrap]:
        """Arm for one operation: kill after its ``k``-th commit (never, for ``None``)."""
        self.crash_at, self.seen, self.armed = k, [], True
        try:
            yield self
        finally:
            self.armed = False


def _install_trap(monkeypatch: pytest.MonkeyPatch) -> CommitTrap:
    trap = CommitTrap()
    original = AsyncSession.commit

    async def _commit(session: AsyncSession) -> None:
        await original(session)
        trap.after_commit()

    monkeypatch.setattr(AsyncSession, "commit", _commit)
    return trap


def _is_kill(exc: BaseException) -> bool:
    """A :class:`ProcessKilledError`, alone or inside the task group the ASGI stack wraps it in."""
    if isinstance(exc, ProcessKilledError):
        return True
    if isinstance(exc, BaseExceptionGroup):
        return exc.subgroup(ProcessKilledError) is not None
    return False


async def _killed(operation: Awaitable[object]) -> bool:
    """Run ``operation``; whether the process was killed partway through it."""
    try:
        await operation
    except BaseException as exc:
        if _is_kill(exc):
            return True
        raise
    return False


async def _respond(request: Awaitable[Response]) -> Response | None:
    """Send ``request``; ``None`` if the process was killed before it answered."""
    try:
        return await request
    except BaseException as exc:
        if _is_kill(exc):
            return None
        raise


# ── The vault, with an outage switch for every withdrawal ────────────────────


class OutageVault(RecordingVault):
    """The recording vault, whose outage refuses essay retractions as well as withdrawals."""

    async def delete_voice_draft(
        self, external_id: str, tier_ceiling: VaultTierCeiling, /
    ) -> VaultVoiceDraftDeleteResult:
        """Record the retraction; refuse it during an outage, else forget the draft."""
        if self.fail_withdrawals:
            await self._dial("delete_voice_draft", f"{tier_ceiling} {external_id}")
            msg = "synthetic retraction outage"
            raise CreekVaultUnavailableError(msg)
        return await super().delete_voice_draft(external_id, tier_ceiling)


# ── What the model knows ─────────────────────────────────────────────────────


class Claim(enum.Enum):
    """What the API last told the writer about the page's remote copies."""

    #: No answer: nothing was claimed (the process died, or the page was already gone).
    NONE = "none"
    #: The API said remote cleanup is pending (503, ``unconfirmed``, "not purged").
    PENDING = "pending"
    #: The API said every copy is confirmed absent (204, 200, ``confirmed_absent``).
    CONFIRMED = "confirmed"


@dataclass
class Page:
    """One account, its one page and that page's one mirrored essay."""

    email: str
    headers: dict[str, str]
    user_id: int
    entry_id: int
    note_id: int
    canary: str
    gone_since: int | None = None
    claim: Claim = Claim.NONE
    receipt: dict[str, object] | None = None

    @property
    def journal_key(self) -> str:
        """The modelled vault's key for the page's own copy."""
        return f"journal:{self.entry_id}"

    @property
    def draft_key(self) -> str:
        """The modelled vault's key for the essay's Voice Draft."""
        return f"draft:{voice_draft_external_id(self.user_id, self.note_id)}"


@dataclass(frozen=True)
class Stored:
    """The page's durable state, read back from the database."""

    account_exists: bool
    entry: JournalEntry | None
    obligation: str | None
    retractions: tuple[str, ...]

    @property
    def deleting(self) -> bool:
        """A deletion the writer asked for and the sweep will finish."""
        return self.obligation == JournalWithdrawalState.PENDING_DELETE.value

    @property
    def gone(self) -> bool:
        """Deleted, being deleted, Intimate, or its account erased."""
        entry = self.entry
        return (
            not self.account_exists
            or entry is None
            or entry.deleted_at is not None
            or entry.classification == JournalClassification.INTIMATE
            or self.deleting
        )

    @property
    def marker_held(self) -> bool:
        """A live Intimate page still holding its vault marker: the sweep owes it."""
        entry = self.entry
        return (
            entry is not None
            and entry.deleted_at is None
            and entry.classification == JournalClassification.INTIMATE
            and (entry.vault_ref is not None or entry.vault_destination is not None)
        )


async def _stored(factory: async_sessionmaker[AsyncSession], page: Page) -> Stored:
    """Read the page back -- by its account's address, never by an id alone.

    After a restore rewinds the database, or once an account is erased, a new
    account can be handed the same user, entry and note ids; only the address
    (unique per page here) tells the page apart from whoever holds them now.
    """
    async with factory() as session:
        user = await session.get(User, page.user_id)
        if user is None or user.email != page.email:
            return Stored(account_exists=False, entry=None, obligation=None, retractions=())
        entry = await session.get(JournalEntry, page.entry_id)
        obligation = (
            await session.execute(
                select(JournalWithdrawalObligation.state).where(
                    col(JournalWithdrawalObligation.user_id) == page.user_id,
                    col(JournalWithdrawalObligation.journal_entry_id) == page.entry_id,
                )
            )
        ).scalar_one_or_none()
        retractions = (
            await session.execute(
                select(VoiceDraftRetraction.state).where(
                    col(VoiceDraftRetraction.user_id) == page.user_id,
                    col(VoiceDraftRetraction.marginalia_id) == page.note_id,
                )
            )
        ).scalars()
        return Stored(True, entry, obligation, tuple(retractions))


def _receipt_says_not_purged(page: Page) -> bool:
    """An erased account's receipt, if one was delivered, did not claim the vault purged."""
    if page.receipt is None:
        return True
    vault = page.receipt["vault"]
    return isinstance(vault, dict) and vault["configured"] is True and vault["purged"] is False


def _owed(page: Page, stored: Stored, key: str) -> bool:
    """Whether a durable, open record owes the remote copy at ``key``."""
    if not stored.account_exists:
        # Account erasure dials nothing; a manual vault is its owner's to purge.
        return _receipt_says_not_purged(page)
    if key == page.journal_key:
        return stored.obligation in OPEN_STATES or stored.marker_held
    return any(state in _OPEN_RETRACTIONS for state in stored.retractions)


# ── The machine ──────────────────────────────────────────────────────────────


class Rule(enum.StrEnum):
    """Every step the machine can take."""

    WRITE = "write"
    RECLASSIFY = "reclassify to Intimate"
    DELETE = "delete"
    ERASE_HERE = "erase here only"
    ERASE_ACCOUNT = "erase account"
    OUTAGE_ON = "vault outage on"
    OUTAGE_OFF = "vault outage off"
    RESTART = "restart: resume pipeline runs, then sweep"
    SNAPSHOT = "take a backup snapshot"
    RESTORE = "restore the snapshot, then reapply tombstones"


@dataclass
class Machine:
    """The world one cell runs in: one database, one vault, every recorder."""

    client: AsyncClient
    factory: async_sessionmaker[AsyncSession]
    ledger: Ledger
    vault: OutageVault
    trap: CommitTrap
    tmp_path: Path
    monkeypatch: pytest.MonkeyPatch
    #: Every page any program wrote; the invariant is checked over all of them.
    pages: list[Page] = field(default_factory=list)
    #: The current program's pages: the ones a restart leaves a run in flight for.
    active: list[Page] = field(default_factory=list)
    trace: list[str] = field(default_factory=list)
    clock: datetime = field(default_factory=lambda: datetime.now(UTC))
    step_mark: int = 0
    restores: int = 0

    # ── stepping ──

    def begin(self, rule: Rule, detail: str = "") -> None:
        """Note the step, and where in the ledger it began."""
        self.trace.append(f"{rule}{f' ({detail})' if detail else ''}")
        self.step_mark = self.ledger.mark()

    async def check(self, *, everything: bool = False) -> None:
        """The invariant, after a step: over this program's pages, or every page written."""
        found = await violations(self, self.pages if everything else self.active)
        assert found == [], "\n".join(["after: " + " -> ".join(self.trace), *found])

    # ── rules ──

    async def write(self) -> Page:
        """A Personal page carrying a fresh canary, ontologized, with a mirrored essay."""
        self.begin(Rule.WRITE)
        page = await _write_page(self)
        self.pages.append(page)
        self.active.append(page)
        _assert_recorders_reached(self, page)
        await self.check()
        return page

    async def reclassify(self, page: Page, *, crash_at: int | None = None) -> bool:
        """``PATCH classification=intimate``; ``True`` if the process was killed."""
        self.begin(Rule.RECLASSIFY, _crash(crash_at))
        with self.trap.crashing_after(crash_at):
            response = await _respond(
                self.client.patch(
                    f"/journal/{page.entry_id}",
                    json={"classification": JournalClassification.INTIMATE.value},
                    headers=page.headers,
                )
            )
        _note_answer(page, response, confirmed=HTTPStatus.OK)
        await self.check()
        return response is None

    async def delete(self, page: Page, *, crash_at: int | None = None) -> bool:
        """``DELETE /journal/{id}``; ``True`` if the process was killed."""
        self.begin(Rule.DELETE, _crash(crash_at))
        with self.trap.crashing_after(crash_at):
            response = await _respond(
                self.client.delete(f"/journal/{page.entry_id}", headers=page.headers)
            )
        _note_answer(page, response, confirmed=HTTPStatus.NO_CONTENT)
        await self.check()
        return response is None

    async def erase_here(self, page: Page, *, crash_at: int | None = None) -> bool:
        """``POST /journal/{id}/erase-locally``; ``True`` if the process was killed."""
        self.begin(Rule.ERASE_HERE, _crash(crash_at))
        with self.trap.crashing_after(crash_at):
            response = await _respond(
                self.client.post(f"/journal/{page.entry_id}/erase-locally", headers=page.headers)
            )
        if response is not None and response.status_code == HTTPStatus.OK:
            confirmed = response.json()["remote_copy"] == "confirmed_absent"
            page.claim = Claim.CONFIRMED if confirmed else Claim.PENDING
        await self.check()
        return response is None

    async def erase_account(self, page: Page, *, crash_at: int | None = None) -> bool:
        """``DELETE /users/me``; ``True`` if the process was killed."""
        self.begin(Rule.ERASE_ACCOUNT, _crash(crash_at))
        with self.trap.crashing_after(crash_at):
            response = await _respond(
                self.client.request(
                    "DELETE", "/users/me", json={"confirm_email": page.email}, headers=page.headers
                )
            )
        if response is not None and response.status_code == HTTPStatus.OK:
            page.receipt = response.json()
            page.claim = Claim.PENDING if _receipt_says_not_purged(page) else Claim.CONFIRMED
        await self.check()
        return response is None

    async def outage(self, *, on: bool) -> None:
        """The vault stops (or resumes) confirming withdrawals and retractions."""
        self.begin(Rule.OUTAGE_ON if on else Rule.OUTAGE_OFF)
        self.vault.fail_withdrawals = on
        await self.check()

    async def restart(self, *, crash_at: int | None = None) -> bool:
        """A fresh process: replay durable pipeline runs, then sweep owed withdrawals.

        ``crash_at`` kills the process inside the sweep -- the withdraw and
        retract path; the content-free pipeline ladder before it is replayed
        on every restart but not crashed into.
        """
        self.begin(Rule.RESTART, _crash(crash_at))
        await pipeline.close_vault_pipeline_tasks()
        await _seed_attempted_runs(self)
        await pipeline.resume_vault_pipeline_runs(self.factory, self._client)
        await pipeline.wait_for_vault_pipeline_tasks()
        self.clock += _RESTART_INTERVAL
        with self.trap.crashing_after(crash_at):
            killed = await _killed(
                resume_voice_draft_retractions(
                    self.factory,
                    self._client,
                    vault_destination_fingerprint,
                    now=self.clock,
                    journal_retries=JournalRetrySchedule(),
                )
            )
        await self.check()
        return killed

    async def _client(self, _session: AsyncSession, _user_id: int) -> OutageVault:
        return self.vault

    async def snapshot(self) -> Path:
        """Copy the database file, as a backup would, with every connection closed."""
        self.begin(Rule.SNAPSHOT)
        await _engine(self).dispose()
        target = self.tmp_path / _SNAPSHOT_FILE
        shutil.copyfile(self.tmp_path / _DB_FILE, target)
        await self.check()
        return target

    async def restore(self, snapshot: Path, *, crash_at: int | None = None) -> bool:
        """Export tombstones, restore ``snapshot``, reapply; ``True`` if reapply was killed.

        The restored app stays behind the startup gate until reapply completes;
        an interrupted reapply leaves it shut, and is simply run again.
        """
        self.restores += 1
        restore_id = f"drill-{self.restores}"
        self.begin(Rule.RESTORE, _crash(crash_at))
        async with self.factory() as session:
            tombstones = await export_tombstones(session)
        await _engine(self).dispose()
        shutil.copyfile(snapshot, self.tmp_path / _DB_FILE)
        self.monkeypatch.setenv(RESTORE_SUPPRESSION_REQUIRED_ENV_VAR, "1")
        self.monkeypatch.setenv(RESTORE_ID_ENV_VAR, restore_id)
        await _assert_gate_shut(self)
        with self.trap.crashing_after(crash_at):
            killed = await _killed(self._reapply(tombstones, restore_id))
        if killed and not await _marker_complete(self, restore_id):
            # The operator reruns an interrupted reapply; the gate stays shut until it ends.
            await _assert_gate_shut(self)
            await self._reapply(tombstones, restore_id)
        await assert_restore_reapplied(self.factory)
        # A restore rewinds every page, not just this program's.
        await self.check(everything=True)
        return killed

    async def _reapply(self, tombstones: TombstoneSet, restore_id: str) -> None:
        await reapply_tombstones(self.factory, tombstones, restore_id=restore_id)

    # ── the writer, after a failure ──

    async def retry_if_undone(self, page: Page, rule: Rule) -> None:
        """Repeat ``rule`` only if, reading the page back, it still looks undone."""
        read = await self.client.get(f"/journal/{page.entry_id}", headers=page.headers)
        if rule is Rule.ERASE_ACCOUNT:
            if read.status_code != HTTPStatus.UNAUTHORIZED:
                await self.erase_account(page)
            return
        if read.status_code != HTTPStatus.OK:
            return
        if rule is Rule.RECLASSIFY:
            if read.json()["classification"] != JournalClassification.INTIMATE.value:
                await self.reclassify(page)
            return
        if (await _stored(self.factory, page)).deleting:
            return  # the edit probe says "deletion pending"; the sweep finishes it
        await (self.delete(page) if rule is Rule.DELETE else self.erase_here(page))


def _crash(crash_at: int | None) -> str:
    return "" if crash_at is None else f"killed after commit {crash_at}"


def _note_answer(page: Page, response: Response | None, *, confirmed: HTTPStatus) -> None:
    """Record what a DELETE or an Intimate PATCH told the writer."""
    if response is None:
        return
    if response.status_code == confirmed:
        page.claim = Claim.CONFIRMED
    elif response.status_code == HTTPStatus.SERVICE_UNAVAILABLE:
        page.claim = Claim.PENDING


def _engine(machine: Machine) -> AsyncEngine:
    engine = machine.factory.kw["bind"]
    assert isinstance(engine, AsyncEngine)
    return engine


async def _marker_complete(machine: Machine, restore_id: str) -> bool:
    """Whether the restore's marker says its reapply finished (a kill after the last commit)."""
    async with machine.factory() as session:
        state = (
            await session.execute(
                select(RestoreMarker.state).where(col(RestoreMarker.restore_id) == restore_id)
            )
        ).scalar_one_or_none()
    return state == RestoreState.COMPLETE.value


async def _assert_gate_shut(machine: Machine) -> None:
    with pytest.raises(RestoreNotReappliedError):
        await assert_restore_reapplied(machine.factory)


async def _seed_attempted_runs(machine: Machine) -> None:
    """Leave each live account's classification run in flight, for the resume to replay."""
    async with machine.factory() as session:
        for page in machine.active:
            if not (await _stored(machine.factory, page)).account_exists:
                continue
            run = (
                await session.execute(
                    select(VaultPipelineRun).where(
                        col(VaultPipelineRun.user_id) == page.user_id,
                        col(VaultPipelineRun.stage) == VaultPipelineStage.CLASSIFY.value,
                    )
                )
            ).scalar_one_or_none() or VaultPipelineRun(
                user_id=page.user_id,
                stage=VaultPipelineStage.CLASSIFY.value,
                outcome=VaultPipelineOutcome.ATTEMPTED.value,
                trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
                fragments_seen=0,
                fragments_touched=0,
                fragments_lost=0,
            )
            run.outcome = VaultPipelineOutcome.ATTEMPTED.value
            run.job_id = None
            run.attempt_count = 1
            session.add(run)
        await session.commit()


async def _write_page(machine: Machine) -> Page:
    """Sign up, connect a vault, consent, write a Personal page, expand one note into an essay."""
    client = machine.client
    unique = uuid.uuid4().hex
    email = f"lifecycle-{unique[:12]}@example.com"
    signup = await client.post("/auth/signup", json={"email": email, "password": _PASSWORD})
    assert signup.status_code == HTTPStatus.OK, signup.text
    headers = {"Authorization": f"Bearer {signup.json()['token']}"}
    user_id = int(signup.json()["user_id"])
    async with machine.factory() as session:
        await store_vault_config(session, user_id, vault_url=_VAULT_URL, api_key=_VAULT_KEY)
        await session.commit()
    consent = await client.put("/corpus/consent/journal", json={"granted": True}, headers=headers)
    assert consent.status_code == HTTPStatus.OK, consent.text
    # Unique part first: a probe reads only the first 40 characters, and two
    # pages sharing them would answer for each other's copies.
    canary = f"LIFECYCLE_{unique}_{SHORT_CANARY}"
    created = await client.post(
        "/journal/",
        json={"message": f"{canary} I sat with the river.", "classification": "personal"},
        headers=headers,
    )
    assert created.status_code == HTTPStatus.CREATED, created.text
    entry_id = int(created.json()["id"])
    await _seed_fragment(machine, user_id, entry_id, canary)
    note_id = await _seed_note(machine, user_id, entry_id, canary)
    essay = await client.post(
        f"/journal/marginalia/{note_id}/essay", json={"price_acknowledged": True}, headers=headers
    )
    assert essay.status_code == HTTPStatus.OK, essay.text
    return Page(email, headers, user_id, entry_id, note_id, canary)


async def _seed_fragment(machine: Machine, user_id: int, entry_id: int, canary: str) -> None:
    """The page's corpus copy, as ontologized before the vault was connected.

    A vault-bound account is not classified by the app provider (#3183), so a
    page written after connecting gets no fragment of its own. One made
    earlier -- under consent, before the connection -- is the copy every
    deletion path must still withdraw.
    """
    async with machine.factory() as session:
        session.add(
            CorpusFragment(
                user_id=user_id,
                source_entry_id=entry_id,
                source=CorpusSource.JOURNAL,
                tier=JournalClassification.PERSONAL,
                content=f"{canary} I sat with the river.",
                frequency_weights={Frequency.F5.value: 0.9},
                overall_confidence=0.9,
            )
        )
        await session.commit()


async def _seed_note(machine: Machine, user_id: int, entry_id: int, canary: str) -> int:
    """A margin note anchored in the canary, as resonance writes them."""
    async with machine.factory() as session:
        note = Marginalia(
            journal_entry_id=entry_id,
            user_id=user_id,
            kind=MarginaliaKind.SYMBOL,
            anchor_start=0,
            anchor_end=len(canary),
            anchor_text=canary,
            note="A beginning.",
        )
        session.add(note)
        await session.commit()
        await session.refresh(note)
        assert note.id is not None
        return note.id


def _assert_recorders_reached(machine: Machine, page: Page) -> None:
    """Positive control: a live page's canary does reach the recorders the invariant reads.

    The provider (the essay), the vault (the page and its Voice Draft) and the
    corpus. The classifier recorder stays installed, but a vault-bound page
    never reaches it (#3183), so no write here can show it live.
    """
    reached = {e.recorder for e in machine.ledger.carrying(page.canary, since=machine.step_mark)}
    assert reached >= {Recorder.PROVIDER, Recorder.VAULT}, reached
    assert set(machine.vault.remote_copies_carrying(page.canary)) == {
        page.journal_key,
        page.draft_key,
    }


# ── The invariant ────────────────────────────────────────────────────────────


async def violations(machine: Machine, pages: list[Page]) -> list[str]:
    """Every way the current state breaks the C21 invariant for ``pages``; empty when it holds."""
    found: list[str] = []
    fragments = await corpus_fragments(machine.factory)
    for page in pages:
        stored = await _stored(machine.factory, page)
        if stored.gone and page.gone_since is None:
            page.gone_since = machine.step_mark
        if page.gone_since is None:
            continue
        found.extend(_page_violations(machine, page, stored, fragments))
        if stored.deleting and stored.account_exists:
            found.extend(await _probe_pending(machine, page))
    return found


def _page_violations(
    machine: Machine, page: Page, stored: Stored, fragments: list[str]
) -> list[str]:
    """What is wrong with one gone page's state and history."""
    tag = f"entry {page.entry_id}"
    since = page.gone_since or 0
    found = [
        f"{tag}: {event.recorder} {event.verb} carried the canary after it went"
        for event in machine.ledger.carrying(page.canary, since=since)
    ]
    if any(carries(fragment, page.canary) for fragment in fragments):
        found.append(f"{tag}: a corpus fragment still holds it")
    if not stored.gone:
        found.append(f"{tag}: resurrected -- live and not Intimate after it went")
    for key in machine.vault.remote_copies_carrying(page.canary):
        if not _owed(page, stored, key):
            found.append(f"{tag}: the vault holds {key} and no open record owes it")
        if page.claim is Claim.CONFIRMED:
            found.append(f"{tag}: the API said withdrawn while the vault holds {key}")
    return found


async def _probe_pending(machine: Machine, page: Page) -> list[str]:
    """A deletion in progress says so: an edit is refused with the stable 409."""
    probe = await machine.client.patch(
        f"/journal/{page.entry_id}", json={"title": None}, headers=page.headers
    )
    if probe.status_code == HTTPStatus.CONFLICT and probe.json() == {"detail": _DELETION_PENDING}:
        return []
    return [f"entry {page.entry_id}: a deletion in progress answered {probe.status_code}"]


async def _assert_clean(machine: Machine, page: Page) -> None:
    """After recovery: every copy withdrawn and every record settled."""
    stored = await _stored(machine.factory, page)
    assert stored.gone, machine.trace
    assert machine.vault.remote_copies_carrying(page.canary) == [], machine.trace
    assert stored.obligation not in OPEN_STATES, machine.trace
    assert not set(stored.retractions) & _OPEN_RETRACTIONS, (stored.retractions, machine.trace)


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def machine(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[Machine, None]:
    """One database, one recording vault, every recorder armed, the commit trap installed."""
    await pipeline.close_vault_pipeline_tasks()
    # Every crash cell signs up a fresh account per boundary.
    monkeypatch.setattr(limiter, "enabled", False)
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", _FAST_RETRY_SECONDS)
    monkeypatch.delenv(RESTORE_SUPPRESSION_REQUIRED_ENV_VAR, raising=False)
    monkeypatch.delenv(RESTORE_ID_ENV_VAR, raising=False)
    ledger = Ledger()
    vault = OutageVault(ledger)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.APP_PROVIDER
    assert record_provider_dials(monkeypatch, ledger, classifier_reply=_CLASSIFIED_REPLY)
    record_classifier_inputs(monkeypatch, ledger)
    trap = _install_trap(monkeypatch)
    try:
        yield Machine(
            concurrent_async_client,
            concurrent_session_factory,
            ledger,
            vault,
            trap,
            tmp_path,
            monkeypatch,
        )
    finally:
        await pipeline.close_vault_pipeline_tasks()


# ── The crash cells ──────────────────────────────────────────────────────────


class CrashPath(enum.StrEnum):
    """An operation whose every commit boundary is crashed at."""

    RECLASSIFY = "intimate withdraw"
    DELETE = "delete"
    ERASE_HERE = "erase here only"
    SWEEP = "background sweep"
    ERASE_ACCOUNT = "account erasure"
    REAPPLY = "tombstone reapply"


#: Paths that dial the vault, and so commit differently during an outage.
_DIALLING: Final = frozenset(
    {CrashPath.RECLASSIFY, CrashPath.DELETE, CrashPath.ERASE_HERE, CrashPath.SWEEP}
)

CRASH_CELLS: Final = [
    pytest.param(path, outage, id=f"{path}-{'outage' if outage else 'healthy'}")
    for path in CrashPath
    for outage in (False, True)
    if outage is False or path in _DIALLING
]

_J: Final = "routers.journal."
_DRAFTS: Final = "services.creek_vault_voice_drafts."
_WITHDRAW: Final = "services.creek_vault_withdraw."
_OBLIGATION: Final = "services.journal_withdrawal_obligation."
_BEGIN: Final = "services.journal_vault_withdrawal.begin_deletion"
_ERASURE: Final = "services.account_deletion.delete_account"
_RESTORE: Final = "services.restore_suppression."

#: The commits each cell must have crashed after, by the function that made them.
#: A subset, not the whole list: it names the transitions the claim rests on,
#: so a refactor that moves one of them out of reach of the trap fails here.
MUST_CRASH_AT: Final[dict[tuple[CrashPath, bool], frozenset[str]]] = {
    (CrashPath.RECLASSIFY, False): frozenset(
        {f"{_J}_persist_entry_update", f"{_DRAFTS}_settle", f"{_WITHDRAW}_clear_marker"}
    ),
    (CrashPath.RECLASSIFY, True): frozenset(
        {
            f"{_J}_persist_entry_update",
            f"{_DRAFTS}_settle",
            f"{_OBLIGATION}withdrawal_pending_detail",
        }
    ),
    (CrashPath.DELETE, False): frozenset(
        {
            _BEGIN,
            f"{_DRAFTS}_settle",
            f"{_WITHDRAW}_clear_marker",
            f"{_OBLIGATION}complete_confirmed_delete",
        }
    ),
    (CrashPath.DELETE, True): frozenset(
        {
            _BEGIN,
            f"{_DRAFTS}_settle",
            f"{_OBLIGATION}owe_pending_delete",
            f"{_OBLIGATION}withdrawal_pending_detail",
        }
    ),
    (CrashPath.ERASE_HERE, False): frozenset(
        {_BEGIN, f"{_WITHDRAW}_clear_marker", f"{_OBLIGATION}complete_confirmed_delete"}
    ),
    (CrashPath.ERASE_HERE, True): frozenset(
        {_BEGIN, f"{_DRAFTS}_settle", f"{_OBLIGATION}erase_with_unconfirmed_copy"}
    ),
    (CrashPath.SWEEP, False): frozenset(
        {
            f"{_DRAFTS}_finish_pending_delete",
            f"{_DRAFTS}_settle",
            f"{_WITHDRAW}_clear_marker",
            f"{_DRAFTS}_finish_obligation",
        }
    ),
    (CrashPath.SWEEP, True): frozenset({f"{_DRAFTS}_finish_pending_delete", f"{_DRAFTS}_settle"}),
    (CrashPath.ERASE_ACCOUNT, False): frozenset({_ERASURE}),
    (CrashPath.REAPPLY, False): frozenset(
        {
            f"{_RESTORE}_open_marker",
            _ERASURE,
            f"{_RESTORE}_reapply_entry",
            f"{_RESTORE}_close_marker",
        }
    ),
}

_USER_RULE: Final[dict[CrashPath, Rule]] = {
    CrashPath.RECLASSIFY: Rule.RECLASSIFY,
    CrashPath.DELETE: Rule.DELETE,
    CrashPath.ERASE_HERE: Rule.ERASE_HERE,
    CrashPath.ERASE_ACCOUNT: Rule.ERASE_ACCOUNT,
}


async def _crash_once(m: Machine, path: CrashPath, *, outage: bool, k: int) -> tuple[Page, bool]:
    """One program: a page, the operation killed after commit ``k``; was it killed?"""
    page = await m.write()
    if path is CrashPath.SWEEP:
        await m.outage(on=True)
        await m.delete(page)
        assert page.claim is Claim.PENDING, "the sweep cell needs a deletion in progress"
        await m.outage(on=outage)
        return page, await m.restart(crash_at=k)
    if path is CrashPath.REAPPLY:
        return page, await _restore_after_deletions(m, page, crash_at=k)
    await m.outage(on=outage)
    act: dict[CrashPath, Callable[..., Awaitable[bool]]] = {
        CrashPath.RECLASSIFY: m.reclassify,
        CrashPath.DELETE: m.delete,
        CrashPath.ERASE_HERE: m.erase_here,
        CrashPath.ERASE_ACCOUNT: m.erase_account,
    }
    return page, await act[path](page, crash_at=k)


async def _restore_after_deletions(m: Machine, page: Page, *, crash_at: int | None) -> bool:
    """Snapshot two live pages, delete one and erase the other's account, then restore."""
    erased = await m.write()
    snapshot = await m.snapshot()
    await m.delete(page)
    await m.erase_account(erased)
    return await m.restore(snapshot, crash_at=crash_at)


async def _recover_and_settle(m: Machine, page: Page, path: CrashPath) -> None:
    """The process restarts, the writer retries if it looks undone, the vault comes back."""
    await m.restart()
    await m.outage(on=False)
    rule = _USER_RULE.get(path)
    if rule is not None:
        await m.retry_if_undone(page, rule)
    await m.restart()


@pytest.mark.asyncio
@pytest.mark.parametrize(("path", "outage"), CRASH_CELLS)
async def test_a_crash_after_every_commit_resumes_clean_or_truthfully_pending(
    machine: Machine, path: CrashPath, *, outage: bool
) -> None:
    """Kill the process after commit k, for every k the operation reaches; recover; invariant.

    The invariant is checked after every step of every program, so a crash
    that leaves a re-sendable, resurrectable or falsely-reported copy fails at
    the step it happens. Once the process restarts, the vault returns and the
    writer retries anything that still looks undone, the page must be clean --
    except an erased account's manual vault, which its receipt hands to its
    owner.
    """
    for k in range(1, _MAX_COMMITS_PER_OPERATION):
        page, killed = await _crash_once(machine, path, outage=outage, k=k)
        await _recover_and_settle(machine, page, path)
        if path is CrashPath.ERASE_ACCOUNT:
            assert not (await _stored(machine.factory, page)).account_exists, machine.trace
        elif path is not CrashPath.REAPPLY:
            await _assert_clean(machine, page)
        await machine.check(everything=True)
        if not killed:
            assert k > 1, f"{path} never committed: the cell crashed at nothing"
            missed = MUST_CRASH_AT[path, outage] - machine.trap.crashed_at
            assert missed == frozenset(), f"never crashed after: {sorted(missed)}"
            return
        machine.trace.clear()
        machine.active.clear()
    pytest.fail(f"{path} made {_MAX_COMMITS_PER_OPERATION} commits without finishing")


# ── Replay and restore ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_replaying_durable_runs_after_delete_or_intimate_never_resends_the_canary(
    machine: Machine,
) -> None:
    """Restart after a delete and after an Intimate reclassification: nothing carries the canary.

    The pipeline resume replays a run left in flight for each account and the
    sweep runs twice, during an outage and after it; the invariant (checked
    after each) finds no provider, classifier or vault crossing carrying either
    page's canary from the moment it went.
    """
    deleted = await machine.write()
    intimate = await machine.write()
    await machine.delete(deleted)
    await machine.reclassify(intimate)
    await machine.outage(on=True)
    await machine.restart()
    await machine.outage(on=False)
    await machine.restart()

    assert deleted.gone_since is not None
    assert intimate.gone_since is not None
    since = min(deleted.gone_since, intimate.gone_since)
    assert machine.ledger.since(since, Recorder.VAULT), "the replay dialled nothing at all"
    await _assert_clean(machine, deleted)
    await _assert_clean(machine, intimate)
    own = await machine.client.get(f"/journal/{intimate.entry_id}", headers=intimate.headers)
    assert own.status_code == HTTPStatus.OK
    assert intimate.canary in own.json()["message"], "the owner can still read their page"


@pytest.mark.asyncio
async def test_restore_and_reapply_never_resurrect_a_deleted_entry_or_account(
    machine: Machine,
) -> None:
    """Restore a pre-deletion backup; the resurrection is real until reapply, then gone for good."""
    page = await machine.write()
    erased = await machine.write()
    snapshot = await machine.snapshot()
    await machine.delete(page)
    await machine.erase_account(erased)

    await machine.restore(snapshot)
    await machine.restart()

    gone = await machine.client.get(f"/journal/{page.entry_id}", headers=page.headers)
    assert gone.status_code == HTTPStatus.NOT_FOUND
    login = await machine.client.post(
        "/auth/login", json={"email": erased.email, "password": _PASSWORD}
    )
    assert login.status_code == HTTPStatus.UNAUTHORIZED
    await _assert_clean(machine, page)


@pytest.mark.asyncio
async def test_a_pre_binding_copy_stays_truthfully_unconfirmed_through_every_recovery(
    machine: Machine,
) -> None:
    """#3180: a copy made before destination binding is never reported withdrawn.

    DELETE answers 503 ``vault_withdrawal_unrecorded_vault`` and leaves the
    deletion in progress; a healthy restart cannot finish it; erasing here
    erases the page but records the copy ``unconfirmed`` and bound to no vault,
    and every later restart leaves that record open.
    """
    page = await machine.write()
    async with machine.factory() as session:
        entry = await session.get(JournalEntry, page.entry_id)
        assert entry is not None
        entry.vault_destination = None  # as every copy made before October 7, 2026 is
        session.add(entry)
        await session.commit()

    machine.begin(Rule.DELETE, "a copy made before destination binding")
    refused = await machine.client.delete(f"/journal/{page.entry_id}", headers=page.headers)
    assert refused.json() == {"detail": _UNRECORDED_VAULT}
    page.claim = Claim.PENDING
    await machine.check()
    await machine.restart()
    assert (await _stored(machine.factory, page)).deleting, "no vault may finish this deletion"

    await machine.erase_here(page)
    await machine.restart()
    await machine.restart()

    stored = await _stored(machine.factory, page)
    assert stored.obligation == JournalWithdrawalState.UNCONFIRMED.value
    assert page.claim is Claim.PENDING
    async with machine.factory() as session:
        destination = (
            await session.execute(
                select(JournalWithdrawalObligation.destination).where(
                    col(JournalWithdrawalObligation.journal_entry_id) == page.entry_id
                )
            )
        ).scalar_one()
    assert destination is None, "bound to no vault, so no vault can ever clear it"


# ── Known gaps: restores that forget a request the tombstones do not carry ───

_RESTORE_GAP: Final = (
    "#3214: tombstones carry soft deletes and erasures only, so a restore "
    "forgets an Intimate reclassification and a deletion still in progress"
)


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=_RESTORE_GAP)
@pytest.mark.asyncio
async def test_a_restore_does_not_forget_an_intimate_reclassification(machine: Machine) -> None:
    """Reproducer: a pre-reclassification backup brings the page back Personal, corpus and all."""
    page = await machine.write()
    snapshot = await machine.snapshot()
    await machine.reclassify(page)
    assert page.claim is Claim.CONFIRMED

    await machine.restore(snapshot)


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=_RESTORE_GAP)
@pytest.mark.asyncio
async def test_a_restore_does_not_forget_a_deletion_in_progress(machine: Machine) -> None:
    """Reproducer: a backup from before a 503'd DELETE loses the ``pending_delete`` record."""
    page = await machine.write()
    snapshot = await machine.snapshot()
    await machine.outage(on=True)
    await machine.delete(page)
    assert page.claim is Claim.PENDING

    await machine.restore(snapshot)


# ── Positive controls: the invariant sees what it must ───────────────────────


@pytest.mark.asyncio
async def test_the_invariant_sees_a_resurrection_when_suppression_is_disabled(
    machine: Machine,
) -> None:
    """With entry reapply switched off, a restored deleted page is reported resurrected."""

    async def _suppression_disabled(*_args: object) -> None:
        return None

    page = await machine.write()
    snapshot = await machine.snapshot()
    await machine.delete(page)
    machine.monkeypatch.setattr(restore_suppression, "_reapply_entry", _suppression_disabled)

    with pytest.raises(AssertionError, match="resurrected"):
        await machine.restore(snapshot)


@pytest.mark.asyncio
async def test_the_invariant_sees_a_false_withdrawal_when_withdrawal_is_disabled(
    machine: Machine,
) -> None:
    """With the journal withdrawal switched off, a 204 over a remaining copy is reported."""

    async def _withdrawal_disabled(*_args: object, **_kwargs: object) -> bool:
        return True

    page = await machine.write()
    machine.monkeypatch.setattr(
        journal_vault_withdrawal, "withdraw_journal_copy", _withdrawal_disabled
    )

    with pytest.raises(AssertionError, match="said withdrawn while the vault holds journal:"):
        await machine.delete(page)


@pytest.mark.asyncio
async def test_the_invariant_sees_a_resend_after_deletion(machine: Machine) -> None:
    """A replay that re-sent a deleted page's words would be found at the vault recorder."""
    page = await machine.write()
    await machine.delete(page)
    machine.ledger.record(Recorder.VAULT, "ingest", f"personal {page.canary}")

    found = await violations(machine, machine.active)

    assert found == [
        f"entry {page.entry_id}: {Recorder.VAULT} ingest carried the canary after it went"
    ]


def test_every_crash_cell_names_the_boundaries_it_must_reach() -> None:
    """A cell added without a boundary list, or a list for no cell, fails here."""
    cells = {(param.values[0], param.values[1]) for param in CRASH_CELLS}

    assert cells == set(MUST_CRASH_AT)
    assert all(MUST_CRASH_AT.values())
