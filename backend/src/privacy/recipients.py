"""The recipient register: every party outside this process that receives a user's data (#3065).

One row per party. Each row says what the code can establish -- which dial
sites reach the party, which hosts and endpoint variables name it, what kinds of
data it is sent, under which trigger, and through whose account -- and leaves
every fact only the operator can establish at :data:`UNVERIFIED`:

* the purpose and retention the vendor agreed to,
* the vendor-side training setting,
* the agreement, its expiry and who owns the relationship.

Those are never filled in from documentation or memory. A value is recorded
only with an ``evidence_ref`` to the receipt that proves it, and the dataclass
refuses one without the other.

The table is tested against the source, not against itself:
``tests/security/test_recipient_register.py`` sweeps ``backend/src`` for every
HTTP client, SDK client, SMTP session, JWKS fetch, DNS lookup and
error-monitor call, and fails when one has no row, when a row claims a site
that no longer exists, or when two rows claim the same site outside
:data:`SHARED_FACTORY_SITES`.

The module is a stdlib-only leaf. It must be importable by the boot check in
``main`` and by the dial in ``services.botmason`` without importing either.
"""

from __future__ import annotations

import enum
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date
from types import MappingProxyType
from typing import ClassVar, Final
from urllib.parse import urlsplit

#: The value of every owner-only field until a receipt proves otherwise.
UNVERIFIED: Final = "UNVERIFIED"

_HTTPS: Final = "https"
_HTTPS_PORT: Final = 443


class RecipientId(enum.StrEnum):
    """Every party that receives anything of a user's, by stable id."""

    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    CREEK_VAULT_CONNECTED = "creek_vault_connected"
    CREEK_VAULT_DEPLOYMENT = "creek_vault_deployment"
    CREEK_PROVISIONING = "creek_provisioning"
    CREEK_DOWNSTREAM_MODEL = "creek_downstream_model"
    GUMROAD = "gumroad"
    RESEND = "resend"
    SMTP_RELAY = "smtp_relay"
    SENTRY = "sentry"
    GOOGLE_IDENTITY = "google_identity"
    APPLE_IDENTITY = "apple_identity"
    HOSTING_PLATFORM = "hosting_platform"
    OFFHOST_BACKUP = "offhost_backup"
    FLY = "fly"


class Role(enum.StrEnum):
    """The party's provisional relationship to the data; the owner confirms each."""

    PROCESSOR = "processor"
    SUB_PROCESSOR = "sub_processor"
    INDEPENDENT_CONTROLLER = "independent_controller"
    INFRASTRUCTURE = "infrastructure"


class DataClass(enum.StrEnum):
    """What kind of thing a scope sends."""

    CONTENT = "content"
    METADATA = "metadata"
    CREDENTIAL = "credential"
    NONE = "none"


class ScopeKind(enum.StrEnum):
    """Whose account or configuration a flow of data runs under."""

    #: The operator's own account with the vendor.
    OPERATOR_ACCOUNT = "operator_account"
    #: The user's own account, reached with a key or URL the user supplied.
    USER_OWNED_ACCOUNT = "user_owned_account"
    #: An endpoint the deployment's configuration names, arranged by the operator.
    DEPLOYMENT_CONFIGURED = "deployment_configured"
    #: A seam for the test lanes that a production boot refuses.
    TEST_SEAM = "test_seam"


#: Scope kinds whose terms the operator arranges, and so can attest to.
OPERATOR_ARRANGED: Final = frozenset({ScopeKind.OPERATOR_ACCOUNT, ScopeKind.DEPLOYMENT_CONFIGURED})


