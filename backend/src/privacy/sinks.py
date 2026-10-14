"""The sink registry: every place a user's content could come to rest or be sent (#3158).

Four inventories each know part of this already, and none of them knows the
rest:

* the recipient register (:mod:`privacy.recipients`) -- parties outside the
  process;
* the store inventory (``domain.retention_stores.STORES``) -- backups, logs,
  vault volumes, caches and vendor copies;
* the encryption inventory (``services.encryption_inventory.encrypted_columns``)
  -- the database columns that hold ciphertext of what a user wrote;
* the telemetry inventory (``docs/qa/telemetry-egress-inventory.md``) -- every
  operational transport;

plus the detached egress entry points of
``tests/security/test_egress_barrier_totality.py``, the queue-driven doors that
belong to no route.

Each :class:`Sink` row names the inventory rows it mirrors (:class:`SourceRef`),
which journal tiers may reach it, and whether it is inside the primary journal
boundary as claim C07 defines it: the browser, the transport and the Adepthood
server and database -- not Creek, not a model vendor, not a derived corpus and
not content telemetry.

The rows are written by hand on purpose, because the tier and boundary
columns are policy decisions an inventory cannot make. They are then held to
the inventories by :func:`registry_gaps`, which
``tests/security/test_claim_coverage_manifest.py`` runs against all five: a
recipient, store, encrypted column, telemetry transport or detached entry point
with no row fails, and so does a row citing an inventory entry that is gone.

The claim coverage manifest (:mod:`privacy.claim_coverage`) names these ids
when it says which sinks a claim constrains.

Like :mod:`privacy.recipients`, this module is a stdlib-only leaf.
"""

from __future__ import annotations

import enum
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final

from privacy.recipients import RecipientId

# ── Tiers ─────────────────────────────────────────────────────────────────────

#: The journal tier no derivative, vendor or vault may receive (ADR 0005).
INTIMATE: Final = "intimate"
PERSONAL: Final = "personal"
PUBLIC: Final = "public"

#: Every journal tier. A drift test pins this to ``domain.privacy_tier``.
ALL_TIERS: Final = frozenset({INTIMATE, PERSONAL, PUBLIC})
#: The tiers ``domain.privacy_tier.admits_egress`` lets leave the boundary.
EGRESS_TIERS: Final = frozenset({PERSONAL, PUBLIC})
#: No journal content reaches the sink by design (ids, counts, codes, keys).
NO_TIERS: Final[frozenset[str]] = frozenset()


class SinkKind(enum.StrEnum):
    """What sort of place a sink is."""

    NETWORK_RECIPIENT = "network_recipient"
    DB_TABLE = "db_table"
    DB_COLUMN = "db_column"
    BACKUP = "backup"
    VAULT_STORE = "vault_store"
    TELEMETRY = "telemetry"
    CLIENT_STORAGE = "client_storage"
    QUEUE = "queue"
    #: State held only in one process's memory, lost on restart.
    PROCESS_MEMORY = "process_memory"


class Inventory(enum.StrEnum):
    """The inventories the registry is held complete against."""

    RECIPIENT_REGISTER = "recipient_register"
    RETENTION_STORES = "retention_stores"
    ENCRYPTED_COLUMNS = "encrypted_columns"
    TELEMETRY_TRANSPORTS = "telemetry_transports"
    DETACHED_EGRESS = "detached_egress"


@dataclass(frozen=True, slots=True, order=True)
class SourceRef:
    """One row of one inventory, by that inventory's own key."""

    inventory: Inventory
    key: str


