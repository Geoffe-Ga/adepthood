"""Validate the sanitized evidence record for the deployed managed-vault pilot.

The repository's normal E2E lane uses a deliberately isolated Creek fake.  It
cannot close issue #2871, whose acceptance boundary is a deployed Adepthood,
Creek, routing service, worker, reconciler, and real Fly allocation.  This
module is intentionally only an evidence *validator*: it neither provisions a
resource nor reads a credential.  The authorized live run is performed from
the operator runbook and its sanitized record is passed here before sign-off.

The schema is closed rather than extensible.  That prevents a well-meaning
operator from adding a user id, vault URL, journal excerpt, or raw log field to
the checked-in record, and prevents a missing acceptance row from looking like
success. Evidence references are closed kind/time/hash objects; the referenced
artifacts must be sanitized separately before capture. A passed record also
embeds Creek's versioned, sanitized provider-pilot prerequisite verbatim.

Usage::

    cd backend
    python -m scripts.managed_vault_pilot_evidence \
        ../docs/qa/runs/YYYY-MM-DD-managed-vault-pilot.json

Exit codes:
    0 -- the closed record is structurally valid and every check passed.
    1 -- the record is valid but is pending/blocked/failed.
    2 -- the record is malformed or contains an unsafe field/reference.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Final, TypeGuard, cast

EXIT_PASSED = 0
EXIT_INCOMPLETE = 1
EXIT_INVALID = 2
SCHEMA_VERSION: Final[int] = 2
ZERO_OBSERVED: Final[int] = 0

REQUIRED_CHECKS: tuple[str, ...] = (
    "railway_secret_file_mounts",
    "ui_activation_and_authenticated_handoff",
    "create_restart_singleton",
    "public_route_capabilities_and_ssrf",
    "public_personal_scale_to_zero_continuity",
    "no_user_held_recovery_material",
    "intimate_zero_remote_contact",
    "provider_outage_retry_without_duplicate_billing",
    "callback_outage_retry_without_duplicate_billing",
    "readiness_timeout_retry_without_duplicate_billing",
    "routing_failure_retry_without_duplicate_billing",
    "confirmed_idempotent_teardown",
    "fleet_disable_and_cost_reconciliation",
    "exact_main_gates",
)

# Machine-checkable observations that distinguish a real acceptance pass from a
# prose assertion. Values are deliberately only booleans, counts, and one
# fixed transport enum; no free-form field exists where sensitive material can
# be pasted.
PASS_FACTS: dict[str, dict[str, object]] = {
    "railway_secret_file_mounts": {
        "control_bearer_transport": "mounted_file",
        "handoff_bearer_transport": "mounted_file",
        "bearer_values_in_environment": 0,
        "bearer_values_in_evidence": 0,
        "eligible_accounts": 1,
        "ineligible_allocations": 0,
    },
    "ui_activation_and_authenticated_handoff": {
        "activation_explicit": True,
        "journal_available_while_provisioning": True,
        "ready_after_authenticated_handoff": True,
        "ceremony_prompts": 0,
        "connection_rows": 1,
    },
    "create_restart_singleton": {
        "allocation_scoped_apps": 1,
        "allocation_scoped_machines": 1,
        "allocation_scoped_volumes": 1,
        "allocation_scoped_credentials": 1,
        "durable_activation_jobs": 1,
        "connection_rows": 1,
        "unexpected_billable_resources": 0,
    },
    "public_route_capabilities_and_ssrf": {
        "externally_reachable": True,
        "capability_check_passed": True,
        "version_check_passed": True,
        "authentication_check_passed": True,
        "private_ssrf_refusal_preserved": True,
        "private_target_disclosures": 0,
    },
    "public_personal_scale_to_zero_continuity": {
        "public_replicas": 1,
        "personal_replicas": 1,
        "same_volume_after_restart": True,
        "content_equal_after_restart": True,
    },
    "no_user_held_recovery_material": {
        "passphrase_occurrences": ZERO_OBSERVED,
        "recovery_code_occurrences": ZERO_OBSERVED,
        "wrapped_artifact_occurrences": ZERO_OBSERVED,
        "unlock_material_occurrences": ZERO_OBSERVED,
    },
    "intimate_zero_remote_contact": {
        "provisioning_call_delta": 0,
        "data_plane_call_delta": 0,
        "model_call_delta": 0,
        "local_entry_available": True,
    },
    "provider_outage_retry_without_duplicate_billing": {
        "journal_preserved": True,
        "retryable_state": True,
        "converged_after_restore": True,
        "unexpected_billable_resources": 0,
    },
    "callback_outage_retry_without_duplicate_billing": {
        "journal_preserved": True,
        "false_ready_states": 0,
        "connection_rows_after_replay": 1,
        "unexpected_billable_resources": 0,
    },
    "readiness_timeout_retry_without_duplicate_billing": {
        "journal_preserved": True,
        "retryable_state": True,
        "same_machine_after_restore": True,
        "unexpected_billable_resources": 0,
    },
    "routing_failure_retry_without_duplicate_billing": {
        "journal_preserved": True,
        "honest_unavailable_state": True,
        "same_endpoint_after_restore": True,
        "unexpected_billable_resources": 0,
    },
    "confirmed_idempotent_teardown": {
        "allocation_scoped_apps": 0,
        "allocation_scoped_machines": 0,
        "allocation_scoped_volumes": 0,
        "allocation_scoped_credentials": 0,
        "matching_content_free_receipts": True,
        "repeat_delete_idempotent": True,
    },
    "fleet_disable_and_cost_reconciliation": {
        "final_report_exit_code": 0,
        "final_alert_count": 0,
        "final_divergence_count": 0,
        "provider_authoritative_inventory": True,
        "new_activations_disabled": True,
        "existing_lifecycle_available": True,
        "emergency_route_recovered": True,
        "provider_usage_reconciled": True,
        "unknown_cost_inputs_treated_as_zero": False,
    },
    "exact_main_gates": {
        "adepthood_product_gates_green": True,
        "creek_product_gates_green": True,
        "deployment_verification_green": True,
        "unexplained_product_skips": 0,
    },
}

_ROOT_FIELDS = frozenset(
    {
        "schema_version",
        "status",
        "executed_at",
        "revisions",
        "claims",
        "creek_pilot_prerequisite",
        "checks",
    }
)
_REVISION_FIELDS = frozenset(
    {
        "adepthood_sha",
        "creek_sha",
        "vault_image_digest",
        "control_plane_image_digest",
        "adepthood_deployment",
        "creek_control_deployment",
        "creek_worker_deployment",
        "creek_routing_deployment",
        "creek_fleet_schedule_revision",
        "provisioning_contract",
        "vault_contract",
    }
)
_CLAIM_FIELDS = frozenset({"custody_mode", "attested_confidential"})
_CHECK_FIELDS = frozenset({"outcome", "evidence_refs", "facts"})
_EVIDENCE_REF_FIELDS = frozenset({"kind", "observed_at", "sha256"})
_STATUSES = frozenset({"pending", "blocked", "failed", "passed"})
_OUTCOMES = _STATUSES

_PREREQUISITE_FIELDS = frozenset(
    {
        "schema_version",
        "status",
        "executed_at",
        "source",
        "authorization",
        "credentials",
        "deployments",
        "fault_drills",
        "cardinality",
        "fleet",
        "restores",
        "emergency_stop",
        "cost",
        "exact_main",
        "independent_review",
        "artifacts",
    }
)
_PREREQUISITE_ARTIFACT_KINDS = frozenset(
    {
        "alert_delivery",
        "authorization",
        "callback_outage",
        "cardinality_teardown",
        "control_image",
        "create_after_provider_create_before_handoff",
        "deployments_health",
        "emergency_stop",
        "exact_main",
        "independent_review",
        "invoice_cost",
        "provider_outage",
        "readiness_timeout",
        "reconcile",
        "routing_failure",
        "sqlite_runtime_state_restore",
        "stopped_volume_restore",
        "vault_image",
    }
)
_SOURCE_FIELDS = frozenset(
    {
        "creek_sha",
        "control_image_digest",
        "vault_image_digest",
        "provisioning_contract",
        "vault_contract",
    }
)
_AUTHORIZATION_FIELDS = frozenset(
    {
        "dedicated_organization",
        "max_live_allocations",
        "currency",
        "monthly_alert_usd_cents",
        "region_recorded",
        "cleanup_owner_recorded",
    }
)
_CREDENTIAL_FIELDS = frozenset(
    {
        "deploy_token_scope",
        "evidence_token_scope",
        "deploy_token_lifetime_seconds",
        "evidence_token_lifetime_seconds",
        "deploy_token_age_seconds",
        "evidence_token_age_seconds",
        "personal_token_values",
        "secret_values_in_environment",
        "mounted_secret_file_modes_0400",
        "deploy_token_revoked",
        "evidence_token_revoked",
    }
)
_DEPLOYMENT_FIELDS = frozenset(
    {
        "control_revision",
        "worker_revision",
        "routing_revision",
        "fleet_schedule_revision",
        "shared_atomic_state_storage",
        "public_tls_healthy",
        "authenticated_health_checks_healthy",
        "worker_ready_signal_healthy",
        "control_image_digest_matches_deployment",
        "vault_image_digest_matches_deployment",
    }
)
_DRILL_FIELDS = frozenset(
    {
        "create_after_provider_create_before_handoff",
        "provider_outage",
        "callback_outage",
        "readiness_timeout",
        "routing_failure",
    }
)
_COMMON_DRILL_FIELDS = frozenset(
    {
        "outcome",
        "reversible",
        "destructive_provider_mutations",
        "unexpected_billable_resources",
    }
)
_DRILL_SPECIFIC_FIELDS: dict[str, frozenset[str]] = {
    "create_after_provider_create_before_handoff": frozenset(
        {"retryable_job_persisted", "restarted_worker_converged"}
    ),
    "provider_outage": frozenset({"provider_unavailable_persisted", "retry_converged"}),
    "callback_outage": frozenset({"handoff_failure_persisted", "retry_converged"}),
    "readiness_timeout": frozenset({"route_refused", "same_machine_after_restore"}),
    "routing_failure": frozenset({"unavailable_response_observed", "same_endpoint_after_restore"}),
}
_CARDINALITY_FIELDS = frozenset(
    {
        "after_create",
        "after_teardown",
        "teardown_receipt_confirmed",
        "teardown_idempotent",
    }
)
_COUNT_FIELDS = frozenset(
    {"app_count", "machine_count", "volume_count", "credential_count", "job_count"}
)
_FLEET_FIELDS = frozenset(
    {
        "provider_authoritative_inventory",
        "inventory_mode",
        "alert_test_report_exit_code",
        "alert_kind",
        "alert_delivered",
        "alert_acknowledged",
        "final_report_exit_code",
        "final_alert_count",
        "final_divergence_count",
        "reconcile_window_approved",
        "reconcile_interruption_window_seconds",
        "retryable_deletions_requeued",
        "nonretryable_deletions_requeued",
    }
)
_RESTORE_FIELDS = frozenset({"sqlite_runtime_state", "stopped_volume"})
_SQLITE_RESTORE_FIELDS = frozenset(
    {
        "outcome",
        "network_mutations_disabled",
        "schema_valid",
        "job_membership_equal",
        "allocation_membership_equal",
        "credential_membership_equal",
        "receipt_membership_equal",
        "idempotent_restart",
    }
)
_VOLUME_RESTORE_FIELDS = frozenset(
    {
        "outcome",
        "source_machine_stopped",
        "snapshot_created",
        "same_region",
        "reviewed_image_digest_matched",
        "sentinel_equal",
        "original_volume_preserved",
        "temporary_machine_removed",
        "temporary_volume_removed",
    }
)
_EMERGENCY_FIELDS = frozenset(
    {
        "outcome",
        "non_destructive",
        "stopped_count",
        "failed_count",
        "routing_recovered",
        "deletion_converged",
    }
)
_COST_FIELDS = frozenset(
    {
        "currency",
        "estimated_usd",
        "provider_total_usd",
        "signed_delta_usd",
        "rate_date",
        "rate_source",
        "unpriced_inputs",
        "unknown_inputs_treated_as_zero",
        "reconciled",
    }
)
_EXACT_MAIN_FIELDS = frozenset({"ci_green", "deployment_verified", "unexplained_product_skips"})
_REVIEW_FIELDS = frozenset(
    {
        "reviewed_creek_sha",
        "verdict",
        "reference_kind",
        "reference_number",
        "artifact_sha256",
    }
)
_ARTIFACT_FIELDS = frozenset({"kind", "observed_at", "sha256"})

_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_SEMVER_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
_UNSIGNED_USD_RE = re.compile(r"^(?:0|[1-9][0-9]*)\.[0-9]{2}$")
_SIGNED_USD_RE = re.compile(r"^-?(?:0|[1-9][0-9]*)\.[0-9]{2}$")
_DEPLOYMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
_UTC_TIMESTAMP_RE = re.compile(
    r"^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$"
)
_EVIDENCE_KINDS = frozenset(
    {
        "alert_delivery",
        "deployment_log",
        "github_actions",
        "invoice_source",
        "operator_observation",
        "provider_report",
        "review_record",
    }
)
_ORG_DEPLOY_SCOPE: Final[str] = "organization_deploy"
_ORG_READ_ONLY_SCOPE: Final[str] = "organization_read_only"


def _is_mapping(value: object) -> TypeGuard[Mapping[object, object]]:
    """Return whether ``value`` is a JSON object-like mapping."""
    return isinstance(value, Mapping)


def _keys(value: Mapping[object, object]) -> frozenset[object]:
    """Freeze one mapping's keys for exact-shape comparisons."""
    return frozenset(value)


