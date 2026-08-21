# Backlog triage & supersession review — 2026-08-21

Joint review across `Geoffe-Ga/adepthood` (92 open) and `Geoffe-Ga/creek-vault`
(299 open). Every claim below was checked against `origin/main` at
`a786262` (adepthood) / `71b7460` (creek-vault); file:line citations are the
evidence, not paraphrase.

**Method.** All 391 open issues were cross-referenced against the merged commit
history of both repos (559 adepthood commits, 550 creek-vault commits), then
every candidate was verified against the code before being listed here.

---

## 1. Cross-repo supersession — the half neither repo's own triage can see

### 1.1 The praxis/eddies epic is unblocked upstream and nobody has noticed

`adepthood` **#1929 / #1930 / #1931** all carry `blocked`. Their blocker is gone.

creek-vault shipped contract **0.9** on 2026-08-21 (creek `#873`, merged as
PR #1567), which puts `related_praxis` and `related_eddies` on
`ReflectionResponse`:

- `creek-tools/creek_mcp/api/models.py:699` — `"""Published ceiling on ReflectionResponse.related_praxis (#873)."""`
- `creek-tools/creek_mcp/api/models.py:1374` — `"""One praxis page the reflected entry contributed to (contract 0.9, #873)."""`

adepthood is still pinned a minor behind:

- `backend/src/domain/creek_vault.py:49` — `CONTRACT_VERSION = "0.8.0"`

**Actions**
- Drop `blocked` from #1930, #1931 and epic #1929.
- **File the missing re-vendor issue** (0.8.0 → 0.9). This is the exact analogue
  of #2295, which did the 0.2.0 → 0.8.0 re-vendor and closed on 2026-08-19. It
  is the only real prerequisite left, and no open issue covers it. This is a
  backlog *gap*, not a duplicate.

### 1.2 #2171 has already decided its question

adepthood **#2171** ("decide the transport for document upload") is labeled
`P0`/`tracer` and reads as open work. It is not. The owner recorded the ruling on
2026-08-19: HTTP/JSON `/v1` is the sole seam, upstream shipped `POST /v1/uploads`
in contract 0.8.0, and the issue is being held open only as the decision record
that #2252 cites.

**Action:** close as completed pointing at #2252, or strip `P0`/`tracer` so the
backlog stops counting a settled decision as launch-critical work.

### 1.3 #2253's blocker now has an upstream owner

adepthood **#2253** ("Connect Google Drive", `blocked`) waits on a Drive
connector that partly landed: creek `#1527` shipped the read-only connector over
the network (merged #1566, 2026-08-21). The remaining half — the OAuth grant — is
tracked upstream as creek **#1568**, whose title says so outright: *"begin the
Google Drive OAuth grant over the network (the half #1527 deliberately left out)"*.

**Action:** re-point #2253 at creek #1568 as its named blocker.

### 1.4 The two repos have diverged on `openai`, deliberately on one side only

- creek-vault holds a documented transport hold: `openai>=2.41.0,<3.0.0` in
  **both** manifests (`creek-tools/pyproject.toml:91`, `crawdad/pyproject.toml:37`),
  with the reasoning inline at `creek-tools/pyproject.toml:84-85` — openai 3.0.0
  swapped `httpx` for `httpx2`.
- adepthood is on `openai==3.2.0` (`backend/requirements-lock.txt:96`), having
  closed #2292.

Neither repo's backlog records this as a decision. **Action:** one issue, in
creek-vault, noting that the hold is now a divergence rather than a shared
policy — or confirming that it should be.

### 1.5 Twins that should cross-link, not merge

Same problem, correctly filed once per repo; each pair should reference the
other so one is not fixed alone:

| adepthood | creek-vault | Subject |
|---|---|---|
| #2255 | #1528 | Seeding docs; both say "two shipped claims are false" |
| #2018 / #2019 / #2021 / #2022 | #1006 / #1007 / #1008 / #1009 | DAST epics (#2022 and #1009 share a title verbatim) |
| #2006 | #1439 | Dependabot bridge files duplicate issues |

---

## 2. Supersession inside creek-vault

### 2.1 #1532 — close as not-planned (contradicts a deliberate decision)

"Adopt Dependabot PR #1531 — update openai from `<3.0.0` to `<4.0.0`". Merged
PR #1502 put that ceiling there on purpose, with the reason in the manifest
(`creek-tools/pyproject.toml:84-91`). Adopting the bump as filed silently undoes
it. The real move is owned by **#998** (the httpx2 migration).

### 2.2 #1166 — superseded by #998

"Adopt Dependabot PR #1165 — update mcp from `<2.0.0` to `<3.0.0`". Both
manifests cap `mcp>=1.28.1,<2.0.0` (`creek-tools/pyproject.toml:26`,
`crawdad/pyproject.toml:17`), and #998 already owns that migration —
*"migrate to mcp 2.0.0 (breaking: httpx2 swap, mcp-types split,
opentelemetry-api) — both manifests cap <2.0.0"*. #1166 is the same change with
none of the migration work attached.

### 2.3 #944 and #864 — superseded by #1440

#1440 exists precisely to replace them: *"batch the 2 stalled ceiling-widening
PRs (ruff #943, mypy #863) into one three-way-synced bump — merging either as
filed splits the commit gate from CI."* #944 is "adopt PR #943"; #864 is "adopt
PR #863". Keeping all three open invites exactly the split #1440 warns about.

### 2.4 #1347 vs #1175 — a direct conflict, and #1347's premise is half stale

- **#1347** ([scan:dead-code]) wants `creek/classify/llm/batch.py` +
  `LLMClassifier.classify_batch` retired as having no production caller.
- **#1175** ([scan:coverage]) wants tests written for that same module's
  classification-failure accounting arm.

They cannot both be done. Worse, #1347's premise no longer holds in full:
`batch.py` **is** live in production —

- `creek-tools/creek/classify/llm/orchestrator.py:19` — `from creek.classify.llm.batch import run_batch`
- `creek-tools/creek/classify/llm/orchestrator.py:465` — `return run_batch(self, fragments, progress=progress)`

Only the public wrapper `LLMClassifier.classify_batch`
(`orchestrator.py:435`) lacks a production caller. **Action:** re-scope #1347 to
the wrapper alone, and settle it before #1175 spends effort testing a module
that may be shrinking.

### 2.5 Clusters that should consolidate

**Dead config / dead modules — two epics over one problem.** #1041 (epic: six
config surfaces read by nothing), #1316 (epic: six `creek/clean` modules
unreachable, whole `cleaning.*` config tree dead), #1519 (collapse duplicate
filter-config trees + six drifted defaults), #1520, #1517. One epic should absorb
the other; three members currently hang off an ambiguous parent.