class SinkId(enum.StrEnum):
    """Every sink, by stable id. The manifest names sinks by these values."""

    # Network recipients
    OPENAI = "net.openai"
    ANTHROPIC = "net.anthropic"
    CREEK_VAULT_CONNECTED = "net.creek_vault_connected"
    CREEK_VAULT_DEPLOYMENT = "net.creek_vault_deployment"
    CREEK_PROVISIONING = "net.creek_provisioning"
    CREEK_DOWNSTREAM_MODEL = "net.creek_downstream_model"
    GUMROAD = "net.gumroad"
    RESEND = "net.resend"
    SMTP_RELAY = "net.smtp_relay"
    GOOGLE_IDENTITY = "net.google_identity"
    APPLE_IDENTITY = "net.apple_identity"
    HOSTING_PLATFORM = "net.hosting_platform"
    FLY = "net.fly"
    # Backups
    RAILWAY_PLATFORM_BACKUP = "backup.railway_platform"
    # Vault-side stores
    CREEK_VAULT_VOLUME = "vault.creek_volume"
    FLY_VOLUME_SNAPSHOTS = "vault.fly_snapshots"
    CREEK_EMBEDDINGS_CACHE = "vault.creek_embeddings"
    CREEK_LEDGER = "vault.creek_ledger"
    # The device
    CLIENT_DEVICE_CACHE = "client.device_cache"
    # Process memory
    INVALID_LICENSE_THROTTLE = "memory.invalid_license_throttle"
    # Telemetry
    SENTRY_ENVELOPE = "telemetry.sentry_envelope"
    FRONTEND_SENTRY_ENVELOPE = "telemetry.frontend_sentry_envelope"
    ROOT_LOG = "telemetry.root_log"
    ACCESS_LOG = "telemetry.access_log"
    UVICORN_ERROR_LOG = "telemetry.uvicorn_error_log"
    UVICORN_ACCESS_LOG = "telemetry.uvicorn_access_log"
    OUTBOUND_CLIENT_LOG = "telemetry.outbound_client_log"
    RATE_LIMIT_LOG = "telemetry.rate_limit_log"
    VAULT_TELEMETRY = "telemetry.vault_telemetry"
    # Database tables recorded as telemetry transports
    LLM_USAGE_LOG = "db.llmusagelog"
    FEEDBACK_CORRELATION = "db.feedbackreport"
    # Encrypted database columns
    COMPLETION_SUGGESTION_ANCHOR = "db.completionsuggestion.anchor_text"
    COMPLETION_SUGGESTION_LABEL = "db.completionsuggestion.label"
    CORPUS_FRAGMENT_CONTENT = "db.corpusfragment.content"
    FEEDBACK_NOTE_BODY = "db.feedbacknote.body"
    FEEDBACK_REPORT_ACTUAL = "db.feedbackreport.actual"
    FEEDBACK_REPORT_EXPECTED = "db.feedbackreport.expected"
    FEEDBACK_REPORT_INTENT = "db.feedbackreport.intent"
    FEEDBACK_REPORT_SUMMARY = "db.feedbackreport.summary"
    JOURNAL_MESSAGE = "db.journalentry.message"
    JOURNAL_TITLE = "db.journalentry.title"
    MARGINALIA_ANCHOR = "db.marginalia.anchor_text"
    MARGINALIA_ESSAY = "db.marginalia.essay"
    MARGINALIA_NOTE = "db.marginalia.note"
    PRACTICE_SESSION_INSIGHT = "db.practicesession.insight"
    PRACTICE_SESSION_REFLECTION = "db.practicesession.reflection"
    PROMOTED_QUOTE_ANCHOR = "db.promotedquote.anchor_text"
    PROMPT_RESPONSE = "db.promptresponse.response"
    VAULT_CONNECTION = "db.uservaultconfig.api_key"
    # Queues
    VAULT_PIPELINE_RUNS = "queue.vault_pipeline_runs"


@dataclass(frozen=True, slots=True)
class Sink:
    """One place content could reach, the inventory rows behind it, and its policy."""

    id: SinkId
    kind: SinkKind
    sources: tuple[SourceRef, ...]
    #: The journal tiers whose content may reach the sink by design.
    tiers: frozenset[str]
    #: Inside the primary journal boundary C07 defines.
    in_primary_boundary: bool

    def __post_init__(self) -> None:
        """Refuse a row no inventory backs, an unknown tier, or a C07 contradiction."""
        problem = _contradiction(self)
        if problem is not None:
            msg = f"sink {self.id} {problem}"
            raise ValueError(msg)