def _reference_is_safe(value: object, *, executed_at: datetime | None) -> bool:
    """Admit only one immutable, timestamped, closed-shape artifact reference."""
    if not _is_mapping(value) or _keys(value) != _EVIDENCE_REF_FIELDS:
        return False
    observed_at = _utc_datetime(value.get("observed_at"))
    return bool(
        value.get("kind") in _EVIDENCE_KINDS
        and observed_at is not None
        and executed_at is not None
        and executed_at - timedelta(days=7) <= observed_at <= executed_at
        and _matches(value.get("sha256"), _DIGEST_RE)
    )


def _fact_value_matches(actual: object, expected: object) -> bool:
    """Compare without allowing Python's ``True == 1`` coercion."""
    return type(actual) is type(expected) and actual == expected


def _facts_are_safe(
    facts: Mapping[object, object],
    expected: Mapping[str, object],
) -> bool:
    """Allow null or the expected primitive type in a non-passing record."""
    return all(
        actual is None
        or (
            _fact_value_matches(actual, expected[name])
            if isinstance(expected[name], str)
            else type(actual) is type(expected[name])
        )
        for name, actual in facts.items()
        if isinstance(name, str) and name in expected
    )


def _revisions_are_valid(revisions: Mapping[object, object], *, passed: bool) -> bool:
    """Validate exact immutable coordinates, allowing nulls only before a pass."""
    values = {key: revisions.get(key) for key in _REVISION_FIELDS}
    if not passed and all(value is None for value in values.values()):
        return True
    checks = (
        _matches(values["adepthood_sha"], _SHA_RE),
        _matches(values["creek_sha"], _SHA_RE),
        _matches(values["vault_image_digest"], _DIGEST_RE),
        _matches(values["control_plane_image_digest"], _DIGEST_RE),
        _matches(values["adepthood_deployment"], _DEPLOYMENT_RE),
        _matches(values["creek_control_deployment"], _SHA_RE),
        _matches(values["creek_worker_deployment"], _SHA_RE),
        _matches(values["creek_routing_deployment"], _SHA_RE),
        _matches(values["creek_fleet_schedule_revision"], _SHA_RE),
        _matches(values["provisioning_contract"], _SEMVER_RE),
        _matches(values["vault_contract"], _SEMVER_RE),
    )
    return all(checks)


