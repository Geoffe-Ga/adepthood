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
The backend image pins the application identity at `10001:10001`; do not assume
a platform default such as uid 1000. Railway initially presents a newly attached
volume as root-owned, so the image starts through a fixed root startup bootstrap.
When managed activation is unset or explicitly false, the bootstrap skips the
volume only when the secret path is absent and both managed bearer-path
settings are unset, then still drops to `10001:10001`; ordinary and BYOV
service startup therefore does not depend on a managed-pilot mount. A disabled
preparation deploy with the path present must prove the exact durable mount
before it is normalized. Retaining either bearer path for existing lifecycle
recovery also requires that exact mount and refuses startup if the attachment
is missing; a present ephemeral directory is never accepted. A true or
malformed activation setting is an enabled/preparing state and must follow the
durable mount path below rather than silently behaving as disabled.
That bootstrap initializes and chowns only `/run/adepthood-secrets` to
`10001:10001` with mode `0700`. Before any mutation it rejects a symlink, a
non-directory, or a path that is not its own exact entry in
`/proc/self/mountinfo`; a missing Railway volume therefore refuses startup
instead of silently using ephemeral container storage. It clears supplementary groups, sets
no-new-privileges, and irreversibly drops to `10001:10001` before Alembic or
uvicorn starts. It never walks or rewrites bearer files, and the application
never runs as root. Do not override the entrypoint and do not set
`RAILWAY_RUN_UID=0`.

With managed activation disabled, attach the dedicated runtime volume and
deploy the ordinary image once so its startup bootstrap prepares the mount.
Then open an authorized Railway SSH/SFTP session and record its effective
numeric identity; root access is neither assumed nor required. A root session
must install the staged file as `10001:10001`, while a `10001:10001` session
creates it directly. Prepare each bearer locally as a `0400` file, then upload
it into that protected directory as an owner-only
`.new` file. A bearer value is never a Railway variable and is never pasted
into a shell, argument, log, or transcript. The staged file must be owned by
`10001:10001` and have exact mode `0400`. Validate
with `lstat`/file-descriptor metadata only: it must be a regular non-symlink,
owner-matched, non-empty, and at most 4,096 bytes. Use an atomic rename on the
same volume to install `/run/adepthood-secrets/creek-control-bearer` and
`/run/adepthood-secrets/creek-handoff-bearer`. On any failed validation, remove
the staged file and keep activation disabled; the ordinary journal remains
available throughout the disabled bootstrap. The application then validates
one non-empty visible-ASCII bearer line (`0x21`–`0x7e`, with at most one terminal
LF); a space, tab, control, embedded line break, or non-ASCII character keeps
the rollout incomplete rather than failing later during HTTP-header creation.
Restart the ordinary `10001:10001` image, re-stat both final paths, and require
the content-free rollout state to become ready before admitting an account.
`CREEK_PROVISIONING_URL` is the public HTTPS Creek control-plane origin and is
the only provider address configured in Adepthood.
`CREEK_MANAGED_VAULT_ALERT_EMAIL` names the approved operator mailbox. Creek
authenticates the exact `/internal/vault-provisioning/alerts` callback with the
same mounted handoff bearer; its request and resulting email are both
content-free alert-kind counts, with no resource subject, identity, provider
resource, path, URL, exception, or journal material. The synthetic account's
numeric id is placed in the deployment's private
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
- provisioning and `/v1` semantic contract versions;
- the backend and frontend served releases (see "Serving receipt" below).

Confirm the provider fleet report and Adepthood database show no allocation or
connection for the disposable identity. Confirm the hard provider-side live
allocation cap and billing alert from #1806. A dirty baseline is a blocker, not
something to subtract mentally from later counts.

## Serving receipt

The backend and frontend deploy independently on Railway (each service watches
only its own directory), so after a backend-only commit the frontend can still
be serving an older build. Before the run, redeploy **both** services at the
same `adepthood_sha`, and confirm `RAILWAY_GIT_COMMIT_SHA` is present on the
backend service; without it the receipt reports `release: "unknown"` and the
record cannot pass.

Throughout the run window, repeatedly sample the operator-only
`GET /admin/serving-receipt` with an admin JWT. It is content-free and closed:
the platform's exact commit SHA (or `unknown`), the content pin, the egress
barrier and managed-rollout *states*, the pinned Creek contract, and the
custody vocabulary. It never names a pilot account, URL, bearer path, or
configured secret, and it reports `attested_confidential: false` and
`local_model: "unknown"`. Store each sanitized capture privately and reference
it only by its `sha256` in `evidence_refs`.

Record `backend_served_release` and `frontend_served_release` in `revisions`;
a passed record requires both to equal `adepthood_sha`. Record the closed
observations as `serving_receipts`: both receipts present, zero responses from
a different release, zero responses from a legacy build that serves no
receipt, a `ready` egress barrier and managed rollout, attestation reported
`false`, and `local_model_claim` `unknown`. These counts and states are your
observations of the sampled receipts, backed by the hashed captures; the
validator checks the facts, not the captures. On a failed run, write `null`
for any state fact that was not the required value and explain it only in the
sanitized artifact. A drifted served release may be recorded as the exact SHA
that answered, never as a label.

Two limits apply to schema v3. The frontend build receipt is not shipped yet
(#2871 AC23), so there is nothing to observe for `frontend_receipt_present` or
`frontend_served_release`. Until it ships, record both as `null` and do not
mark the record passed. The validator requires both on a passed record but
cannot tell whether a frontend receipt exists, so copying the backend SHA would
satisfy it without being true; this is an operator obligation, not a check.
And `local_model_claim` stays `unknown` until a model digest and inference
probe exist (B05/B07); claiming local-model readiness needs a later schema
version.

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
drills, allocation-scoped cardinality, the canonical `fleet_report` artifact,
report/alert/reconcile outcomes, both
restore drills, non-destructive emergency recovery, reconciled aggregate cost,
exact-main gates, independent exact-head LGTM, and the exact set of private
artifact timestamps and SHA-256 hashes. The outer validator binds those source,
image, contract, deployment, and review coordinates back to this record. A
missing, mismatched, non-passing, stale, open-ended, or partially copied block
invalidates the entire record.

## Execution protocol

### 1. Railway mounts and server-side admission

Complete the disabled runtime-volume bootstrap above, mount the two bearer
files, configure the public Creek URL, operator alert destination, and
one-account allowlist, then enable new activation. Redeploy without printing
environment values. The Adepthood
startup event must report a ready rollout and cohort count only. Privately
capture metadata-only proof of uid/gid `10001:10001`, directory mode `0700`,
file mode `0400`, regular/non-symlink and single-link status, distinct control
and handoff bearer values (boolean only; never values or digests), the completed
runtime volume bootstrap, and the 1–4,096-byte bounds. A second authenticated synthetic account
must receive the same unavailable response as every ineligible account and
create no Adepthood activation row or Creek request. Record these closed facts
as `railway_secret_file_mounts`.

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
- `serving_receipts`

This file deliberately contains no dated “passed” statement. The dated JSON
record is created only by the real authorized execution and is accepted only by
the validator plus independent review.