@dataclass(frozen=True, slots=True)
class OwnerFields:
    """Facts only the operator can attest, each :data:`UNVERIFIED` until evidenced."""

    ATTESTED_TEXT_FIELDS: ClassVar[tuple[str, ...]] = (
        "purpose",
        "retention",
        "training_setting",
        "agreement_ref",
        "responsible_owner",
    )

    purpose: str = UNVERIFIED
    retention: str = UNVERIFIED
    training_setting: str = UNVERIFIED
    agreement_ref: str = UNVERIFIED
    responsible_owner: str = UNVERIFIED
    evidence_ref: str = UNVERIFIED
    agreement_expires: date | None = None
    reviewed_at: date | None = None

    def __post_init__(self) -> None:
        """Refuse an attested value that carries no evidence reference."""
        if self.evidence_ref == UNVERIFIED and self.attests_anything:
            msg = "an attested owner field requires an evidence_ref"
            raise ValueError(msg)

    @property
    def attests_anything(self) -> bool:
        """Whether any field records more than :data:`UNVERIFIED`."""
        texts = (getattr(self, name) for name in self.ATTESTED_TEXT_FIELDS)
        dates = (self.agreement_expires, self.reviewed_at)
        return any(text != UNVERIFIED for text in texts) or any(d is not None for d in dates)


@dataclass(frozen=True, slots=True)
class Scope:
    """One flow of data to a recipient: what it carries, when, and through whose account."""

    kind: ScopeKind
    data_classes: frozenset[DataClass]
    trigger: str
    conditional_on: str | None = None
    owner: OwnerFields = field(default_factory=OwnerFields)

    @property
    def blanket_guarantee_eligible(self) -> bool:
        """Whether the operator's guarantee can cover this flow at all.

        Derived, never stored: only the operator's own account can carry the
        operator's promise. A user's own vendor account is governed by that
        user's settings, which the operator cannot see.
        """
        return self.kind is ScopeKind.OPERATOR_ACCOUNT

    @property
    def carries_content(self) -> bool:
        """Whether this flow sends what a user wrote."""
        return DataClass.CONTENT in self.data_classes


@dataclass(frozen=True, slots=True, order=True)
class DialSite:
    """Where the code opens a connection: module, enclosing qualname, resolved constructor."""

    module: str
    function: str
    constructor: str


@dataclass(frozen=True, slots=True)
class Recipient:
    """One party outside this process and everything the code knows about reaching it."""

    id: RecipientId
    legal_name: str
    #: The word a policy lead-in would have to use to name this party.
    short_name: str
    role: Role
    scopes: tuple[Scope, ...]
    hosts: frozenset[str] = frozenset()
    endpoint_env_vars: tuple[str, ...] = ()
    dial_sites: frozenset[DialSite] = frozenset()
    egress_leaves: frozenset[tuple[str, str]] = frozenset()
    approved_models: frozenset[str] = frozenset()
    #: The privacy-policy lead-in that discloses this party, or ``None``.
    policy_lead_in: str | None = None

    def __post_init__(self) -> None:
        """Refuse a row nobody can identify or that describes no traffic."""
        if not self.legal_name.strip():
            msg = "a recipient needs a legal_name"
            raise ValueError(msg)
        if not self.scopes:
            msg = "a recipient needs at least one scope"
            raise ValueError(msg)

    @property
    def carries_content(self) -> bool:
        """Whether any flow to this party sends what a user wrote."""
        return any(scope.carries_content for scope in self.scopes)


# ── Provider endpoints ────────────────────────────────────────────────────────

OPENAI_PROVIDER: Final = "openai"
ANTHROPIC_PROVIDER: Final = "anthropic"

#: The only base URL each provider SDK may be pointed at in production.
REGISTERED_PROVIDER_BASE_URLS: Final[Mapping[str, str]] = MappingProxyType(
    {
        OPENAI_PROVIDER: "https://api.openai.com/v1",
        ANTHROPIC_PROVIDER: "https://api.anthropic.com",
    }
)

#: The variable each SDK reads, implicitly, when built without ``base_url``.
PROVIDER_BASE_URL_ENV_VARS: Final[Mapping[str, str]] = MappingProxyType(
    {OPENAI_PROVIDER: "OPENAI_BASE_URL", ANTHROPIC_PROVIDER: "ANTHROPIC_BASE_URL"}
)

#: Which register row each dispatch-registry provider name is.
PROVIDER_RECIPIENTS: Final[Mapping[str, RecipientId]] = MappingProxyType(
    {OPENAI_PROVIDER: RecipientId.OPENAI, ANTHROPIC_PROVIDER: RecipientId.ANTHROPIC}
)


def _endpoint_identity(value: str) -> tuple[str, str | None, int | None, bool] | None:
    """Scheme, host, explicit non-default port and "no userinfo" -- or ``None`` if unparseable."""
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return None
    no_userinfo = parts.username is None and parts.password is None
    return parts.scheme, parts.hostname, None if port == _HTTPS_PORT else port, no_userinfo


