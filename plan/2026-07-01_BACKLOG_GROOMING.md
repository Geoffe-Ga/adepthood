# Backlog Grooming — 2026-07-01

Deep review of all 78 open issues: verified each against main (`eba7703`) and
the live Dependabot PR set, sharpened the complex decisions, and fixed the
places where the plan of attack contradicted itself.

## Headline findings

### 1. The Creek Vault epic contradicts its own ratified decision (#949 family)

Three statements could not all be true:

- **#952/#953** forbid intimate content from ever crossing the
  adepthood→vault seam (inherited from #895's cloud-LLM guard).
- **#927 (ratified 2026-06-30)** pays for TEE + remote attestation + GPU-CC
  precisely so *"even INTIMATE content gets good-quality voice while staying
  private"* — which requires the vault to have the intimate content.
- **Reality:** intimate entries live in operator-decryptable Postgres
  (`JOURNAL_ENCRYPTION_KEYS` is operator-held Fernet), a strictly weaker
  store than the user-held-key vault.

Under the plan as written the custody gradient is **inverted**: the least
sensitive writing graduates to the strongest store while the most sensitive
writing stays permanently in the weakest one. Resolution: full analysis
posted on #949; #950's acceptance criteria now require the contract to
decide the intimate-transit rule explicitly (transit topology, write/read
asymmetry, reflection-output provenance, custody end-state); provisional-rule
warnings posted on #952/#953, which stay `blocked` until the contract answers.

### 2. Decision issues that were already decided

- **#927** — every fork (hosting, custody, routing, recovery) was ratified
  in-thread, but the body still claimed the recovery model was open. Body
  corrected, closed as completed.
- **#898 (ADR 0002)** — its options were folded into #927 and resolved, but
  the ADR file was never written. Rescoped from `decision(privacy)` into a
  concrete, unblocked docs task: write `docs/adr/0002` recording the ratified
  outcome (and naming the #950 intimate-transit residual rather than
  overstating).
- **#945 (Map "balance vs altitude")** — owner-decided in-body; removed the
  stale `question` label and pointed the implementer at the exact wordlist
  test (`MapScreen.test.tsx:359`).

### 3. Latent sequencing traps defused

- **#944 (upward-wave Map)** hard-depends on #945: the live banned-words
  regex (`level|climb|ascend|higher|rank|altitude|ladder`) would force the
  wave's own copy to be watered down or the test weakened in-PR.
- **#1018 (medicinal/toxic)** is now `blocked` on #1021 (vendored curriculum
  dataset): its own AC requires copy from the dataset, but #1021 sat a
  priority tier *below* it and a higher issue number — the picker would have
  taken #1018 first and forced hand-authored copy. #1021 bumped to
  priority-medium (priority-inversion fix).
- **#1023 (intimate care surface)** bumped to priority-high (crisis-care gap
  on the entries most likely to hold distress) with a sequencing constraint:
  land #1005 (negation-blind distress screen) first, or the intimate path
  would surface the crisis panel on denials ("I would never...").

### 4. Operator-decision analysis posted

- **#623 (resonance economy)** — recommended option 1 (keep pass=1-unit,
  essays free) with the boundedness argument: essays are idempotent per
  margin note, notes exist only via wallet-bounded passes, and a 10/min
  limiter caps bursts — so worst-case spend is a bounded multiple of
  wallet-linked usage. Recorded the flip condition (essay/pass cost ratio
  ≳5× or note count growth) and the cheap hedge (`ESSAY_PRICE_UNITS = 1`
  for second+ essays per pass).

## Dependabot cluster (25 issues → 9 actionable)

Verified every referenced PR live:

- **Closed 9 as superseded duplicates** (Dependabot had closed their PRs for
  group/newer successors): #963→#998, #964/#966/#967/#968→#987, #965→#978,
  #970/#972/#973→#975.
- **Closed 1 obsolete:** #974 (pydantic 2.13.4 already on main; PR #252 stale).
- **Marked 3 `blocked` on #885 (Expo SDK 53):** #961 (expo-keep-awake), #962
  (gesture-handler 3.x), #980 (expo-image-picker) — SDK-tied majors that
  must move via `expo install`, per #885's own coordination note.
- **Annotated:** #969 (scope reduced to one file — `weekly-deslop.yml` still
  on checkout v6), #978 (verify the 18-package batch against SDK pins),
  #998 (commitlint 21 requires Node ≥ 22).
- **#994 root-cause redirect:** `--label dependencies` has always been in the
  reconciler workflow, yet post-#994 issues still arrive unlabeled — the
  likely cause is PAT permissions silently dropping labels, not quoting.
  Backfilled the `dependencies` label on all 9 unlabeled adopt-issues.

## Resolution verification (28 issues checked against main)

- **Closed #1062** — fixed in PR #1061 (`jest.setTimeout(15000)`).
- **#1009 rescoped** — `checkInResultSchema` is now wired; remaining scope is
  `unknownRecord` + 3 unwired response schemas.
- **Epic status posted on #934** (2/5 done: #935/#936 shipped via PRs
  #1065/#1067; #937/#938/#939 confirmed still broken at file:line) and
  **#716** (all code tiers + first pin shipped; only #723 remains, correctly
  blocked on the content repo; #938 flagged as the epic's production
  verification gate).
- All other de-slop findings (#1005–#1014, #1043–#1046, #1054, #1063,
  #1026/#1027, #1034, #1050) verified **still open** with current evidence —
  no stale issues found beyond the above.

## Statistics

- Issues reviewed: 78 (all open) · PRs/commits cross-checked: ~30
- Closed: 12 (9 duplicates, 1 obsolete, 1 resolved, 1 decided → #927)
- Bodies rewritten/rescoped: 4 (#898, #927, #950, plus #945 label rescope)
- Priority/label corrections: 8 (#1021 ↑, #1023 ↑, #1018 +blocked,
  #961/#962/#980 +blocked, #945 −question, 9 label backfills)
- Substantive analysis comments: 12
- New issues: 0 (every gap found already had a home; the one conditional
  follow-up — custody inversion if #950 defers intimate ingest — is encoded
  in #950's AC)
- Backlog: 78 open → 66 open, every remaining `blocked` label now traceable
  to a concrete unblocking event