def _matches(value: object, pattern: re.Pattern[str]) -> bool:
    """Match one string value against a compiled closed-shape pattern."""
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _is_utc_timestamp(value: object) -> bool:
    """Require a real calendar instant in the record's fixed UTC format."""
    if not isinstance(value, str) or _UTC_TIMESTAMP_RE.fullmatch(value) is None:
        return False
    try:
        date.fromisoformat(value[:10])
    except ValueError:
        return False
    return True


def _utc_datetime(value: object) -> datetime | None:
    """Parse the validator's fixed UTC-seconds timestamp without accepting variants."""
    if not isinstance(value, str) or not _is_utc_timestamp(value):
        return None
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def _closed_object(
    value: object,
    fields: frozenset[str],
) -> Mapping[object, object] | None:
    """Return one mapping only when its shape is exact."""
    if not _is_mapping(value) or _keys(value) != fields:
        return None
    return value


def _exact_values(
    value: Mapping[object, object],
    expected: Mapping[str, object],
) -> bool:
    """Require exact primitive values without bool/int coercion."""
    return all(_fact_value_matches(value.get(key), item) for key, item in expected.items())


def _bounded_int(value: object, *, minimum: int, maximum: int) -> bool:
    """Return whether *value* is a real integer inside an inclusive bound."""
    return type(value) is int and minimum <= value <= maximum