def _is_registered_endpoint(value: str, registered: str) -> bool:
    """Whether ``value`` addresses exactly the registered scheme, host and port."""
    return _endpoint_identity(value) == (_HTTPS, urlsplit(registered).hostname, None, True)


def base_url_override_violations(environ: Mapping[str, str]) -> tuple[str, ...]:
    """Name each provider base-URL variable in ``environ`` that leaves the register.

    Unset or blank is no override. Anything else must be ``https`` to the
    registered host on the default port, with no userinfo -- the host is
    parsed, so ``https://api.openai.com@evil.example`` is ``evil.example``.

    Returns variable NAMES only, never values: a value can carry a credential.
    """
    violations: list[str] = []
    for provider, name in PROVIDER_BASE_URL_ENV_VARS.items():
        value = environ.get(name, "").strip()
        if value and not _is_registered_endpoint(value, REGISTERED_PROVIDER_BASE_URLS[provider]):
            violations.append(name)
    return tuple(violations)


# ── The table ─────────────────────────────────────────────────────────────────

_BOTMASON_LEAF: Final = ("services.botmason", "generate_response")
_CONNECTED_VAULT_FACTORY: Final = ("services.creek_vault_client", "build_connected_vault_client")
_DEPLOYMENT_VAULT_FACTORY: Final = ("services.creek_vault_client", "build_creek_vault_client")
_POOLED_VAULT_SITE: Final = DialSite(
    "services.creek_vault_client", "_build_pooled_vault_client", "httpx.AsyncClient"
)
_JWKS_SITE: Final = DialSite("services.oidc", "build_bounded_jwk_client", "jwt.PyJWKClient")

_CONTENT: Final = frozenset({DataClass.CONTENT, DataClass.METADATA})
_CONTENT_AND_KEY: Final = frozenset({DataClass.CONTENT, DataClass.METADATA, DataClass.CREDENTIAL})
_METADATA: Final = frozenset({DataClass.METADATA})
_NOTHING: Final = frozenset({DataClass.NONE})

#: Lead-ins one privacy-policy paragraph shares between several rows.
_EMAIL_RELAY_LEAD_IN: Final = "An email relay (Resend, or the deployment's own mail server)"
_IDENTITY_LEAD_IN: Final = "Google and Apple"


def _llm_provider(
    rid: RecipientId, legal_name: str, provider: str, site: DialSite, models: frozenset[str]
) -> Recipient:
    """A language-model provider: operator key, user key (BYOK), and the e2e probe."""
    return Recipient(
        id=rid,
        legal_name=legal_name,
        short_name=legal_name,
        role=Role.PROCESSOR,
        hosts=frozenset({urlsplit(REGISTERED_PROVIDER_BASE_URLS[provider]).hostname or ""}),
        endpoint_env_vars=(PROVIDER_BASE_URL_ENV_VARS[provider],),
        dial_sites=frozenset({site}),
        egress_leaves=frozenset({_BOTMASON_LEAF}),
        approved_models=models,
        policy_lead_in="The language-model provider",
        scopes=(
            Scope(
                ScopeKind.OPERATOR_ACCOUNT,
                _CONTENT,
                f"BOTMASON_PROVIDER={provider} with the server's LLM_API_KEY",
                conditional_on="BOTMASON_PROVIDER",
            ),
            Scope(
                ScopeKind.USER_OWNED_ACCOUNT,
                _CONTENT_AND_KEY,
                f"an X-LLM-API-Key header carrying a {legal_name} key (BYOK)",
            ),
            Scope(
                ScopeKind.TEST_SEAM,
                _CONTENT,
                "a prompt carrying the armed provider-probe token; refused in production",
                conditional_on="BOTMASON_PROVIDER_PROBE_TOKEN",
            ),
        ),
    )


