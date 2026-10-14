# Claim certification protocol

> **Draft for owner ratification (#3076). Not a policy.** Nothing here is a
> promise to users. The vocabularies, the 90-day window and the agent
> denylist are proposals for the owner to accept, change or reject.

A public claim about Adepthood (C01–C24 of the #3076 audit) may be published
only while an independent, signed, unexpired certificate backs it. This page
says how a certificate is made, what it must cite, how it lapses, and how the
gate that enforces it works.

## Three files, three questions

| File | Question it answers | Owner |
|---|---|---|
| `docs/legal/claim-ledger.json` | *What* is promised: each claim's exact sentence and its `sha256:` digest, the audit's verdict, the B-item gates it depends on, and `withheld` or `published` | B01 (this slice seeds a minimal version) |
| `backend/src/privacy/claim_coverage.json` | *What the tests prove*: which forbidden-effect tests back each claim, and whether that is `covered`, `partial` or `uncovered` (see [claim-coverage.md](../privacy/claim-coverage.md)) | B15 (#3158) |
| `docs/qa/claim-certifications.json` | *Who independently signed off*, on which tested and serving build, until when | B24 (#3076) |

Coverage and certification are different things. Coverage is what the
repository's own tests prove, and it is computed. Certification is a release
decision made **on top of** coverage: a named human who wrote none of the
work checks it, the evidence is bound to the build that is actually serving,
the owner signs the exact sentence, and the decision expires. A certificate
may not contradict coverage. When `claim_coverage.json` says a claim is
`partial` or `uncovered`, a certificate for it must carry the limitation
`forbidden_effect_coverage_partial` or `forbidden_effect_coverage_uncovered`.
It cannot certify silently.

All three files key on the same claim ids. The ledger is the only registry of
claims; the coverage manifest's ids must be a subset of it (a test enforces
this).

## Today

Every claim is `withheld` in the ledger and in the certifications. No
certificate exists, and none can exist yet: certification needs an appointed
independent reviewer and live journeys on the serving build, both owner
actions. The publish gate passes only because nothing is published. It does
not pass because of any allow-list.

## The record

Each claim has exactly one record. The schema is closed: an unknown key, an
email, a URL or free text makes the record invalid. That way no user id,
vault address or journal excerpt can be pasted into it.

| Key | Contents |
|---|---|
| `claim_id` | `C01`…`C24` |
| `status` | `withheld` or `certified` |
| `implementers` | GitHub logins of everyone who built the claim's gates |
| `reviewer` | the independent reviewer's GitHub login, or `null` |
| `tested_commits` | `{backend, frontend}`: the 40-hex commits the evidence ran at |
| `serving_receipt` | `{receipt_schema, backend_release, frontend_release, observed_on, artifact_sha256}`, copied from `GET /admin/serving-receipt` and `/build-receipt.json`, or `null` |
| `automated_evidence` | `[{kind, ref}]`: `pytest` node ids (`backend/tests/...::test_x`), `jest` files (`frontend/...test.ts`), or `journey` ids from `frontend/e2e/journeys.json` |
| `live_journey_evidence` | `[{observed_on, artifact_sha256}]`: hashed records of live synthetic journeys on the serving build |
| `required_gates` | the ledger's gate groups, each gate `{item, status, evidence_ref}`, where `evidence_ref` is `{kind: github_pull or github_issue, number}` |
| `issued_on`, `expires_on` | ISO dates |
| `release_decision` | `{decider, decided_on, sentence_sha256}`, or `null` |
| `exclusions`, `limitations` | codes from the closed vocabularies below |

A gate group is any-of. C03 and C23 need `B13` **or** `B14`, the custody
branch that was selected (B12), and never both.

## What `certified` requires

The validator (`backend/scripts/claim_certification.py`) returns
`CERTIFIED` only when every rule below holds:

1. **Independence.** At least one implementer is named. A reviewer is named.
   The reviewer is not an implementer (logins compare case-insensitively).
   The reviewer is not the loop: logins ending in `[bot]` and the exact names
   in `AGENT_LOGINS` (`claude`, `bot`, `agent`, `github-actions`, …) are
   refused. Emails such as `noreply@anthropic.com` are not logins at all, so
   they make the record invalid. The denylist is a heuristic. Appointing the
   reviewer is the owner's job.
2. **Release binding.** Both tested commits are full SHAs, and the serving
   receipts report exactly those releases. The backend and frontend deploy
   separately, so this is a pair; `unknown` never binds. `receipt_schema`
   must be one the validator knows (`1`).
3. **Automated evidence.** At least one reference is given, and every
   reference resolves. A pytest node that does not exist, a Jest file that
   does not exist, or an unregistered journey makes the record *invalid*. An
   xfail test, an `uncovered` journey, or pytest ids given without a
   collection make it *incomplete*. Unverifiable is never a pass.
4. **Live evidence.** At least one live synthetic journey record exists.
5. **Gates.** Every gate group has a `passed` gate that carries an
   `evidence_ref`.
6. **Signoff.** A human decider (not an agent login) signed the
   `sentence_sha256` of the ledger's current sentence. The digest is the raw
   UTF-8 sentence with no normalisation, so even a curly-quote edit after
   signoff is drift.
7. **Validity.** `issued_on` and every observation date are on or before
   today. `expires_on` falls at most `MAX_CERTIFICATE_AGE_DAYS` (90) after
   `issued_on`. Today is on or before `expires_on`.
8. **Limitations.** A claim the audit found `partially_true` or `misleading`
   carries at least one limitation. A claim with `partial` or `uncovered`
   forbidden-effect coverage carries the matching coverage limitation.

### Draft vocabularies

- `limitations`: `forbidden_effect_coverage_partial`,
  `forbidden_effect_coverage_uncovered`, `vendor_terms_unverified`,
  `operator_can_read`, `server_side_processing`, `residual_backup_copies`,
  `frontend_telemetry_not_driven`, `web_build_only`, `beta_scope_only`.
- `exclusions`: `excludes_backups_within_retention`, `excludes_native_apps`,
  `excludes_self_hosted_vault`, `excludes_vendor_side_retention`,
  `intimate_tier_only`.

Each code stands for a sentence the owner publishes alongside the claim. The
record carries only the code.

## Reviewer protocol

The reviewer must not have authored any of the claim's gates. The reviewer:

1. Checks out each tested commit and reruns the cited tests, including the
   forbidden-sink suite (B15) and the claim's rows in `claim_coverage.json`.
   The reviewer also performs the adversarial reproductions the claim's
   gates name.
2. Saves the collection that the validator resolves against:

   ```bash
   cd backend
   python -m pytest --collect-only -q > /tmp/collected.txt
   python -m pytest --collect-only -q -m xfail > /tmp/non-running.txt
   ```

   Marker-based collection cannot see imperative `pytest.xfail()` or
   `pytest.skip()` calls inside a test body. The reviewer confirms that no
   cited test takes one of those paths. The in-repo gate resolves node ids by
   AST (`backend/tests/support/pytest_node_ids.py`), which sees
   `@pytest.mark.xfail` but not skips. Jest references are checked for file
   existence only; the reviewer confirms that the cited cases ran.
3. Runs the live synthetic journeys on the serving production build: a fresh
   account, $0 signup, journal write/reload/edit/export/delete, Intimate
   canaries, withdrawal, backup restore, and the model stopped while the API
   stays healthy. The reviewer stores the sanitized record off-repo and
   cites only its date and `sha256:` digest.
4. Samples `GET /admin/serving-receipt` and `/build-receipt.json` during the
   run, and copies `receipt_schema` and both `release` values.
5. Fills the record and runs:

   ```bash
   cd backend
   python -m scripts.claim_certification ../docs/qa/claim-certifications.json \
       --collected /tmp/collected.txt --non-running /tmp/non-running.txt
   ```

The decider (the owner) then approves the exact sentence and date and fills
`release_decision`. Only after that may the ledger entry move to `published`.

### Exit codes

| Mode | 0 | 1 | 2 |
|---|---|---|---|
| records (default) | every record is certified | every record is well formed, and at least one is withheld, incomplete, drifted or expired | a record or input file is malformed or unsafe |
| `--gate` | both files are total and well formed, and every `published` claim has a current certificate | at least one gate problem (each is printed) | an input file is not JSON |

## Expiry and withdrawal

The publish gate is an ordinary pytest test
(`backend/tests/scripts/test_claim_publish_gate.py`), so it runs in
`check-all.sh` and in CI with no workflow change. It validates every record
against today's date. When a published claim's certificate expires, or its
sentence, gates or serving releases drift, CI turns red. That is intended.
The fix is to withdraw the claim (set it back to `withheld` and remove the
public copy) or to recertify it. Detection is automatic. Withdrawing public
copy and suspending unsafe processing are owner actions.

C24 depends on B24, so this certifier's own claim is certifiable only through
the same human release decision as every other claim.

## Content-free output

The validator prints only a claim id, a verdict, and reasons from the closed
`Reason` vocabulary. It never echoes a login, a reference or a field value.
It runs no test, spawns no process, opens no socket and reads no credential.