def _validate_prerequisite_source(
    value: object,
    revisions: Mapping[object, object],
) -> bool:
    source = _closed_object(value, _SOURCE_FIELDS)
    return source is not None and all(
        (
            _matches(source.get("creek_sha"), _SHA_RE),
            _matches(source.get("control_image_digest"), _DIGEST_RE),
            _matches(source.get("vault_image_digest"), _DIGEST_RE),
            source.get("provisioning_contract") == "2.1.0",
            source.get("vault_contract") == "0.16.0",
            source.get("creek_sha") == revisions.get("creek_sha"),
            source.get("control_image_digest") == revisions.get("control_plane_image_digest"),
            source.get("vault_image_digest") == revisions.get("vault_image_digest"),
            source.get("provisioning_contract") == revisions.get("provisioning_contract"),
            source.get("vault_contract") == revisions.get("vault_contract"),
        )
    )


def _validate_prerequisite_authorization(value: object) -> bool:
    authorization = _closed_object(value, _AUTHORIZATION_FIELDS)
    return authorization is not None and all(
        (
            _exact_values(
                authorization,
                {
                    "dedicated_organization": True,
                    "currency": "USD",
                    "monthly_alert_usd_cents": 2500,
                    "region_recorded": True,
                    "cleanup_owner_recorded": True,
                },
            ),
            _bounded_int(authorization.get("max_live_allocations"), minimum=1, maximum=5),
        )
    )