_ROWS: Final[tuple[Recipient, ...]] = (
    _llm_provider(
        RecipientId.OPENAI,
        "OpenAI",
        OPENAI_PROVIDER,
        DialSite("services.botmason", "_call_openai", "openai.AsyncOpenAI"),
        frozenset({"gpt-4o-mini", "gpt-4o", "gpt-4-turbo"}),
    ),
    _llm_provider(
        RecipientId.ANTHROPIC,
        "Anthropic",
        ANTHROPIC_PROVIDER,
        DialSite("services.botmason", "_call_anthropic", "anthropic.AsyncAnthropic"),
        frozenset(
            {
                "claude-haiku-4-5-20251001",
                "claude-sonnet-5",
                "claude-opus-5",
                "claude-opus-4-7",
                "claude-sonnet-4-6",
            }
        ),
    ),
    Recipient(
        id=RecipientId.CREEK_VAULT_CONNECTED,
        legal_name="The user's own connected Creek Vault",
        short_name="connected vault",
        role=Role.INDEPENDENT_CONTROLLER,
        dial_sites=frozenset(
            {
                _POOLED_VAULT_SITE,
                DialSite(
                    "services.creek_vault_pinned_transport",
                    "build_pinned_destination_transport",
                    "httpx.AsyncHTTPTransport",
                ),
                DialSite(
                    "services.creek_vault_url_resolution",
                    "resolve_host_addresses",
                    "*.getaddrinfo",
                ),
            }
        ),
        egress_leaves=frozenset(
            {
                _CONNECTED_VAULT_FACTORY,
                ("services.creek_vault_url_resolution", "resolve_host_addresses"),
            }
        ),
        policy_lead_in="Your Creek Vault",
        scopes=(
            Scope(
                ScopeKind.USER_OWNED_ACCOUNT,
                _CONTENT_AND_KEY,
                "a vault URL and key the user connected in settings",
            ),
        ),
    ),
    Recipient(
        id=RecipientId.CREEK_VAULT_DEPLOYMENT,
        legal_name="The deployment's Creek Vault",
        short_name="deployment vault",
        role=Role.PROCESSOR,
        endpoint_env_vars=("CREEK_VAULT_URL",),
        dial_sites=frozenset({_POOLED_VAULT_SITE}),
        egress_leaves=frozenset({_DEPLOYMENT_VAULT_FACTORY}),
        policy_lead_in="Your Creek Vault",
        scopes=(
            Scope(
                ScopeKind.DEPLOYMENT_CONFIGURED,
                _CONTENT,
                "CREEK_VAULT_URL set, for the account CREEK_VAULT_OWNER_USER_ID names",
                conditional_on="CREEK_VAULT_URL",
            ),
        ),
    ),
    Recipient(
        id=RecipientId.CREEK_PROVISIONING,
        legal_name="Creek provisioning control plane",
        short_name="Creek provisioning",
        role=Role.PROCESSOR,
        endpoint_env_vars=("CREEK_PROVISIONING_URL",),
        dial_sites=frozenset(
            {
                DialSite(
                    "services.creek_provisioning_client",
                    "get_creek_provisioning_client",
                    "httpx.AsyncClient",
                )
            }
        ),
        policy_lead_in="Your Creek Vault",
        scopes=(
            Scope(
                ScopeKind.DEPLOYMENT_CONFIGURED,
                _METADATA,
                "a managed-vault activation, retry, status read or teardown",
                conditional_on="CREEK_PROVISIONING_URL",
            ),
        ),
    ),
    Recipient(
        id=RecipientId.CREEK_DOWNSTREAM_MODEL,
        legal_name="The Creek Vault's own model provider",
        short_name="Creek Vault's model provider",
        role=Role.SUB_PROCESSOR,
        policy_lead_in="Your Creek Vault's model provider",
        scopes=(
            Scope(
                ScopeKind.DEPLOYMENT_CONFIGURED,
                _CONTENT,
                "the vault classifies or reflects with a cloud model",
                conditional_on="CREEK_CLOUD_CONSENT (Creek deployment)",
            ),
        ),
    ),
    Recipient(
        id=RecipientId.GUMROAD,
        legal_name="Gumroad",
        short_name="Gumroad",
        role=Role.INDEPENDENT_CONTROLLER,
        hosts=frozenset({"api.gumroad.com"}),
        dial_sites=frozenset(
            {DialSite("integrations.gumroad", "verify_license", "httpx.AsyncClient")}
        ),
        egress_leaves=frozenset(
            {
                ("integrations.gumroad", "verify_license"),
                ("domain.entitlements", "verify_aptitude_license"),
            }
        ),
        policy_lead_in="Gumroad",
        scopes=(
            Scope(
                ScopeKind.OPERATOR_ACCOUNT,
                frozenset({DataClass.METADATA, DataClass.CREDENTIAL}),
                "licence verification at signup",
                conditional_on="GUMROAD_API_TOKEN",
            ),
        ),
    ),
    Recipient(
        id=RecipientId.RESEND,
        legal_name="Resend",
        short_name="Resend",
        role=Role.PROCESSOR,
        hosts=frozenset({"api.resend.com"}),
        dial_sites=frozenset(
            {DialSite("services.email", "ResendEmailSender.send", "httpx.AsyncClient")}
        ),
        policy_lead_in=_EMAIL_RELAY_LEAD_IN,
        scopes=(
            Scope(
                ScopeKind.OPERATOR_ACCOUNT,
                _METADATA,
                "a password-reset or operator alert email",
                conditional_on="EMAIL_BACKEND=resend",
            ),
        ),
    ),
    Recipient(
        id=RecipientId.SMTP_RELAY,
        legal_name="The deployment's SMTP relay",
        short_name="SMTP relay",
        role=Role.PROCESSOR,
        endpoint_env_vars=("SMTP_HOST",),
        dial_sites=frozenset(
            {DialSite("services.email", "SmtpEmailSender._connect", "smtplib.SMTP")}
        ),
        policy_lead_in=_EMAIL_RELAY_LEAD_IN,
        scopes=(
            Scope(
                ScopeKind.DEPLOYMENT_CONFIGURED,
                _METADATA,
                "a password-reset or operator alert email",
                conditional_on="EMAIL_BACKEND=smtp",
            ),
        ),
    ),
    Recipient(
        id=RecipientId.SENTRY,
        legal_name="Sentry",
        short_name="Sentry",
        role=Role.PROCESSOR,
        endpoint_env_vars=("SENTRY_DSN",),
        dial_sites=frozenset(
            {
                DialSite("sentry", "init_error_monitoring", "sentry_sdk.init"),
                DialSite("sentry", "capture_exception", "sentry_sdk.capture_exception"),
            }
        ),
        policy_lead_in="Sentry",
        scopes=(
            Scope(
                ScopeKind.DEPLOYMENT_CONFIGURED,
                _METADATA,
                "an unhandled exception, scrubbed to type, frames and request id",
                conditional_on="SENTRY_DSN",
            ),
        ),
    ),
    Recipient(
        id=RecipientId.GOOGLE_IDENTITY,
        legal_name="Google",
        short_name="Google",
        role=Role.INDEPENDENT_CONTROLLER,
        hosts=frozenset({"www.googleapis.com", "accounts.google.com"}),
        dial_sites=frozenset({_JWKS_SITE}),
        policy_lead_in=_IDENTITY_LEAD_IN,
        scopes=(
            Scope(
                ScopeKind.OPERATOR_ACCOUNT,
                _NOTHING,
                "a JWKS fetch to verify a Google sign-in token",
            ),
        ),
    ),
    Recipient(
        id=RecipientId.APPLE_IDENTITY,
        legal_name="Apple",
        short_name="Apple",
        role=Role.INDEPENDENT_CONTROLLER,
        hosts=frozenset({"appleid.apple.com"}),
        dial_sites=frozenset({_JWKS_SITE}),
        policy_lead_in=_IDENTITY_LEAD_IN,
        scopes=(
            Scope(
                ScopeKind.OPERATOR_ACCOUNT,
                _NOTHING,
                "a JWKS fetch to verify a Sign in with Apple token",
            ),
        ),
    ),
    Recipient(
        id=RecipientId.HOSTING_PLATFORM,
        legal_name="Railway",
        short_name="Railway",
        role=Role.INFRASTRUCTURE,
        policy_lead_in="Railway",
        scopes=(
            Scope(
                ScopeKind.OPERATOR_ACCOUNT,
                _CONTENT_AND_KEY,
                "hosts the API, the database of encrypted entries, and the key",
            ),
        ),
    ),
    Recipient(
        id=RecipientId.OFFHOST_BACKUP,
        legal_name="The operator's off-platform backup storage",
        short_name="kept off the hosting platform",
        role=Role.INFRASTRUCTURE,
        policy_lead_in="Encrypted copies kept off the hosting platform by the operator",
        scopes=(
            Scope(
                ScopeKind.OPERATOR_ACCOUNT,
                _CONTENT,
                "the operator's weekly, manual, encrypted pg_dump (DEPLOYMENT.md); "
                "where it is kept is undecided (#3063)",
            ),
        ),
    ),
    Recipient(
        id=RecipientId.FLY,
        legal_name="Fly.io",
        short_name="Fly",
        role=Role.INFRASTRUCTURE,
        policy_lead_in="Fly.io",
        scopes=(
            Scope(
                ScopeKind.DEPLOYMENT_CONFIGURED,
                _CONTENT,
                "hosts a provider-managed vault Adepthood activated",
                conditional_on="CREEK_PROVISIONING_URL",
            ),
        ),
    ),
)