def _contradiction(sink: Sink) -> str | None:
    """What makes ``sink`` impossible to write down, or ``None``."""
    if not sink.sources:
        return "mirrors no inventory row"
    if not sink.tiers <= ALL_TIERS:
        return "names a tier that does not exist"
    if INTIMATE in sink.tiers and not sink.in_primary_boundary:
        return "is outside the primary boundary but admits intimate"
    return None


# ── The table ─────────────────────────────────────────────────────────────────


def _recipient(rid: RecipientId) -> SourceRef:
    return SourceRef(Inventory.RECIPIENT_REGISTER, rid.value)


def _store(key: str) -> SourceRef:
    return SourceRef(Inventory.RETENTION_STORES, key)


def _column(qualified: str) -> SourceRef:
    return SourceRef(Inventory.ENCRYPTED_COLUMNS, qualified)


def _transport(name: str) -> SourceRef:
    return SourceRef(Inventory.TELEMETRY_TRANSPORTS, name)


_EMAIL_RELAY: Final = _transport("Email relay")
_MODEL_VENDOR_COPIES: Final = _store("model_vendor_copies")


def _outside(sid: SinkId, kind: SinkKind, tiers: frozenset[str], *sources: SourceRef) -> Sink:
    """A sink beyond the primary boundary: never ``intimate``."""
    return Sink(sid, kind, sources, tiers, in_primary_boundary=False)


def _inside(sid: SinkId, kind: SinkKind, tiers: frozenset[str], *sources: SourceRef) -> Sink:
    """A sink within the browser, transport, server and database of C07."""
    return Sink(sid, kind, sources, tiers, in_primary_boundary=True)


def _encrypted(sid: SinkId, tiers: frozenset[str]) -> Sink:
    """An ``EncryptedString`` column: the id spells its ``table.column``."""
    return _inside(sid, SinkKind.DB_COLUMN, tiers, _column(sid.value.removeprefix("db.")))


_NET: Final = SinkKind.NETWORK_RECIPIENT
_TELEMETRY: Final = SinkKind.TELEMETRY
_VAULT: Final = SinkKind.VAULT_STORE