def _validate_prerequisite_credentials(value: object) -> bool:
    credentials = _closed_object(value, _CREDENTIAL_FIELDS)
    deploy_lifetime = credentials.get("deploy_token_lifetime_seconds") if credentials else None
    evidence_lifetime = credentials.get("evidence_token_lifetime_seconds") if credentials else None
    deploy_age = credentials.get("deploy_token_age_seconds") if credentials else None
    evidence_age = credentials.get("evidence_token_age_seconds") if credentials else None
    return credentials is not None and all(
        (
            credentials.get("deploy_token_scope") == _ORG_DEPLOY_SCOPE,
            credentials.get("evidence_token_scope") == _ORG_READ_ONLY_SCOPE,
            credentials.get("personal_token_values") == ZERO_OBSERVED,
            credentials.get("secret_values_in_environment") == ZERO_OBSERVED,
            credentials.get("mounted_secret_file_modes_0400") is True,
            credentials.get("deploy_token_revoked") is True,
            credentials.get("evidence_token_revoked") is True,
            _bounded_int(
                deploy_lifetime,
                minimum=1,
                maximum=604800,
            ),
            _bounded_int(
                evidence_lifetime,
                minimum=1,
                maximum=604800,
            ),
            _bounded_int(deploy_age, minimum=0, maximum=604800),
            _bounded_int(evidence_age, minimum=0, maximum=604800),
            type(deploy_lifetime) is int
            and type(deploy_age) is int
            and deploy_age <= deploy_lifetime,
            type(evidence_lifetime) is int
            and type(evidence_age) is int
            and evidence_age <= evidence_lifetime,
        )
    )


def _validate_prerequisite_deployments(
    value: object,
    revisions: Mapping[object, object],
) -> bool:
    deployments = _closed_object(value, _DEPLOYMENT_FIELDS)
    return deployments is not None and all(
        (
            _exact_values(
                deployments,
                {
                    "shared_atomic_state_storage": True,
                    "public_tls_healthy": True,
                    "authenticated_health_checks_healthy": True,
                    "worker_ready_signal_healthy": True,
                    "control_image_digest_matches_deployment": True,
                    "vault_image_digest_matches_deployment": True,
                },
            ),
            _matches(deployments.get("control_revision"), _SHA_RE),
            _matches(deployments.get("worker_revision"), _SHA_RE),
            _matches(deployments.get("routing_revision"), _SHA_RE),
            _matches(deployments.get("fleet_schedule_revision"), _SHA_RE),
            deployments.get("control_revision") == revisions.get("creek_control_deployment"),
            deployments.get("worker_revision") == revisions.get("creek_worker_deployment"),
            deployments.get("routing_revision") == revisions.get("creek_routing_deployment"),
            deployments.get("fleet_schedule_revision")
            == revisions.get("creek_fleet_schedule_revision"),
        )
    )


def _validate_prerequisite_drills(value: object) -> bool:
    drills = _closed_object(value, _DRILL_FIELDS)
    if drills is None:
        return False
    for name, specific_fields in _DRILL_SPECIFIC_FIELDS.items():
        drill = _closed_object(drills.get(name), _COMMON_DRILL_FIELDS | specific_fields)
        if drill is None or not _exact_values(
            drill,
            {
                "outcome": "passed",
                "reversible": True,
                "destructive_provider_mutations": 0,
                "unexpected_billable_resources": 0,
                **dict.fromkeys(specific_fields, True),
            },
        ):
            return False
    return True


def _validate_prerequisite_cardinality(value: object) -> bool:
    cardinality = _closed_object(value, _CARDINALITY_FIELDS)
    if cardinality is None:
        return False
    after_create = _closed_object(cardinality.get("after_create"), _COUNT_FIELDS)
    after_teardown = _closed_object(cardinality.get("after_teardown"), _COUNT_FIELDS)
    return (
        after_create is not None
        and after_teardown is not None
        and _exact_values(after_create, dict.fromkeys(_COUNT_FIELDS, 1))
        and _exact_values(after_teardown, dict.fromkeys(_COUNT_FIELDS, 0))
        and _exact_values(
            cardinality,
            {
                "teardown_receipt_confirmed": True,
                "teardown_idempotent": True,
            },
        )
    )


