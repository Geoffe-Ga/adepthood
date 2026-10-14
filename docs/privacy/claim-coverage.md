# Privacy claim coverage: how to register a claim test

This page is for #3069 (B15, the privacy regression suite). It explains how a
forbidden-effect test is attached to a privacy claim, so that the claim's
coverage is machine-checked rather than remembered.

## The two artifacts

| Artifact | Path | What it holds |
|---|---|---|
| Sink registry | `backend/src/privacy/sinks.py` | One `Sink` row for every place user content could reach: network recipients, database columns and tables, backups, vault stores, telemetry transports, device storage, queues and process memory. Each row has a stable `SinkId`, the inventory rows it mirrors, the journal tiers that may reach it, and whether it is inside the primary journal boundary that C07 defines. |
| Claim coverage manifest | `backend/src/privacy/claim_coverage.json` | One entry for each claim from C03 to C24 in the claim ledger (#3076). Each entry has a `status`, the pytest node ids behind it, and the `SinkId`s it constrains. Every entry that is not `covered` also names an owning `issue` and a one-line `gap`. |

`backend/tests/security/test_claim_coverage_manifest.py` enforces both. It
checks structure only and never runs a claim's tests; those run in the normal
backend lane. The gate fails when any of the following is true:

- an inventory row has no sink. The inventories are the recipient register,
  the retention store inventory, the `EncryptedString` columns, the transport
  table in `docs/qa/telemetry-egress-inventory.md`, and the detached egress
  entry points;
- a sink cites an inventory row that no longer exists;
- a sink outside the primary boundary admits the `intimate` tier;
- a claim from C03 to C24 is missing or appears twice;
- a node id does not resolve to a test function, which is checked by AST
  without importing or running anything;
- a `SinkId` is not registered;
- a `partial` entry lists no test, or a `partial` or `uncovered` entry has no
  `issue` or no one-line `gap`;
- a `covered` entry does not prove every sink it names (see below).

## Registering a test against a claim

1. **Write the forbidden-effect test first.** Assert absence, such as zero
   calls, zero bytes or zero canary fragments, at the sink itself, not only a
   successful response. Use the synthetic canaries in
   `backend/tests/helpers/telemetry_canaries.py`. Never use real journal text.
   Every assertion of absence needs a positive control showing that the sink
   was actually exercised.
2. **Find the sink ids.** Look the sink up in `SinkId`. If the sink is new, add
   its row to the owning inventory first (for example a recipient row or a
   telemetry table row), then add a `SinkId` member and a `Sink` row that cites
   that inventory row. The gate will name any row you missed.
3. **Edit only your claim's entry in `claim_coverage.json`.** Add the node id
   to `tests`, written relative to the repository root
   (`backend/tests/...py::test_name`, `...::TestClass::test_name`, or a
   parametrised `...::test_name[case]`). Add any sink the claim constrains to
   `sinks`.
4. **Set the status honestly.**
   - `uncovered`: no test asserts the claim yet. Strict-xfail reproducers may
     be listed here.
   - `partial`: at least one real test asserts part of the claim. `issue` and
     `gap` say who owns the rest.
   - `covered`: every sink in `sinks` has at least one listed test asserting
     absence there. Record that in `by_sink`, a map from each sink id to its
     tests. A `covered` entry carries no `issue` or `gap`, constrains at least
     one sink, and cites no xfail.
5. **Run the gate.** Use
   `./scripts/backend/test.sh tests/security/test_claim_coverage_manifest.py`.
   It takes seconds.

Each claim group edits its own entries: C07–C11 (#3159), C12 (#3160), C13 and
C23 (#3161), and C21 (#3162). Neither the validator nor the registry needs
changing to add a test to a claim.

## Example

```json
"C12": {
  "status": "covered",
  "tests": ["backend/tests/security/test_telemetry_sentinels.py::test_x"],
  "sinks": ["telemetry.sentry_envelope"],
  "by_sink": {
    "telemetry.sentry_envelope": [
      "backend/tests/security/test_telemetry_sentinels.py::test_x"
    ]
  }
}
```

The example is illustrative. C12 is `partial` until #3160 lands.
