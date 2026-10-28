> **Draft — owner ratification required.** Nothing in this document is an
> operational commitment until the owner named below accepts it. Every
> `[OPERATOR]` field is unfilled on purpose. (#3075)

# Privacy incident response (draft)

This is the procedure for a suspected or confirmed privacy incident in the
Adepthood backend: what to switch off first, how to confirm it took effect,
how to revoke credentials, and how to decide who must be told.

It is written for the people who operate the deployment. It is **not** user
copy, and it promises users nothing. Publishing any operational privacy
commitment waits until the owner has accepted a rehearsed version of this
runbook (#3075 release gate).

## 0. Ownership

| Role | Who | How to reach them |
|---|---|---|
| Privacy owner (accountable, ratifies this runbook) | [OPERATOR] | [OPERATOR] |
| Incident lead (runs the steps below) | [OPERATOR] | [OPERATOR] |
| Notification reviewer (decides legal duties, §6) | [OPERATOR] | [OPERATOR] |
| Security mailbox (`SECURITY_CONTACT_ADDRESS`) | [OPERATOR]. The default is an unroutable `.example` address. | [OPERATOR] |

There is no staffed on-call rotation and no 24/7 coverage (§8). Response
targets below are `[OPERATOR]` until the owner sets them.

## 1. Severity matrix

| Severity | Meaning | Examples | First action | Target to safe state |
|---|---|---|---|---|
| SEV-1 | Journal content of identifiable users has reached, or is reaching, a party it must not reach | A content canary in a vendor or log sink. A leaked provider or vault credential in active use. Intimate content sent to a model | Flip the relevant suspension switch(es) in §2 now, before you investigate | [OPERATOR] |
| SEV-2 | A control is broken, but there is no evidence that content has reached the wrong party | A guard bypassed in a release. A vendor policy change. A stuck account deletion | Flip the switch for the affected path, then investigate | [OPERATOR] |
| SEV-3 | A weakness with no live exposure | A misconfigured, unused credential. A documentation overclaim | Fix it in the normal flow and record it | [OPERATOR] |

When in doubt, treat the incident as the higher severity. Every switch only
narrows what the deployment does, so flipping one by mistake loses nothing a
user has written.

## 2. Controls

These four controls are environment variables on the backend service. Set one
in the platform's variables panel, then restart or redeploy the service. Each
switch is read at call time, so a restart is all it takes.

| Control | What it refuses | What keeps working |
|---|---|---|
| `PRIVACY_SUSPEND_EXTERNAL_AI` | Every cloud language-model call: server-paid **and** BYOK. It refuses before any provider client is built. Resonance, essay letters, completion detection and page transcription answer `503 ai_suspended` and charge nothing. | Journal create, read and edit. Export. Account deletion. A cached essay letter. The care surface for an intimate entry. Classification on a write degrades to unclassified, and the entry is saved. |
| `PRIVACY_SUSPEND_VAULT_SEND` | Every content-bearing Creek vault request: ingest, reflection, upload, Voice Draft upsert, and the pipeline classify and link steps. | The capability probe, job polls and the wheel read. The content-free journal withdrawal and Voice Draft deletion. Teardown reconciliation. |
| `BOTMASON_DAILY_GENERATION_CEILING` set to `0` | Every *charged* generation. | BYOK generations. They are never charged, so this control does not stop them: use `PRIVACY_SUSPEND_EXTERNAL_AI` for that. |
| `CREEK_MANAGED_VAULT_ACTIVATION_ENABLED` set to `false` | **New** managed-vault activations. | Existing vaults keep replicating. Use `PRIVACY_SUSPEND_VAULT_SEND` to stop that. |

For both suspension switches, **only unset, empty or `false` is off**. Every
other value suspends, including `0`, `off`, `no` and a typo. The two switches
are independent, so flip both for zero external egress of content.

**Confirm the safe state.** Do not rely on having typed the variable:

1. The boot log of each restarted worker carries one line,
   `privacy_suspension_state active=<names>`. A value that is not a recognised
   spelling adds one `privacy_suspension_value_malformed` warning, naming the
   variable but never its value.
2. `GET /admin/privacy-suspensions` (admin only) returns
   `{"external_ai_suspended": …, "vault_send_suspended": …}` from the serving
   process. That response is the "time to safe state" probe: record the time
   it first reads `true`.
3. `GET /admin/vault-teardowns` (admin only) lists every unconfirmed managed
   vault teardown, with the time it was requested in `pending_since` (§5).

The register of every party that receives user data, and through which code
path, is `backend/src/privacy/recipients.py`. Use it to decide which control
covers a given recipient. Do not restate it here.

## 3. Claim → control → recovery evidence

Provisional: the claim ids follow the #3057 claim ledger, which has not yet
landed. Each row says what stops further harm to the claim during an incident,
and what proves the claim holds again afterwards.

| Claim | Statement (short) | Control during the incident | Recovery evidence |
|---|---|---|---|
| C04 | Journal content will not train AI models | `PRIVACY_SUSPEND_EXTERNAL_AI` | Vendor terms re-verified against the register (owner). The probe reads `true` until they are. |
| C05 | Journal content will not be used to sell to users | `PRIVACY_SUSPEND_EXTERNAL_AI` and `PRIVACY_SUSPEND_VAULT_SEND` | The register shows no new recipient. Vendor terms re-verified (owner). |
| C06 | Journal content will not be sold or disclosed for others' purposes | `PRIVACY_SUSPEND_EXTERNAL_AI` and `PRIVACY_SUSPEND_VAULT_SEND` | As C05, and each processor's purpose re-attested (owner). |
| C07 | Intimate entries do not leave the primary journal boundary | `PRIVACY_SUSPEND_EXTERNAL_AI` and `PRIVACY_SUSPEND_VAULT_SEND` | The intimate-floor test suite is green on the serving build. |
| C08 | Intimate entries are not used for AI inference | `PRIVACY_SUSPEND_EXTERNAL_AI` | As C07. |
| C09 | Intimate entries are not indexed or ontologized | `PRIVACY_SUSPEND_EXTERNAL_AI` and `PRIVACY_SUSPEND_VAULT_SEND` | As C07, and no corpus fragment exists for an intimate entry. |
| C10 | Intimate entries are not context for other entries | `PRIVACY_SUSPEND_EXTERNAL_AI` | As C07. |
| C11 | Intimate entries are not replicated to Creek | `PRIVACY_SUSPEND_VAULT_SEND`; `GET /admin/vault-teardowns` | Withdrawals for the affected entries landed (§5). |
| C12 | Intimate content is absent from logs and telemetry | Unset `SENTRY_DSN`; `PRIVACY_SUSPEND_EXTERNAL_AI` | A canary test over the telemetry sinks is green (depends on #3064). |
| C13 | A vault reflects with local models in the private boundary | `PRIVACY_SUSPEND_VAULT_SEND`; `CREEK_MANAGED_VAULT_ACTIVATION_ENABLED` | The serving build's vault route is proven (depends on #2871). |
| C21 | Deleting or marking Intimate removes prior copies | `GET /admin/vault-teardowns`; withdrawals continue under `PRIVACY_SUSPEND_VAULT_SEND` | Every listed teardown is confirmed, and none is still pending (§5). |
| C24 | Policy, deployment and tests prove the promises | `GET /admin/privacy-suspensions` | The tabletop tests in §7 are green on the serving build. |

## 4. Credential revocation

Flip the matching switch **first**, so that nothing is sent while a credential
is being replaced. Then:

- **Provider key (`LLM_API_KEY`).** With `PRIVACY_SUSPEND_EXTERNAL_AI` on,
  revoke the key in the provider's console, set the new one, restart, confirm
  the probe, then unset the switch. Rehearsed by
  `test_tabletop::test_compromised_llm_key`. A BYOK key belongs to its user.
  The switch stops the deployment from using it, and only the user can revoke
  it.
- **All sessions (`SECRET_KEY`).** Rotating it invalidates every issued token
  at once, and everyone has to sign in again. Generate the new value as
  `DEPLOYMENT.md` describes, set it, then restart.
- **One user's sessions.** Setting that user's `password_changed_at` to the
  current time rejects every token issued before it. A password reset does the
  same. Rehearsed by
  `test_tabletop::test_compromised_session_revoked_by_password_changed_at`.
- **Creek bearers.** The provisioning bearer and the handoff bearer are
  mounted files (`CREEK_PROVISIONING_AUTH_FILE`,
  `CREEK_PROVISIONING_HANDOFF_AUTH_FILE`), never environment values. Rotate
  each at Creek, replace the mounted file, and restart. The single-owner vault
  bearer is read from the environment. It is not yet in the `DEPLOYMENT.md`
  reference, so the owner must document it before it can be rehearsed.
- **Journal encryption key (`JOURNAL_ENCRYPTION_KEYS`). ESCALATION, owner
  only.** Rotation in place prepends a new key and never re-encrypts existing
  rows, so a leaked key still decrypts every row written under it. Recovering
  from a compromise means re-encrypting under a new key and retiring the old
  one. That is a data migration and a custody decision, and it is
  irreversible once the old key is destroyed. Do not improvise it.

## 5. Withdrawal and teardown reconciliation

Vault withdrawals and deletions are content-free, so they keep running under
`PRIVACY_SUSPEND_VAULT_SEND`. That is deliberate: an incident is when a stuck
deletion most needs to land.

1. `GET /admin/vault-teardowns` lists each unconfirmed teardown with its
   `state`, `attempts`, `retryable`, `failure_reason` and `pending_since`.
   `pending_since` is when the teardown was **requested**, not when it was
   last retried, so a stuck deletion keeps its true age across retries.
2. A teardown that stays pending past [OPERATOR] is a SEV-2. Escalate it to
   Creek with its `creek_job_id`. Never send journal content.
3. Entries written while `PRIVACY_SUSPEND_VAULT_SEND` was on are not
   re-ingested automatically when it is unset. Recovering them depends on
   #3060. Their refused sends are recorded as suspended, not degraded
   (#3107): they owe no withdrawal and add no teardown or obligation here.
   An entry that already had a vault copy keeps owing that copy's withdrawal.

Rehearsed by `test_tabletop::test_stuck_deletion_visible_and_withdraw_continues`.

## 6. Notification decision

Whether, when and whom to notify (regulators, affected users) is a **legal
determination**. The notification reviewer named in §0 makes it, not the
incident lead. The incident lead's job is to hand the reviewer:

- the time of detection, and the time the probe first read the safe state;
- which controls were flipped, and when;
- which recipients from `backend/src/privacy/recipients.py` were involved;
- the affected account count, as a number. No account list goes into a
  ticket.

Timing, jurisdiction and wording: [OPERATOR].

## 7. Tabletop scenarios

Each scenario is an automated test in
`backend/tests/incident/test_tabletop.py`. For each step, the test records what
the system was observed to do (a status code, the requests that reached a fake
provider or vault, a listed row). It then asserts the whole sequence: unsafe
before the operator acts, safe after. A live rehearsal on the real deployment
is the owner's (#3075).

| Scenario | Safe state reached by | Test |
|---|---|---|
| (a) A content canary is found at an external provider | `PRIVACY_SUSPEND_EXTERNAL_AI` | `test_tabletop::test_canary_leak_contained_by_ai_switch` |
| (b) A compromised provider key | Switch on, swap `LLM_API_KEY`, switch off | `test_tabletop::test_compromised_llm_key` |
| (c) A compromised user session | `password_changed_at` | `test_tabletop::test_compromised_session_revoked_by_password_changed_at` |
| (d) The AI budget is exhausted | `BOTMASON_DAILY_GENERATION_CEILING` set to `0`, plus `PRIVACY_SUSPEND_EXTERNAL_AI` for BYOK | `test_tabletop::test_budget_exhaustion_ceiling_zero_then_switch_for_byok` |
| (e) False model readiness at the vault | `PRIVACY_SUSPEND_VAULT_SEND` | `test_tabletop::test_false_model_readiness_contained_by_vault_send_switch` |
| (f) A stuck deletion | `GET /admin/vault-teardowns`; withdrawals continue | `test_tabletop::test_stuck_deletion_visible_and_withdraw_continues` |
| (g) A vendor changes its data policy | `PRIVACY_SUSPEND_EXTERNAL_AI` | `test_tabletop::test_vendor_policy_change` |

## 8. Non-goals

- There is **no** 24/7 coverage, **no** on-call rotation and **no** paging.
  Nothing here should be read as promising any of them.
- Journal content never goes into a ticket, a chat, an email or a log while
  you handle an incident. Refer to entries and accounts by id only.
- This runbook makes no legal-compliance claim.

## 9. Known side effects of the switches

- `PRIVACY_SUSPEND_VAULT_SEND` also refuses the pipeline's classify and link
  steps. The stage ends on the first attempt the switch refuses, with the log
  line `creek vault pipeline stage suspended by operator`, and is not retried
  further. That holds for a fresh stage, for a retry of a stage already in
  flight when the switch was set, and for a stage resumed at startup. A
  refusal proves only that *its own* attempt never left the process, so the
  run's outcome depends on its earlier attempts. It is recorded `failed` when
  no attempt could have reached the vault: a fresh stage, or one whose earlier
  job definitively failed. It is recorded `ambiguous` when an earlier attempt
  went out and was never answered, so it may have landed; count it as possible
  egress. Nothing re-runs the stage when the
  switch is unset: it runs again only when a later trigger (a new journal
  write, for example) starts a new pipeline run. That is expected, not a
  second incident.
- Entries written under the vault-send suspension are not re-sent
  automatically afterwards (§5).
- Under `PRIVACY_SUSPEND_EXTERNAL_AI`, a corpus consent grant is recorded,
  but its backfill sweep stops before the first entry and leaves every entry
  unmarked. Entries written during the suspension are saved, but not
  classified into the corpus. **Neither resumes on its own when the switch is
  unset.** The only thing that runs the backfill is the user's own consent
  grant, so the history waits until that user grants consent again (a
  repeated yes re-runs the sweep). Before closing the incident, the owner
  decides whether, and how, to invite affected users to re-grant:
  [OPERATOR]. There is no operator tool to start a sweep.
- `PRIVACY_SUSPEND_EXTERNAL_AI` refuses the resonance route before it decides
  where the reflection comes from, so for the duration a vault-bound writer
  also gets `ai_suspended` rather than a vault reflection.