def _validate_prerequisite_fleet(value: object) -> bool:
    fleet = _closed_object(value, _FLEET_FIELDS)
    return fleet is not None and all(
        (
            _exact_values(
                fleet,
                {
                    "provider_authoritative_inventory": True,
                    "alert_test_report_exit_code": 3,
                    "alert_kind": "monthly_budget_departure",
                    "alert_delivered": True,
                    "alert_acknowledged": True,
                    "final_report_exit_code": 0,
                    "final_alert_count": 0,
                    "final_divergence_count": 0,
                    "reconcile_window_approved": True,
                    "nonretryable_deletions_requeued": 0,
                },
            ),
            fleet.get("inventory_mode") in {"derived", "derived+injected"},
            _bounded_int(
                fleet.get("reconcile_interruption_window_seconds"),
                minimum=1,
                maximum=86400,
            ),
            _bounded_int(
                fleet.get("retryable_deletions_requeued"),
                minimum=1,
                maximum=sys.maxsize,
            ),
        )
    )


def _all_true_except_outcome(
    value: object,
    fields: frozenset[str],
) -> bool:
    block = _closed_object(value, fields)
    if block is None or block.get("outcome") != "passed":
        return False
    return all(block.get(field) is True for field in fields - {"outcome"})


def _validate_prerequisite_restores(value: object) -> bool:
    restores = _closed_object(value, _RESTORE_FIELDS)
    return restores is not None and all(
        (
            _all_true_except_outcome(restores.get("sqlite_runtime_state"), _SQLITE_RESTORE_FIELDS),
            _all_true_except_outcome(restores.get("stopped_volume"), _VOLUME_RESTORE_FIELDS),
        )
    )


def _validate_prerequisite_emergency(value: object) -> bool:
    emergency = _closed_object(value, _EMERGENCY_FIELDS)
    return emergency is not None and all(
        (
            _exact_values(
                emergency,
                {
                    "outcome": "passed",
                    "non_destructive": True,
                    "failed_count": 0,
                    "routing_recovered": True,
                    "deletion_converged": True,
                },
            ),
            _bounded_int(emergency.get("stopped_count"), minimum=1, maximum=5),
        )
    )


def _decimal(value: object, pattern: re.Pattern[str]) -> Decimal | None:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        return None
    try:
        return Decimal(value)
    except InvalidOperation:
        return None


def _validate_prerequisite_cost(value: object) -> bool:
    cost = _closed_object(value, _COST_FIELDS)
    if cost is None:
        return False
    estimated = _decimal(cost.get("estimated_usd"), _UNSIGNED_USD_RE)
    provider_total = _decimal(cost.get("provider_total_usd"), _UNSIGNED_USD_RE)
    signed_delta = _decimal(cost.get("signed_delta_usd"), _SIGNED_USD_RE)
    return all(
        (
            estimated is not None,
            provider_total is not None,
            signed_delta is not None,
            estimated is not None
            and provider_total is not None
            and signed_delta == provider_total - estimated,
            _exact_values(
                cost,
                {
                    "currency": "USD",
                    "unpriced_inputs": [],
                    "unknown_inputs_treated_as_zero": False,
                    "reconciled": True,
                },
            ),
            _is_calendar_date(cost.get("rate_date")),
            cost.get("rate_source") in {"provider_invoice", "provider_usage_sample"},
        )
    )


def _is_calendar_date(value: object) -> bool:
    if not isinstance(value, str) or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) is None:
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _validate_prerequisite_exact_main(value: object) -> bool:
    exact_main = _closed_object(value, _EXACT_MAIN_FIELDS)
    return exact_main is not None and _exact_values(
        exact_main,
        {
            "ci_green": True,
            "deployment_verified": True,
            "unexplained_product_skips": 0,
        },
    )


def _validate_prerequisite_artifacts(
    value: object,
    *,
    executed_at: datetime,
) -> dict[str, str] | None:
    if not isinstance(value, list) or len(value) != len(_PREREQUISITE_ARTIFACT_KINDS):
        return None
    artifacts: dict[str, str] = {}
    earliest = executed_at - timedelta(days=7)
    for item in value:
        artifact = _closed_object(item, _ARTIFACT_FIELDS)
        if artifact is None:
            return None
        kind = artifact.get("kind")
        observed_at = _utc_datetime(artifact.get("observed_at"))
        sha256 = artifact.get("sha256")
        if (
            not isinstance(kind, str)
            or kind not in _PREREQUISITE_ARTIFACT_KINDS
            or kind in artifacts
            or observed_at is None
            or not earliest <= observed_at <= executed_at
            or not isinstance(sha256, str)
            or _DIGEST_RE.fullmatch(sha256) is None
        ):
            return None
        artifacts[kind] = sha256
    if frozenset(artifacts) != _PREREQUISITE_ARTIFACT_KINDS:
        return None
    return artifacts


def _validate_prerequisite_review(
    value: object,
    revisions: Mapping[object, object],
    artifacts: Mapping[str, str],
) -> bool:
    review = _closed_object(value, _REVIEW_FIELDS)
    return review is not None and all(
        (
            _exact_values(
                review,
                {
                    "verdict": "LGTM",
                    "reference_kind": "github_issuecomment",
                },
            ),
            review.get("reviewed_creek_sha") == revisions.get("creek_sha"),
            _bounded_int(review.get("reference_number"), minimum=1, maximum=sys.maxsize),
            review.get("artifact_sha256") == artifacts.get("independent_review"),
        )
    )


