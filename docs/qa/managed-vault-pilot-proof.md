# Deployed managed-vault pilot proof

> Status: **blocked / not executed**. This is the proof protocol and evidence
> contract for Adepthood #2871, not a record that the pilot passed.

The ordinary API E2E lane starts a fake Creek control plane on loopback. That
lane remains valuable—it proves Adepthood's production client, routes, database
state, polling, and handoff parser—but it does not close #2871. This protocol is
the separate, explicitly authorized run against deployed Adepthood, deployed
Creek, the production routing boundary, and one disposable Fly allocation.

## Hard authorization gate

Do not run this protocol until all of the following are true:

1. `Geoffe-Ga/Creek-Vault#1806` is closed with exact reviewed and deployed
   coordinates for the bounded Fly pilot.
2. The operator has given explicit provider and billing authorization for this
   run, including its allocation ceiling and spend alert.
3. A disposable synthetic account and synthetic journal fixtures are approved.
   Never use a real person's account or writing.
4. Adepthood and Creek exact-main product checks are green, their worktrees are
   clean, and managed activation is disabled before the run begins.
5. A named operator owns rollback and teardown. Losing an interactive session
   is not permission to leave a billable resource running.

If any prerequisite is missing, keep
`managed-vault-pilot-evidence.template.json` at `status: pending` (or record a
sanitized `blocked` result in a dated copy). Do not substitute the fake Creek
lane, a local provider, a private-network shortcut, or a manually connected
vault.

## Evidence hygiene

The checked-in record is a closed, content-free index. Copy
`managed-vault-pilot-evidence.template.json` to
`docs/qa/runs/YYYY-MM-DD-managed-vault-pilot.json` only when the authorized run
starts. It must contain no bearer, provider token, reusable credential,
passphrase, recovery material, user identifier, email address, provider
resource identifier, vault URL, journal text, content digest, raw response, raw
log, screenshot, database dump, or command line.

Each `evidence_refs` item is a closed object containing an allowed evidence
`kind`, a UTC-seconds `observed_at`, and the private artifact's immutable
`sha256:` digest. Sanitize the referenced source before capture and store it
only in the approved access-controlled evidence location. The hash is an
integrity reference, not permission to check a raw artifact into git. The
validator accepts only allowed kinds and observations from the bounded
seven-day evidence window ending at `executed_at`.

Bearer bytes belong in two separately rotated owner-readable file mounts:

- `CREEK_PROVISIONING_AUTH_FILE` points to the control bearer file;
- `CREEK_PROVISIONING_HANDOFF_AUTH_FILE` points to the handoff bearer file.

In each case the bearer is a mounted file value, never an environment value,
argument, deploy command, log field, screenshot, artifact, or evidence value.
`CREEK_PROVISIONING_URL` is the public HTTPS Creek control-plane origin and is
the only address configured in Adepthood. The synthetic account's numeric id is
placed in the deployment's private
`CREEK_MANAGED_VAULT_PILOT_USER_IDS` setting but never copied into evidence.
`CREEK_MANAGED_VAULT_ACTIVATION_ENABLED` starts as `false`.

## Immutable coordinates and reset

Before enabling the allowlist, privately record the exact values the final
sanitized record will identify:

- 40-character Adepthood and Creek commit SHAs;
- immutable `sha256:` single-vault and control-plane image digests;
- Adepthood deployment revision;
- Creek control, worker, and routing deployment revisions plus the exact fleet
  schedule/job revision;
- provisioning and `/v1` semantic contract versions.

Confirm the provider fleet report and Adepthood database show no allocation or
connection for the disposable identity. Confirm the hard provider-side live
allocation cap and billing alert from #1806. A dirty baseline is a blocker, not
something to subtract mentally from later counts.

## Consumed Creek prerequisite

Creek #1806 produces the only accepted provider-side prerequisite with:

```console
creek-provisioning-pilot-evidence reduce --input <private-observations.json>
```

The command is an offline reducer. Its private input and provider identifiers
remain in the approved evidence store; its output contains a single closed
`managed_vault_pilot_prerequisite` block. Copy that block verbatim into the
same-named field in the dated Adepthood record. Do not transcribe individual
booleans by hand and do not replace the block with a prose assertion or hash
alone.