_ROWS: Final[tuple[Sink, ...]] = (
    # Language-model providers, reached only with the writer's key; the vendor's
    # own copies of prompts and completions live with them.
    _outside(
        SinkId.OPENAI, _NET, EGRESS_TIERS, _recipient(RecipientId.OPENAI), _MODEL_VENDOR_COPIES
    ),
    _outside(
        SinkId.ANTHROPIC,
        _NET,
        EGRESS_TIERS,
        _recipient(RecipientId.ANTHROPIC),
        _MODEL_VENDOR_COPIES,
    ),
    # A vault the user connected, including one they operate themselves.
    _outside(
        SinkId.CREEK_VAULT_CONNECTED,
        _NET,
        EGRESS_TIERS,
        _recipient(RecipientId.CREEK_VAULT_CONNECTED),
        _store("manual_vaults"),
    ),
    _outside(
        SinkId.CREEK_VAULT_DEPLOYMENT,
        _NET,
        EGRESS_TIERS,
        _recipient(RecipientId.CREEK_VAULT_DEPLOYMENT),
    ),
    _outside(SinkId.CREEK_PROVISIONING, _NET, NO_TIERS, _recipient(RecipientId.CREEK_PROVISIONING)),
    _outside(
        SinkId.CREEK_DOWNSTREAM_MODEL,
        _NET,
        EGRESS_TIERS,
        _recipient(RecipientId.CREEK_DOWNSTREAM_MODEL),
    ),
    _outside(SinkId.GUMROAD, _NET, NO_TIERS, _recipient(RecipientId.GUMROAD)),
    _outside(SinkId.RESEND, _NET, NO_TIERS, _recipient(RecipientId.RESEND), _EMAIL_RELAY),
    _outside(SinkId.SMTP_RELAY, _NET, NO_TIERS, _recipient(RecipientId.SMTP_RELAY), _EMAIL_RELAY),
    _outside(SinkId.GOOGLE_IDENTITY, _NET, NO_TIERS, _recipient(RecipientId.GOOGLE_IDENTITY)),
    _outside(SinkId.APPLE_IDENTITY, _NET, NO_TIERS, _recipient(RecipientId.APPLE_IDENTITY)),
    # The host of the server and its database *is* the primary boundary.
    _inside(SinkId.HOSTING_PLATFORM, _NET, ALL_TIERS, _recipient(RecipientId.HOSTING_PLATFORM)),
    _outside(SinkId.FLY, _NET, EGRESS_TIERS, _recipient(RecipientId.FLY)),
    # Backups are whole copies of the primary database, intimate rows included.
    # Their expiry and restore suppression are C21's, not C07's.
    _inside(
        SinkId.RAILWAY_PLATFORM_BACKUP,
        SinkKind.BACKUP,
        ALL_TIERS,
        _store("railway_platform_backup"),
    ),
    _outside(SinkId.CREEK_VAULT_VOLUME, _VAULT, EGRESS_TIERS, _store("creek_vault_volume")),
    _outside(SinkId.FLY_VOLUME_SNAPSHOTS, _VAULT, EGRESS_TIERS, _store("fly_volume_snapshots")),
    _outside(SinkId.CREEK_EMBEDDINGS_CACHE, _VAULT, EGRESS_TIERS, _store("creek_embeddings_cache")),
    _outside(SinkId.CREEK_LEDGER, _VAULT, EGRESS_TIERS, _store("creek_ledger")),
    _inside(
        SinkId.CLIENT_DEVICE_CACHE,
        SinkKind.CLIENT_STORAGE,
        ALL_TIERS,
        _store("client_device_cache"),
    ),
    _inside(
        SinkId.INVALID_LICENSE_THROTTLE,
        SinkKind.PROCESS_MEMORY,
        NO_TIERS,
        _store("invalid_license_throttle"),
    ),
    # Telemetry: content telemetry is outside C07's boundary, and none is admitted.
    _outside(
        SinkId.SENTRY_ENVELOPE,
        _TELEMETRY,
        NO_TIERS,
        _transport("Backend Sentry"),
        _recipient(RecipientId.SENTRY),
    ),
    _outside(SinkId.FRONTEND_SENTRY_ENVELOPE, _TELEMETRY, NO_TIERS, _transport("Frontend Sentry")),
    _outside(
        SinkId.ROOT_LOG,
        _TELEMETRY,
        NO_TIERS,
        _transport("Root log stream → stderr → Railway log collection"),
        _store("application_logs"),
    ),
    _outside(SinkId.ACCESS_LOG, _TELEMETRY, NO_TIERS, _transport("adepthood.access")),
    _outside(SinkId.UVICORN_ERROR_LOG, _TELEMETRY, NO_TIERS, _transport("uvicorn / uvicorn.error")),
    _outside(SinkId.UVICORN_ACCESS_LOG, _TELEMETRY, NO_TIERS, _transport("uvicorn.access")),
    _outside(SinkId.OUTBOUND_CLIENT_LOG, _TELEMETRY, NO_TIERS, _transport("httpx / httpx2")),
    _outside(SinkId.RATE_LIMIT_LOG, _TELEMETRY, NO_TIERS, _transport("slowapi")),
    _outside(SinkId.VAULT_TELEMETRY, _TELEMETRY, NO_TIERS, _transport("Creek vault telemetry")),
    _inside(SinkId.LLM_USAGE_LOG, SinkKind.DB_TABLE, NO_TIERS, _transport("LLM metering")),
    _inside(
        SinkId.FEEDBACK_CORRELATION,
        SinkKind.DB_TABLE,
        NO_TIERS,
        _transport("Feedback correlation id"),
    ),
    # Encrypted columns. What a person wrote, in any tier, stays in the database;
    # model-derived text exists only for the tiers a model may read; a derived
    # corpus is outside C07's boundary and so never intimate (C09).
    _encrypted(SinkId.COMPLETION_SUGGESTION_ANCHOR, EGRESS_TIERS),
    _encrypted(SinkId.COMPLETION_SUGGESTION_LABEL, EGRESS_TIERS),
    _outside(
        SinkId.CORPUS_FRAGMENT_CONTENT,
        SinkKind.DB_COLUMN,
        EGRESS_TIERS,
        _column("corpusfragment.content"),
    ),
    # Feedback text is its own channel, never a journal tier.
    _encrypted(SinkId.FEEDBACK_NOTE_BODY, NO_TIERS),
    _encrypted(SinkId.FEEDBACK_REPORT_ACTUAL, NO_TIERS),
    _encrypted(SinkId.FEEDBACK_REPORT_EXPECTED, NO_TIERS),
    _encrypted(SinkId.FEEDBACK_REPORT_INTENT, NO_TIERS),
    _encrypted(SinkId.FEEDBACK_REPORT_SUMMARY, NO_TIERS),
    _encrypted(SinkId.JOURNAL_MESSAGE, ALL_TIERS),
    _encrypted(SinkId.JOURNAL_TITLE, ALL_TIERS),
    _encrypted(SinkId.MARGINALIA_ANCHOR, EGRESS_TIERS),
    _encrypted(SinkId.MARGINALIA_ESSAY, EGRESS_TIERS),
    _encrypted(SinkId.MARGINALIA_NOTE, EGRESS_TIERS),
    _encrypted(SinkId.PRACTICE_SESSION_INSIGHT, ALL_TIERS),
    _encrypted(SinkId.PRACTICE_SESSION_REFLECTION, ALL_TIERS),
    _encrypted(SinkId.PROMOTED_QUOTE_ANCHOR, ALL_TIERS),
    _encrypted(SinkId.PROMPT_RESPONSE, ALL_TIERS),
    _encrypted(SinkId.VAULT_CONNECTION, NO_TIERS),
    # The durable pipeline-run rows both detached doors replay. Content-free rows.
    _inside(
        SinkId.VAULT_PIPELINE_RUNS,
        SinkKind.QUEUE,
        NO_TIERS,
        SourceRef(Inventory.DETACHED_EGRESS, "the detached ontologization ladder"),
        SourceRef(Inventory.DETACHED_EGRESS, "the boot-time resume of durable pipeline runs"),
    ),
)