#: The register, keyed by id. Read-only: nothing that imports it can extend it.
RECIPIENTS: Final[Mapping[RecipientId, Recipient]] = MappingProxyType(
    {row.id: row for row in _ROWS}
)

#: Dial sites more than one row may claim, and exactly which rows.
#:
#: The JWKS factory is told apart by the URL each identity provider hands it;
#: the pooled vault client by the public factory each kind of vault is built
#: through. Any other multiply-claimed site is a register defect.
SHARED_FACTORY_SITES: Final[Mapping[DialSite, frozenset[RecipientId]]] = MappingProxyType(
    {
        _JWKS_SITE: frozenset({RecipientId.GOOGLE_IDENTITY, RecipientId.APPLE_IDENTITY}),
        _POOLED_VAULT_SITE: frozenset(
            {RecipientId.CREEK_VAULT_CONNECTED, RecipientId.CREEK_VAULT_DEPLOYMENT}
        ),
    }
)


# ── The claim gate ────────────────────────────────────────────────────────────


class ClaimId(enum.StrEnum):
    """Public claims this register supplies the facts for."""

    #: No vendor trains a model on a user's writing.
    C04 = "C04"
    #: A user's data is not sold.
    C05 = "C05"
    #: Each processor uses the data only for its stated purpose.
    C06 = "C06"