Schema version `1.0.0` binds Creek source/contract revisions, separate
control-plane and vault image digests, exact control/worker/routing deployment
and fleet schedule revisions, provider authorization, short-lived scoped token
placement and final revocation, TLS/health/storage checks, the five fault
drills, allocation-scoped cardinality, report/alert/reconcile outcomes, both
restore drills, non-destructive emergency recovery, reconciled aggregate cost,
exact-main gates, independent exact-head LGTM, and the exact set of private
artifact timestamps and SHA-256 hashes. The outer validator binds those source,
image, contract, deployment, and review coordinates back to this record. A
missing, mismatched, non-passing, stale, open-ended, or partially copied block
invalidates the entire record.

## Execution protocol

### 1. Railway mounts and server-side admission

Mount the two bearer files, configure the public Creek URL and the one-account
allowlist, then enable new activation. Redeploy without printing environment
values. The Adepthood startup event must report a ready rollout and cohort count
only. A second authenticated synthetic account must receive the same unavailable
response as every ineligible account and create no Adepthood activation row or
Creek request. Record this as `railway_secret_file_mounts`.

### 2. Explicit activation and authenticated completion

Through the deployed web UI, sign in as the eligible synthetic account and open
Settings. Before activation, confirm the UI says ordinary Fly storage has
`provider_managed` custody, can be read by Fly and privileged Adepthood or Creek
operators, is not confidential compute, restarts without the user, and never
sends INTIMATE content away. It must ask for no passphrase, recovery code,
wrapped artifact, recovery download, or confirmation ceremony.

Activate once. The Journal must remain usable while the durable state advances
asynchronously. Refresh, navigate away/back, and reconnect while polling. READY
is valid only after Creek's authenticated one-time handoff created exactly one
Adepthood connection row. The response must report `provider_managed` and
`attested_confidential=false` and expose no credential or provider handle.
Record this as `ui_activation_and_authenticated_handoff`.

### 3. Create crash/restart ordering

Reset the disposable allocation through the approved #1806 teardown procedure.
Start another activation and follow Creek's reviewed **Create after provider
create, before handoff** drill in
`docs/managed-vault-fly-pilot.md` exactly: use the approved temporary
destination-scoped callback rule, run one worker with its bounded one-job
setting, and terminate only that worker during the callback wait. Do not
terminate an arbitrary API process or alter the created Machine. Remove the
rule, restart the exact reviewed worker revision, and replay the same durable
activation—not a new identity. Confirm the converged inventory is exactly one
app, one Machine, one volume, one per-allocation credential, one provisioning
job, and one Adepthood connection row. These counts are scoped to the
disposable allocation (or reviewed managed-allocation prefix), never to every
app in the dedicated provider organization. Confirm provider-authoritative
before/after inventory contains zero unexpected billable resources. Record this as
`create_restart_singleton`.

### 4. Public route and unchanged SSRF boundary

From the deployed Adepthood service, negotiate the handed-off public HTTPS
endpoint and require the expected `/v1` contract, capability set, ownership
binding, and authentication. The endpoint must contain no `.internal`, private
IP, or provider resource handle. Re-run the repository's private-network/SSRF
guard against a rejected private destination; never weaken or bypass it for the
pilot. Record this as `public_route_capabilities_and_ssrf`.

### 5. Journal persistence and privacy ceiling

Write unique synthetic Public and Personal entries through the deployed UI.
Confirm each reaches Creek once under its correct ceiling. Stop the scale-to-zero
Machine using #1806's non-destructive procedure, read through Adepthood to wake
it, and confirm the same two synthetic entries remain available from the same
encrypted volume. Record only counts and equality outcomes, never text or a
content digest, under `public_personal_scale_to_zero_continuity`.

Write a unique synthetic INTIMATE entry while provisioning, routing, and model
attempt counters are observed on both sides. Confirm every counter delta is zero
and the entry remains locally usable. Ordinary Fly must still report
`attested_confidential=false`; do not reinterpret provider-managed encryption as
confidential compute. Record this as `intimate_zero_remote_contact`.

Across activation, restart, export, and readback, inspect browser requests,
Adepthood/Creek records, logs, and captured artifacts for any passphrase,
recovery code, wrapped recovery artifact, or reusable user-held unlock material.
All occurrence counts must be zero. Record this as
`no_user_held_recovery_material`.

### 6. Retry matrix without duplicate billing

Run every fault using the matching reviewed Creek
`docs/managed-vault-fly-pilot.md` procedure—**Provider outage**, **Callback
outage**, **Readiness timeout**, or **Routing failure**—with its privately
approved, at-most-one-hour drill window, exact destination-scoped network rule
or isolated proxy, clean baseline, rollback owner, and original durable
operation id. Production executables have no fault flag. Never improvise a
production failure by revoking a token, weakening TLS, changing an
organization-wide policy, or deleting provider resources by hand. Abort,
remove the fault, disable admission, and run clean inventory if the rule affects
another allocation, changes cardinality, or survives its approved window.