#: The registry, keyed by id. Read-only: nothing that imports it can extend it.
SINKS: Final[Mapping[SinkId, Sink]] = MappingProxyType({row.id: row for row in _ROWS})


# ── Completeness against the inventories ──────────────────────────────────────


@dataclass(frozen=True, slots=True)
class RegistryGaps:
    """What the registry and the inventories disagree on."""

    #: Inventory rows no sink mirrors: a sink nobody registered.
    unregistered: frozenset[SourceRef]
    #: Sink sources no inventory still lists: a row gone stale.
    stale: frozenset[SourceRef]

    @property
    def clean(self) -> bool:
        """Whether the registry and every inventory agree."""
        return not (self.unregistered or self.stale)


def registry_gaps(
    sinks: Iterable[Sink], inventories: Mapping[Inventory, frozenset[str]]
) -> RegistryGaps:
    """Reconcile ``sinks`` against each inventory's keys, in both directions.

    An inventory missing from ``inventories`` is read as empty, so every source
    citing it is stale: a gatherer that silently stopped reading an inventory
    fails rather than passing over nothing.
    """
    cited = frozenset(source for sink in sinks for source in sink.sources)
    listed = frozenset(
        SourceRef(inventory, key) for inventory, keys in inventories.items() for key in keys
    )
    return RegistryGaps(unregistered=listed - cited, stale=cited - listed)