def _creek_prerequisite_is_valid(
    value: object,
    *,
    revisions: Mapping[object, object],
    outer_executed_at: object,
) -> bool:
    prerequisite = _closed_object(value, _PREREQUISITE_FIELDS)
    prerequisite_time = (
        _utc_datetime(prerequisite.get("executed_at")) if prerequisite is not None else None
    )
    outer_time = _utc_datetime(outer_executed_at)
    if (
        prerequisite is None
        or prerequisite.get("schema_version") != "1.0.0"
        or prerequisite.get("status") != "passed"
        or prerequisite_time is None
        or outer_time is None
        or not outer_time - timedelta(days=7) <= prerequisite_time <= outer_time
    ):
        return False
    artifacts = _validate_prerequisite_artifacts(
        prerequisite.get("artifacts"), executed_at=prerequisite_time
    )
    return artifacts is not None and all(
        (
            _validate_prerequisite_source(prerequisite.get("source"), revisions),
            _validate_prerequisite_authorization(prerequisite.get("authorization")),
            _validate_prerequisite_credentials(prerequisite.get("credentials")),
            _validate_prerequisite_deployments(prerequisite.get("deployments"), revisions),
            _validate_prerequisite_drills(prerequisite.get("fault_drills")),
            _validate_prerequisite_cardinality(prerequisite.get("cardinality")),
            _validate_prerequisite_fleet(prerequisite.get("fleet")),
            _validate_prerequisite_restores(prerequisite.get("restores")),
            _validate_prerequisite_emergency(prerequisite.get("emergency_stop")),
            _validate_prerequisite_cost(prerequisite.get("cost")),
            _validate_prerequisite_exact_main(prerequisite.get("exact_main")),
            _validate_prerequisite_review(
                prerequisite.get("independent_review"), revisions, artifacts
            ),
        )
    )


def _validate_evidence_refs(
    outcome: object,
    refs: object,
    executed_at: datetime | None,
    errors: list[str],
) -> None:
    """Validate bounded opaque references for one acceptance check."""
    if not isinstance(refs, list) or not all(
        _reference_is_safe(item, executed_at=executed_at) for item in refs
    ):
        errors.append("evidence references must be immutable, time-bounded, and secret-free")
    elif outcome == "passed" and not refs:
        errors.append("passed acceptance checks require evidence references")


def _validate_facts(
    name: str,
    outcome: object,
    facts: object,
    errors: list[str],
) -> bool:
    """Validate one check's exact primitive observations."""
    expected = PASS_FACTS[name]
    if not _is_mapping(facts):
        errors.append("acceptance facts must be objects")
        return False
    if _keys(facts) != frozenset(expected):
        errors.append("acceptance facts have unknown or missing fields")
        return False
    if not _facts_are_safe(facts, expected):
        errors.append("acceptance facts must be closed primitive observations")
        return False
    if outcome != "passed":
        return False
    if not all(_fact_value_matches(facts.get(key), value) for key, value in expected.items()):
        errors.append("passed acceptance facts do not match required invariants")
        return False
    return True


def _validate_one_check(
    name: str,
    raw_check: object,
    executed_at: datetime | None,
    errors: list[str],
) -> bool:
    """Validate one mandatory acceptance row without reading free-form prose."""
    if not _is_mapping(raw_check):
        errors.append("acceptance checks must be objects")
        return False
    if _keys(raw_check) != _CHECK_FIELDS:
        errors.append("acceptance checks have unknown or missing fields")
    outcome = raw_check.get("outcome")
    if outcome not in _OUTCOMES:
        errors.append("acceptance checks contain an invalid outcome")
    _validate_evidence_refs(outcome, raw_check.get("evidence_refs"), executed_at, errors)
    return _validate_facts(name, outcome, raw_check.get("facts"), errors)


def _checks_are_valid(
    checks: Mapping[object, object],
    executed_at: datetime | None,
    errors: list[str],
) -> bool:
    """Validate every mandatory acceptance row."""
    results = tuple(
        _validate_one_check(name, checks.get(name), executed_at, errors) for name in REQUIRED_CHECKS
    )
    return all(results)


def _status_and_shape(record: Mapping[object, object], errors: list[str]) -> object:
    """Validate root shape/version/status and return the raw status."""
    if _keys(record) != _ROOT_FIELDS:
        errors.append("record has unknown or missing fields")
    status = record.get("status")
    if status not in _STATUSES:
        errors.append("record has invalid status")
    schema_version = record.get("schema_version")
    if type(schema_version) is not int or schema_version != SCHEMA_VERSION:
        errors.append("record has unsupported schema_version")
    return status