class BlockReason(enum.StrEnum):
    """Why a claim may not be advertised. Enum-only: a reason never carries prose."""

    UNVERIFIED_TRAINING = "unverified_training"
    UNVERIFIED_RETENTION = "unverified_retention"
    UNVERIFIED_AGREEMENT = "unverified_agreement"
    UNVERIFIED_PURPOSE = "unverified_purpose"
    AGREEMENT_EXPIRED = "agreement_expired"
    BYOK_SCOPE_IN_USE = "byok_scope_in_use"
    MODEL_NOT_APPROVED = "model_not_approved"
    PROVIDER_SET_CHANGED = "provider_set_changed"


@dataclass(frozen=True, slots=True)
class Block:
    """One reason a claim is blocked, and which recipient (and model) it is about."""

    recipient: RecipientId | None
    reason: BlockReason
    model: str | None = None


@dataclass(frozen=True, slots=True)
class ClaimReadiness:
    """The gate's answer for one claim.

    ``allowed`` means no blocker the code can see -- never certification. The
    vendor terms behind each attested field are checked by a person (B24).
    """

    claim: ClaimId
    allowed: bool
    blocks: tuple[Block, ...]


_Predicate = Callable[[Recipient, Scope, date], tuple[BlockReason, ...]]


def _content_terms(_r: Recipient, scope: Scope, _today: date) -> tuple[BlockReason, ...]:
    """Training, retention and agreement must be attested for any content flow."""
    if not scope.carries_content:
        return ()
    owner = scope.owner
    pairs = (
        (owner.training_setting, BlockReason.UNVERIFIED_TRAINING),
        (owner.retention, BlockReason.UNVERIFIED_RETENTION),
        (owner.agreement_ref, BlockReason.UNVERIFIED_AGREEMENT),
    )
    return tuple(reason for value, reason in pairs if value == UNVERIFIED)


