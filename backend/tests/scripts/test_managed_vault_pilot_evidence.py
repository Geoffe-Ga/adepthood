"""Fail-closed evidence contract for the deployed managed-vault pilot.

The ordinary E2E lane deliberately uses a fake Creek control plane.  Issue
#2871 is the separate, cost-bearing proof against the deployed Creek/Fly stack.
These tests keep its eventual evidence from being mistaken for an automated
fixture run, from silently omitting a launch invariant, or from becoming a new
place to persist credentials, account identities, vault addresses, or content.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import cast

import pytest

from scripts import managed_vault_pilot_evidence as evidence

_REPO_ROOT = Path(__file__).resolve().parents[3]
_TEMPLATE = _REPO_ROOT / "docs" / "qa" / "managed-vault-pilot-evidence.template.json"
_RUNBOOK = _REPO_ROOT / "docs" / "qa" / "managed-vault-pilot-proof.md"
_SHA = "a" * 40
_OTHER_SHA = "b" * 40
_DIGEST = f"sha256:{'c' * 64}"
_CONTROL_DIGEST = f"sha256:{'d' * 64}"
_ARTIFACT_DIGEST = f"sha256:{'e' * 64}"
_PREREQUISITE_ARTIFACT_KINDS = (
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
)
_PASS_FACTS: dict[str, dict[str, object]] = {
    "railway_secret_file_mounts": {
        "control_bearer_transport": "mounted_file",
        "handoff_bearer_transport": "mounted_file",
        "bearer_values_in_environment": 0,
        "bearer_values_in_evidence": 0,
        "runtime_uid": 10001,
        "runtime_gid": 10001,
        "mount_directory_mode": "0700",
        "mounted_file_mode": "0400",
        "regular_files_without_symlinks": True,
        "runtime_volume_bootstrap": True,
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
        "passphrase_occurrences": 0,
        "recovery_code_occurrences": 0,
        "wrapped_artifact_occurrences": 0,
        "unlock_material_occurrences": 0,
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


def _artifact_digest(kind: str) -> str:
    index = _PREREQUISITE_ARTIFACT_KINDS.index(kind) + 1
    return f"sha256:{index:064x}"


def _common_drill(**extra: object) -> dict[str, object]:
    return {
        "outcome": "passed",
        "reversible": True,
        "destructive_provider_mutations": 0,
        "unexpected_billable_resources": 0,
        **extra,
    }


def _passed_prerequisite() -> dict[str, object]:
    return {
        "schema_version": "1.0.0",
        "status": "passed",
        "executed_at": "2026-09-14T12:00:00Z",
        "source": {
            "creek_sha": _OTHER_SHA,
            "control_image_digest": _CONTROL_DIGEST,
            "vault_image_digest": _DIGEST,
            "provisioning_contract": "2.1.0",
            "vault_contract": "0.16.0",
        },
        "authorization": {
            "dedicated_organization": True,
            "max_live_allocations": 5,
            "currency": "USD",
            "monthly_alert_usd_cents": 2500,
            "region_recorded": True,
            "cleanup_owner_recorded": True,
        },
        "credentials": {
            "deploy_token_scope": "organization_deploy",
            "evidence_token_scope": "organization_read_only",
            "deploy_token_lifetime_seconds": 604800,
            "evidence_token_lifetime_seconds": 3600,
            "deploy_token_age_seconds": 3600,
            "evidence_token_age_seconds": 1800,
            "personal_token_values": 0,
            "secret_values_in_environment": 0,
            "mounted_secret_file_modes_0400": True,
            "deploy_token_revoked": True,
            "evidence_token_revoked": True,
        },
        "deployments": {
            "control_revision": "1" * 40,
            "worker_revision": "2" * 40,
            "routing_revision": "3" * 40,
            "fleet_schedule_revision": "4" * 40,
            "shared_atomic_state_storage": True,
            "public_tls_healthy": True,
            "authenticated_health_checks_healthy": True,
            "worker_ready_signal_healthy": True,
            "control_image_digest_matches_deployment": True,
            "vault_image_digest_matches_deployment": True,
        },
        "fault_drills": {
            "create_after_provider_create_before_handoff": _common_drill(
                retryable_job_persisted=True,
                restarted_worker_converged=True,
            ),
            "provider_outage": _common_drill(
                provider_unavailable_persisted=True,
                retry_converged=True,
            ),
            "callback_outage": _common_drill(
                handoff_failure_persisted=True,
                retry_converged=True,
            ),
            "readiness_timeout": _common_drill(
                route_refused=True,
                same_machine_after_restore=True,
            ),
            "routing_failure": _common_drill(
                unavailable_response_observed=True,
                same_endpoint_after_restore=True,
            ),
        },
        "cardinality": {
            "after_create": {
                "app_count": 1,
                "machine_count": 1,
                "volume_count": 1,
                "credential_count": 1,
                "job_count": 1,
            },
            "after_teardown": {
                "app_count": 0,
                "machine_count": 0,
                "volume_count": 0,
                "credential_count": 0,
                "job_count": 0,
            },
            "teardown_receipt_confirmed": True,
            "teardown_idempotent": True,
        },
        "fleet": {
            "provider_authoritative_inventory": True,
            "inventory_mode": "derived",
            "alert_test_report_exit_code": 3,
            "alert_kind": "monthly_budget_departure",
            "alert_delivered": True,
            "alert_acknowledged": True,
            "final_report_exit_code": 0,
            "final_alert_count": 0,
            "final_divergence_count": 0,
            "reconcile_window_approved": True,
            "reconcile_interruption_window_seconds": 900,
            "retryable_deletions_requeued": 1,
            "nonretryable_deletions_requeued": 0,
        },
        "restores": {
            "sqlite_runtime_state": {
                "outcome": "passed",
                "network_mutations_disabled": True,
                "schema_valid": True,
                "job_membership_equal": True,
                "allocation_membership_equal": True,
                "credential_membership_equal": True,
                "receipt_membership_equal": True,
                "idempotent_restart": True,
            },
            "stopped_volume": {
                "outcome": "passed",
                "source_machine_stopped": True,
                "snapshot_created": True,
                "same_region": True,
                "reviewed_image_digest_matched": True,
                "sentinel_equal": True,
                "original_volume_preserved": True,
                "temporary_machine_removed": True,
                "temporary_volume_removed": True,
            },
        },
        "emergency_stop": {
            "outcome": "passed",
            "non_destructive": True,
            "stopped_count": 1,
            "failed_count": 0,
            "routing_recovered": True,
            "deletion_converged": True,
        },
        "cost": {
            "currency": "USD",
            "estimated_usd": "1.23",
            "provider_total_usd": "1.25",
            "signed_delta_usd": "0.02",
            "rate_date": "2026-09-14",
            "rate_source": "provider_invoice",
            "unpriced_inputs": [],
            "unknown_inputs_treated_as_zero": False,
            "reconciled": True,
        },
        "exact_main": {
            "ci_green": True,
            "deployment_verified": True,
            "unexplained_product_skips": 0,
        },
        "independent_review": {
            "reviewed_creek_sha": _OTHER_SHA,
            "verdict": "LGTM",
            "reference_kind": "github_issuecomment",
            "reference_number": 123456,
            "artifact_sha256": _artifact_digest("independent_review"),
        },
        "artifacts": [
            {
                "kind": kind,
                "observed_at": "2026-09-14T12:00:00Z",
                "sha256": _artifact_digest(kind),
            }
            for kind in _PREREQUISITE_ARTIFACT_KINDS
        ],
    }


def _passed_record() -> dict[str, object]:
    return {
        "schema_version": 2,
        "status": "passed",
        "executed_at": "2026-09-14T12:30:00Z",
        "revisions": {
            "adepthood_sha": _SHA,
            "creek_sha": _OTHER_SHA,
            "vault_image_digest": _DIGEST,
            "control_plane_image_digest": _CONTROL_DIGEST,
            "adepthood_deployment": "railway-deployment-42",
            "creek_control_deployment": "1" * 40,
            "creek_worker_deployment": "2" * 40,
            "creek_routing_deployment": "3" * 40,
            "creek_fleet_schedule_revision": "4" * 40,
            "provisioning_contract": "2.1.0",
            "vault_contract": "0.16.0",
        },
        "claims": {
            "custody_mode": "provider_managed",
            "attested_confidential": False,
        },
        "creek_pilot_prerequisite": _passed_prerequisite(),
        "checks": {
            check: {
                "outcome": "passed",
                "evidence_refs": [
                    {
                        "kind": "operator_observation",
                        "observed_at": f"2026-09-14T12:{index:02d}:00Z",
                        "sha256": _ARTIFACT_DIGEST,
                    }
                ],
                "facts": copy.deepcopy(_PASS_FACTS[check]),
            }
            for index, check in enumerate(evidence.REQUIRED_CHECKS, start=1)
        },
    }


def _mapping(record: dict[str, object], field: str) -> dict[str, object]:
    return cast("dict[str, object]", record[field])


def _check(record: dict[str, object], name: str) -> dict[str, object]:
    return cast("dict[str, object]", _mapping(record, "checks")[name])


def _prerequisite(record: dict[str, object]) -> dict[str, object]:
    return cast("dict[str, object]", record["creek_pilot_prerequisite"])


def _set_nested(target: dict[str, object], path: tuple[str, ...], value: object) -> None:
    current = target
    for part in path[:-1]:
        current = cast("dict[str, object]", current[part])
    current[path[-1]] = value


def test_pending_template_is_complete_but_cannot_pass() -> None:
    record = json.loads(_TEMPLATE.read_text(encoding="utf-8"))

    assert set(record["checks"]) == set(evidence.REQUIRED_CHECKS)
    checks = cast("dict[str, dict[str, object]]", record["checks"])
    for check, expected in _PASS_FACTS.items():
        assert set(cast("dict[str, object]", checks[check]["facts"])) == set(expected)
        assert set(cast("dict[str, object]", checks[check]["facts"]).values()) == {None}
    assert evidence.validate_record(record, require_passed=False) == ()
    assert "record is not passed" in evidence.validate_record(record, require_passed=True)
    assert record["status"] == "pending"
    assert record["executed_at"] is None
    assert record["creek_pilot_prerequisite"] is None


def test_operator_runbook_preserves_the_live_authorization_boundary() -> None:
    text = _RUNBOOK.read_text(encoding="utf-8")

    assert "Creek-Vault#1806" in text
    assert "explicit provider and billing authorization" in text
    assert "Do not run" in text
    assert "fake Creek" in text
    assert "does not close #2871" in text


def test_operator_runbook_names_every_secret_and_privacy_boundary() -> None:
    text = _RUNBOOK.read_text(encoding="utf-8")

    for env_var in (
        "CREEK_PROVISIONING_AUTH_FILE",
        "CREEK_PROVISIONING_HANDOFF_AUTH_FILE",
        "CREEK_PROVISIONING_URL",
        "CREEK_MANAGED_VAULT_PILOT_USER_IDS",
        "CREEK_MANAGED_VAULT_ACTIVATION_ENABLED",
    ):
        assert env_var in text
    for phrase in (
        "never an environment value",
        "provider_managed",
        "attested_confidential=false",
        "INTIMATE",
        "content-free",
        "synthetic account",
        "user identifier",
        "vault URL",
    ):
        assert phrase in text

    assert "private creek content-free receipts retain" in text.casefold()
    assert "sanitized checked-in evidence contains neither identity nor resource address" in text


def test_operator_runbook_pins_the_nonroot_railway_bootstrap_boundary() -> None:
    text = _RUNBOOK.read_text(encoding="utf-8")

    for phrase in (
        "10001:10001",
        "0700",
        "0400",
        ".new",
        "atomic rename",
        "Railway SSH/SFTP",
        "RAILWAY_RUN_UID=0",
        "4,096 bytes",
        "/run/adepthood-secrets/creek-control-bearer",
        "/run/adepthood-secrets/creek-handoff-bearer",
    ):
        assert phrase in text
    assert "managed activation disabled" in text
    assert "never a Railway variable" in text


def test_operator_runbook_closes_every_acceptance_row_and_uses_the_validator() -> None:
    text = _RUNBOOK.read_text(encoding="utf-8")
    prose = " ".join(text.split())

    for check in evidence.REQUIRED_CHECKS:
        assert f"`{check}`" in text
    assert "python -m scripts.managed_vault_pilot_evidence" in text
    assert "A pending, blocked, failed, skipped, or unexplained row is not a pass" in prose
    for procedure in (
        "Create after provider create, before handoff",
        "Provider outage",
        "Callback outage",
        "Readiness timeout",
        "Routing failure",
    ):
        assert procedure in prose
    assert "creek-provisioning-pilot-evidence reduce" in text
    assert "managed_vault_pilot_prerequisite" in text


def test_exact_completed_record_passes() -> None:
    assert evidence.validate_record(_passed_record(), require_passed=True) == ()


def test_passed_record_requires_closed_creek_prerequisite() -> None:
    for value in (None, {}, {"status": "passed"}):
        record = _passed_record()
        record["creek_pilot_prerequisite"] = value

        errors = evidence.validate_record(record, require_passed=True)

        assert "Creek pilot prerequisite is missing or invalid" in errors


@pytest.mark.parametrize(
    ("path", "unsafe_value"),
    [
        (("authorization", "dedicated_organization"), False),
        (("authorization", "max_live_allocations"), 6),
        (("credentials", "deploy_token_lifetime_seconds"), 604801),
        (("credentials", "deploy_token_age_seconds"), 604801),
        (("credentials", "evidence_token_age_seconds"), 3601),
        (("credentials", "personal_token_values"), 1),
        (("credentials", "deploy_token_revoked"), False),
        (("deployments", "shared_atomic_state_storage"), False),
        (("deployments", "control_image_digest_matches_deployment"), False),
        (
            (
                "fault_drills",
                "provider_outage",
                "unexpected_billable_resources",
            ),
            1,
        ),
        (("fleet", "alert_test_report_exit_code"), 0),
        (("fleet", "final_report_exit_code"), 3),
        (("fleet", "final_alert_count"), 1),
        (("fleet", "nonretryable_deletions_requeued"), 1),
        (("restores", "sqlite_runtime_state", "network_mutations_disabled"), False),
        (("restores", "stopped_volume", "original_volume_preserved"), False),
        (("emergency_stop", "stopped_count"), 0),
        (("emergency_stop", "failed_count"), 1),
        (("cost", "unpriced_inputs"), ["egress"]),
        (("cost", "unknown_inputs_treated_as_zero"), True),
        (("exact_main", "unexplained_product_skips"), 1),
        (("independent_review", "verdict"), "CHANGES_REQUESTED"),
    ],
)
def test_creek_prerequisite_cannot_hide_missing_pilot_invariants(
    path: tuple[str, ...],
    unsafe_value: object,
) -> None:
    record = _passed_record()
    _set_nested(_prerequisite(record), path, unsafe_value)

    errors = evidence.validate_record(record, require_passed=True)

    assert "Creek pilot prerequisite is missing or invalid" in errors


def test_creek_prerequisite_binds_source_and_deployments_to_outer_record() -> None:
    for path in (
        ("source", "creek_sha"),
        ("source", "control_image_digest"),
        ("source", "vault_image_digest"),
        ("deployments", "fleet_schedule_revision"),
        ("independent_review", "reviewed_creek_sha"),
    ):
        record = _passed_record()
        _set_nested(_prerequisite(record), path, "0" * 40)

        errors = evidence.validate_record(record, require_passed=True)

        assert "Creek pilot prerequisite is missing or invalid" in errors


def test_creek_prerequisite_artifacts_are_exact_immutable_and_time_bounded() -> None:
    mutations: list[object] = []
    missing = _passed_prerequisite()["artifacts"]
    assert isinstance(missing, list)
    mutations.append(missing[:-1])
    duplicate = copy.deepcopy(missing)
    assert isinstance(duplicate, list)
    duplicate[1]["kind"] = duplicate[0]["kind"]
    mutations.append(duplicate)
    stale = copy.deepcopy(missing)
    stale[0]["observed_at"] = "2026-09-01T12:00:00Z"
    mutations.append(stale)
    unhashed = copy.deepcopy(missing)
    unhashed[0]["sha256"] = "latest"
    mutations.append(unhashed)
    extra = copy.deepcopy(missing)
    extra[0]["path"] = "private.json"
    mutations.append(extra)

    for artifacts in mutations:
        record = _passed_record()
        _prerequisite(record)["artifacts"] = artifacts

        errors = evidence.validate_record(record, require_passed=True)

        assert "Creek pilot prerequisite is missing or invalid" in errors


def test_creek_prerequisite_rejects_unknown_fields_bad_cost_and_impossible_dates() -> None:
    mutations: list[tuple[tuple[str, ...], object]] = [
        (("cost", "signed_delta_usd"), "0.03"),
        (("cost", "estimated_usd"), "-1.23"),
        (("cost", "rate_date"), "2026-02-31"),
        (("source", "provisioning_contract"), "2.0.0"),
        (("source", "vault_contract"), "0.15.0"),
    ]
    for path, value in mutations:
        record = _passed_record()
        _set_nested(_prerequisite(record), path, value)

        errors = evidence.validate_record(record, require_passed=True)

        assert "Creek pilot prerequisite is missing or invalid" in errors

    record = _passed_record()
    _prerequisite(record)["private_context"] = {"looked_safe": True}
    assert "Creek pilot prerequisite is missing or invalid" in evidence.validate_record(
        record, require_passed=True
    )


@pytest.mark.parametrize(
    "observed_at",
    ["2026-09-01T12:00:00Z", "2026-09-15T12:00:00Z", "2026-02-31T12:00:00Z"],
)
def test_check_evidence_references_are_time_bounded(observed_at: str) -> None:
    record = _passed_record()
    refs = cast(
        "list[dict[str, object]]",
        _check(record, evidence.REQUIRED_CHECKS[0])["evidence_refs"],
    )
    refs[0]["observed_at"] = observed_at

    errors = evidence.validate_record(record, require_passed=True)

    assert "evidence references must be immutable, time-bounded, and secret-free" in errors


def test_boolean_schema_version_is_not_integer_one() -> None:
    record = _passed_record()
    record["schema_version"] = True

    errors = evidence.validate_record(record, require_passed=True)

    assert "record has unsupported schema_version" in errors


def test_impossible_execution_date_is_rejected() -> None:
    record = _passed_record()
    record["executed_at"] = "2026-02-31T12:30:00Z"

    errors = evidence.validate_record(record, require_passed=True)

    assert "executed record requires a UTC second-precision timestamp" in errors


@pytest.mark.parametrize("missing", evidence.REQUIRED_CHECKS)
def test_every_acceptance_check_is_mandatory(missing: str) -> None:
    record = _passed_record()
    del _mapping(record, "checks")[missing]

    errors = evidence.validate_record(record, require_passed=True)

    assert "checks must contain the exact required acceptance set" in errors


def test_passed_record_cannot_hide_pending_or_failed_check() -> None:
    for outcome in ("pending", "failed", "blocked"):
        record = _passed_record()
        _check(record, evidence.REQUIRED_CHECKS[0])["outcome"] = outcome

        errors = evidence.validate_record(record, require_passed=True)

        assert "every acceptance check must be passed" in errors


@pytest.mark.parametrize(
    ("check", "fact", "unsafe_value", "expected_error"),
    [
        ("create_restart_singleton", "allocation_scoped_apps", 2, "required invariants"),
        (
            "create_restart_singleton",
            "unexpected_billable_resources",
            1,
            "required invariants",
        ),
        ("intimate_zero_remote_contact", "model_call_delta", 1, "required invariants"),
        (
            "confirmed_idempotent_teardown",
            "allocation_scoped_volumes",
            1,
            "required invariants",
        ),
        (
            "exact_main_gates",
            "adepthood_product_gates_green",
            1,
            "closed primitive observations",
        ),
        (
            "fleet_disable_and_cost_reconciliation",
            "unknown_cost_inputs_treated_as_zero",
            True,
            "required invariants",
        ),
    ],
)
def test_passed_facts_must_match_the_acceptance_invariants(
    check: str,
    fact: str,
    unsafe_value: object,
    expected_error: str,
) -> None:
    record = _passed_record()
    facts = cast("dict[str, object]", _check(record, check)["facts"])
    facts[fact] = unsafe_value

    errors = evidence.validate_record(record, require_passed=True)

    assert any(expected_error in error for error in errors)


def test_acceptance_fact_shapes_are_closed() -> None:
    record = _passed_record()
    facts = cast(
        "dict[str, object]",
        _check(record, "create_restart_singleton")["facts"],
    )
    facts["raw_provider_response"] = "looked fine"

    errors = evidence.validate_record(record, require_passed=True)

    assert "acceptance facts have unknown or missing fields" in errors


def test_nonpassing_string_fact_cannot_become_a_secret_paste_field() -> None:
    record = _passed_record()
    record["status"] = "failed"
    check = _check(record, "railway_secret_file_mounts")
    check["outcome"] = "failed"
    facts = cast("dict[str, object]", check["facts"])
    leaked = "raw-bearer-value"
    facts["control_bearer_transport"] = leaked

    errors = evidence.validate_record(record, require_passed=False)

    assert "acceptance facts must be closed primitive observations" in errors
    assert all(leaked not in error for error in errors)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("adepthood_sha", "abc123"),
        ("creek_sha", "g" * 40),
        ("vault_image_digest", "latest"),
        ("vault_image_digest", f"sha256:{'0' * 63}"),
        ("control_plane_image_digest", "latest"),
        ("provisioning_contract", "v2"),
        ("vault_contract", "main"),
    ],
)
def test_exact_revision_coordinates_are_required(field: str, value: str) -> None:
    record = _passed_record()
    _mapping(record, "revisions")[field] = value

    errors = evidence.validate_record(record, require_passed=True)

    assert "revisions contain invalid exact coordinates" in errors


def test_provider_managed_non_attested_claim_is_fixed() -> None:
    for key, value in (
        ("custody_mode", "user_managed"),
        ("attested_confidential", True),
    ):
        record = _passed_record()
        _mapping(record, "claims")[key] = value

        errors = evidence.validate_record(record, require_passed=True)

        assert "claims must be provider_managed and non-attested" in errors


@pytest.mark.parametrize(
    "unsafe_ref",
    [
        "operator-observation:proof-1",
        {"kind": "raw_log", "observed_at": "2026-09-14T12:30:00Z", "sha256": _ARTIFACT_DIGEST},
        {"kind": "operator_observation", "observed_at": "yesterday", "sha256": _ARTIFACT_DIGEST},
        {"kind": "operator_observation", "observed_at": "2026-09-14T12:30:00Z", "sha256": "latest"},
        {
            "kind": "operator_observation",
            "observed_at": "2026-09-14T12:30:00Z",
            "sha256": _ARTIFACT_DIGEST,
            "path": "raw.log",
        },
    ],
)
def test_evidence_references_require_closed_immutable_artifacts(unsafe_ref: object) -> None:
    record = _passed_record()
    _check(record, evidence.REQUIRED_CHECKS[0])["evidence_refs"] = [unsafe_ref]

    errors = evidence.validate_record(record, require_passed=True)

    assert "evidence references must be immutable, time-bounded, and secret-free" in errors


def test_unknown_fields_fail_closed() -> None:
    record = _passed_record()
    record["user_id"] = 42
    _mapping(record, "revisions")["vault_url"] = "https://vault.example.test"
    _check(record, evidence.REQUIRED_CHECKS[0])["notes"] = "raw log"

    errors = evidence.validate_record(record, require_passed=True)

    assert "record has unknown or missing fields" in errors
    assert "revisions have unknown or missing fields" in errors
    assert "acceptance checks have unknown or missing fields" in errors


def test_cli_never_echoes_a_rejected_secret(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    record = copy.deepcopy(_passed_record())
    leaked = "Bearer should-never-enter-output"
    _check(record, evidence.REQUIRED_CHECKS[0])["evidence_refs"] = [leaked]
    path = tmp_path / "evidence.json"
    path.write_text(json.dumps(record), encoding="utf-8")

    assert evidence.main([str(path)]) == evidence.EXIT_INVALID
    output = capsys.readouterr()
    assert leaked not in output.out
    assert leaked not in output.err


def test_cli_requires_a_real_pass_by_default(tmp_path: Path) -> None:
    path = tmp_path / "pending.json"
    path.write_text(_TEMPLATE.read_text(encoding="utf-8"), encoding="utf-8")

    assert evidence.main([str(path)]) == evidence.EXIT_INCOMPLETE


def test_cli_accepts_a_complete_pass(tmp_path: Path) -> None:
    path = tmp_path / "passed.json"
    path.write_text(json.dumps(_passed_record()), encoding="utf-8")

    assert evidence.main([str(path)]) == evidence.EXIT_PASSED


def test_cli_rejects_unreadable_json_without_echoing_input(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    path = tmp_path / "malformed.json"
    marker = "should-not-be-echoed"
    path.write_text(f'{{"{marker}"', encoding="utf-8")

    assert evidence.main([str(path)]) == evidence.EXIT_INVALID
    output = capsys.readouterr()
    assert marker not in output.out
    assert marker not in output.err