- Inject provider outage, observe an honest retryable state and intact Journal,
  restore the provider, retry, and confirm provider-authoritative inventory has
  no unexpected billable resource; the final invoice reconciliation supplies
  the separate cost evidence.
  Record `provider_outage_retry_without_duplicate_billing`.
- Inject callback outage after provider creation, confirm no false READY, restore
  Adepthood callback reachability, replay handoff, and confirm one connection
  with no unexpected billable resource in provider-authoritative inventory.
  Record `callback_outage_retry_without_duplicate_billing`.
- Inject readiness timeout, confirm the allocation remains recoverable and the
  Journal remains usable, restore readiness, and converge the same Machine with
  no unexpected billable resource in provider-authoritative inventory.
  Record `readiness_timeout_retry_without_duplicate_billing`.
- Inject public routing failure after handoff, confirm Adepthood reports
  unavailable/retryable rather than data loss, restore routing, and converge the
  same endpoint with no unexpected billable resource in provider-authoritative
  inventory. Record
  `routing_failure_retry_without_duplicate_billing`.

### 7. Confirmed, idempotent teardown

Delete the synthetic account through Adepthood. A local deletion response is not
success until Creek confirms credential revocation and absence of the Machine,
volume, and app. Confirm Adepthood and Creek retain matching content-free
receipts. Private Creek content-free receipts retain the requester/consumer
subjects and provider-allocation join needed for ownership and confirmation;
the sanitized checked-in evidence contains neither identity nor resource address.
Privately verify the join, then record only its boolean outcome. Repeat deletion
and confirm the same success with every allocation-scoped provider count still
zero. Record this as
`confirmed_idempotent_teardown`.

### 8. Fleet, emergency stop, and cost

Run the reviewed #1806 fleet report and require exit `0`, zero alerts, zero
divergences, and provider-authoritative inventory after teardown. Set
`CREEK_MANAGED_VAULT_ACTIVATION_ENABLED=false`, redeploy, and prove a new
activation cannot start while signup, Journal, existing-vault access, export,
revocation, and deletion remain available. Exercise Creek's non-destructive
disable/emergency-stop and restore only if the approved protocol requires it.

Reconcile observed provider usage against #1806's planning estimate and the
provider invoice/usage source. Record the sanitized estimate, provider total,
signed delta, rate date/source, and every unpriced input in the embedded Creek
prerequisite; unknown snapshot, egress, or rootfs inputs are unknown—not zero.
Record the final direct report fields and rollout-disable behavior as
`fleet_disable_and_cost_reconciliation`.

### 9. Exact-main gates and final verdict

After teardown, run both repositories' exact-main product CI, migration,
security, E2E, and deployment verification. Capture only immutable GitHub run
references and the resulting statuses. No expected product gate may be red or
silently skipped. Record this as `exact_main_gates`.

Fill every revision and check in the dated JSON record, then run:

```bash
cd backend
python -m scripts.managed_vault_pilot_evidence \
  ../docs/qa/runs/YYYY-MM-DD-managed-vault-pilot.json
```

Exit `0` is necessary but not sufficient: an independent reviewer must inspect
the sanitized references against this protocol. A pending, blocked, failed,
skipped, or unexplained row is not a pass. A failed run remains failed even if
teardown succeeds afterward, and teardown itself is mandatory in every outcome.

## Completion checklist

The evidence validator requires these exact rows so none can disappear in prose:

- `railway_secret_file_mounts`
- `ui_activation_and_authenticated_handoff`
- `create_restart_singleton`
- `public_route_capabilities_and_ssrf`
- `public_personal_scale_to_zero_continuity`
- `no_user_held_recovery_material`
- `intimate_zero_remote_contact`
- `provider_outage_retry_without_duplicate_billing`
- `callback_outage_retry_without_duplicate_billing`
- `readiness_timeout_retry_without_duplicate_billing`
- `routing_failure_retry_without_duplicate_billing`
- `confirmed_idempotent_teardown`
- `fleet_disable_and_cost_reconciliation`
- `exact_main_gates`

This file deliberately contains no dated “passed” statement. The dated JSON
record is created only by the real authorized execution and is accepted only by
the validator plus independent review.