**Atomic writes.** #1405 (converge three atomic-write implementations onto
`creek._fsio`) is the clean statement of the shared half of #1346 (one
`_atomic_create` copied across two writers with a drifted cap, plus dead
`VaultWriter` methods and seven sentence splitters). Split #1346's residue out or
fold it into #1405.

**Dependabot configuration — four issues, one surface.** #1178 (alerts
disabled), #1085 (pip ecosystem on `/creek-tools`, so unbounded deps never bump),
#986 (no `/crawdad` entry), #1439 (bridge re-files bridged PRs).

### 2.6 The id-index cluster is related but genuinely distinct — do not merge

#1291, #1543, #1299, #1300 and #1424 all touch fragment-id visibility, and it is
tempting to collapse them. Don't. In particular **#1291 was not fixed by the
merged #1546**: that PR stopped a non-string frontmatter key from aborting the
corpus walk; `_rebuild_index` still indexes only `isinstance(mid, str)`, as its
own test states —

- `creek-tools/tests/test_vault_writer.py:1657` — *"`_rebuild_index` only indexes ids where `isinstance(mid, str)`"*

They should be cross-linked as a cluster, not deduplicated.

---

## 3. Premises re-verified — still true, leave open

Checked because they are old enough to be suspect. All still reproduce:

| Issue | Verified against |
|---|---|
| adepthood #1419 (bell audio is silent) | all six `frontend/assets/sounds/bell-*.mp3` are still 0 bytes |
| creek #1151 (deprecated `privacy_tier_floor` alias) | `crawdad/README.md:272`, migration test `crawdad/tests/test_workflows.py:246` |
| creek #1146 (`/v1` fails open on non-HTTP scope) | `creek_mcp/httpapi/auth.py:158` and `middleware/ceiling.py:80` both `pass_through` |
| creek #1144 (contract version absent from `Vary`) | standing `Vary` is `X-Creek-Tier-Ceiling, Authorization` — `creek_mcp/httpapi/errors.py:20` |
| creek #1057 (`MessageCapture.backfill` orphaned) | defined `crawdad/crawdad/capture.py:174`, no production caller |
| adepthood #2264 (playbook WIP deadlock) | still tripped — #2214 (`playbook`) is still open |

---

## 4. Hygiene findings

**Closing-keyword hygiene is clean in both repos.** Across 559 adepthood and 550
creek-vault commits on `main`, **no** open issue in either repo is named by a
`Closes` / `Fixes` / `Resolves` keyword in a merged commit. Nothing is silently
already-done. That is unusual and worth keeping.

**adepthood's `tracer-obsolete` label carries no description** and its three
issues (#2126, #2259, #2264) read as live problems — #2264's premise was
re-verified above and still holds. Either the label means something undocumented,
or those three need a real disposition rather than a holding label.

---

## 5. Recommended dispositions

| Action | Issues |
|---|---|
| Close as superseded | creek #1532, #1166, #944, #864 |
| Close as completed (decision recorded) | adepthood #2171 |
| Unblock (remove `blocked`) | adepthood #1929, #1930, #1931 |
| Re-point blocker | adepthood #2253 → creek #1568 |
| Re-scope | creek #1347 (wrapper only), then settle vs #1175 |
| Consolidate | creek #1041/#1316/#1519, #1405/#1346, #1178/#1085/#986/#1439 |
| Cross-link only | adepthood #2255↔creek #1528; DAST epics; #2006↔#1439; creek id-index cluster |
| File new | adepthood: re-vendor Creek contract 0.9; creek: record the `openai` divergence |
| Give a real disposition | adepthood #2126, #2259, #2264 (`tracer-obsolete`) |