def _validate_execution_time(
    record: Mapping[object, object],
    status: object,
    errors: list[str],
) -> None:
    """Require a dated executed record while keeping the template undated."""
    executed_at = record.get("executed_at")
    if status == "pending":
        if executed_at is not None:
            errors.append("pending record must not claim an execution time")
        return
    if not _is_utc_timestamp(executed_at):
        errors.append("executed record requires a UTC second-precision timestamp")


def _validate_revisions(
    record: Mapping[object, object],
    *,
    passed: bool,
    errors: list[str],
) -> None:
    """Validate the exact deployment and source coordinates object."""
    revisions = record.get("revisions")
    if not _is_mapping(revisions):
        errors.append("revisions must be an object")
        return
    if _keys(revisions) != _REVISION_FIELDS:
        errors.append("revisions have unknown or missing fields")
    if not _revisions_are_valid(revisions, passed=passed):
        errors.append("revisions contain invalid exact coordinates")


def _validate_claims(record: Mapping[object, object], errors: list[str]) -> None:
    """Pin the only truthful ordinary-Fly custody claims."""
    claims = record.get("claims")
    if not _is_mapping(claims):
        errors.append("claims must be an object")
        return
    if _keys(claims) != _CLAIM_FIELDS:
        errors.append("claims have unknown or missing fields")
    if (
        claims.get("custody_mode") != "provider_managed"
        or claims.get("attested_confidential") is not False
    ):
        errors.append("claims must be provider_managed and non-attested")


def _validate_creek_prerequisite(
    record: Mapping[object, object],
    *,
    passed: bool,
    errors: list[str],
) -> None:
    """Require the exact sanitized Creek pilot output before an outer pass."""
    prerequisite = record.get("creek_pilot_prerequisite")
    if not passed and prerequisite is None:
        return
    revisions = record.get("revisions")
    if not _is_mapping(revisions) or not _creek_prerequisite_is_valid(
        prerequisite,
        revisions=revisions,
        outer_executed_at=record.get("executed_at"),
    ):
        errors.append("Creek pilot prerequisite is missing or invalid")


def _validate_checks(record: Mapping[object, object], errors: list[str]) -> bool:
    """Validate the closed acceptance-check mapping and return pass state."""
    checks = record.get("checks")
    if not _is_mapping(checks):
        errors.append("checks must be an object")
        return False
    if _keys(checks) != frozenset(REQUIRED_CHECKS):
        errors.append("checks must contain the exact required acceptance set")
    return _checks_are_valid(checks, _utc_datetime(record.get("executed_at")), errors)


def validate_record(record: object, *, require_passed: bool = True) -> tuple[str, ...]:
    """Return generic validation errors without ever echoing record values."""
    errors: list[str] = []
    if not _is_mapping(record):
        return ("record must be a JSON object",)
    status = _status_and_shape(record, errors)
    passed = status == "passed"
    _validate_execution_time(record, status, errors)
    _validate_revisions(record, passed=passed, errors=errors)
    _validate_claims(record, errors)
    _validate_creek_prerequisite(record, passed=passed, errors=errors)
    all_passed = _validate_checks(record, errors)

    if passed and not all_passed:
        errors.append("every acceptance check must be passed")
    if require_passed and not passed:
        errors.append("record is not passed")
    return tuple(dict.fromkeys(errors))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate a sanitized managed-vault pilot evidence record."
    )
    parser.add_argument("record", type=Path)
    return parser


def _load(path: Path) -> object | None:
    """Load JSON without propagating input text through parse errors."""
    try:
        return cast("object", json.loads(path.read_text(encoding="utf-8")))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def main(argv: Sequence[str] | None = None) -> int:
    """Validate one record and print a value-free verdict."""
    args = _parser().parse_args(argv)
    record = _load(args.record)
    if record is None:
        sys.stdout.write("INVALID: evidence record could not be read as JSON\n")
        return EXIT_INVALID
    structural_errors = validate_record(record, require_passed=False)
    if structural_errors:
        report = "\n".join(
            (
                "INVALID: managed-vault pilot evidence record",
                *(f"- {error}" for error in structural_errors),
            )
        )
        sys.stdout.write(f"{report}\n")
        return EXIT_INVALID
    if validate_record(record, require_passed=True):
        sys.stdout.write("INCOMPLETE: managed-vault pilot has no passing evidence verdict\n")
        return EXIT_INCOMPLETE
    sys.stdout.write("PASSED: managed-vault pilot evidence is complete\n")
    return EXIT_PASSED


if __name__ == "__main__":
    raise SystemExit(main())