def _agreement_current(_r: Recipient, scope: Scope, today: date) -> tuple[BlockReason, ...]:
    """An agreement that has lapsed is no agreement."""
    expires = scope.owner.agreement_expires
    if expires is not None and expires < today:
        return (BlockReason.AGREEMENT_EXPIRED,)
    return ()


def _purpose_attested(_r: Recipient, scope: Scope, _today: date) -> tuple[BlockReason, ...]:
    """Every processor's purpose, content or not, is part of the purpose claim."""
    if scope.owner.purpose == UNVERIFIED:
        return (BlockReason.UNVERIFIED_PURPOSE,)
    return ()


_CLAIM_PREDICATES: Final[Mapping[ClaimId, tuple[_Predicate, ...]]] = MappingProxyType(
    {
        ClaimId.C04: (_content_terms, _agreement_current),
        ClaimId.C05: (_content_terms, _agreement_current),
        ClaimId.C06: (_content_terms, _agreement_current, _purpose_attested),
    }
)


def _scope_reasons(
    recipient: Recipient, scope: Scope, predicates: tuple[_Predicate, ...], today: date
) -> set[BlockReason]:
    """Every reason any predicate finds in one scope."""
    return {reason for predicate in predicates for reason in predicate(recipient, scope, today)}


def _recipient_blocks(
    recipient: Recipient, predicates: tuple[_Predicate, ...], today: date
) -> set[Block]:
    """Every predicate over every operator-arranged scope of one recipient."""
    reasons: set[BlockReason] = set()
    for scope in recipient.scopes:
        if scope.kind in OPERATOR_ARRANGED:
            reasons |= _scope_reasons(recipient, scope, predicates, today)
    return {Block(recipient.id, reason) for reason in reasons}


def _scope_blocks(
    register: Mapping[RecipientId, Recipient], predicates: tuple[_Predicate, ...], today: date
) -> set[Block]:
    """Fold every predicate over every operator-arranged scope in the register."""
    blocks: set[Block] = set()
    for recipient in register.values():
        blocks |= _recipient_blocks(recipient, predicates, today)
    return blocks


def _model_blocks(
    register: Mapping[RecipientId, Recipient], provider_models: Mapping[str, frozenset[str]]
) -> set[Block]:
    """Compare what dispatch can reach with what the register reviewed."""
    if set(provider_models) != set(PROVIDER_RECIPIENTS):
        return {Block(None, BlockReason.PROVIDER_SET_CHANGED)}
    blocks: set[Block] = set()
    for provider, models in provider_models.items():
        recipient = register[PROVIDER_RECIPIENTS[provider]]
        blocks |= {
            Block(recipient.id, BlockReason.MODEL_NOT_APPROVED, model=model)
            for model in models - recipient.approved_models
        }
    return blocks


def claim_ready(
    claim: ClaimId,
    register: Mapping[RecipientId, Recipient],
    *,
    provider_models: Mapping[str, frozenset[str]],
    today: date,
    byok_enabled: bool,
) -> ClaimReadiness:
    """Whether ``claim`` may be advertised, and every code-visible reason it may not.

    Args:
        claim: The claim being asked about.
        register: The register to judge -- :data:`RECIPIENTS` in production.
        provider_models: Each dispatchable provider's allowed models, as the
            caller reads them from ``services.botmason.PROVIDER_REGISTRY``.
        today: The date to judge agreement expiry against.
        byok_enabled: Whether user-supplied provider keys are accepted; their
            traffic is governed by the user's own vendor account.

    Raises:
        ValueError: ``claim`` is not a claim this gate knows.
    """
    predicates = _CLAIM_PREDICATES.get(claim)
    if predicates is None:
        msg = f"unknown claim {claim!r}"
        raise ValueError(msg)
    blocks = _scope_blocks(register, predicates, today) | _model_blocks(register, provider_models)
    if byok_enabled:
        blocks.add(Block(None, BlockReason.BYOK_SCOPE_IN_USE))
    ordered = tuple(sorted(blocks, key=_block_key))
    return ClaimReadiness(claim=claim, allowed=not ordered, blocks=ordered)


def _block_key(block: Block) -> tuple[str, str, str]:
    """A total order over blocks whose recipient or model may be absent."""
    return (block.recipient or "", block.reason, block.model or "")
