# Backlog triage & supersession review

- **Reviewed:** 2026-08-21, against adepthood `a786262` / creek-vault `71b7460`
- **Re-verified and actioned:** 2026-09-10, against adepthood `origin/main` (#2798) / creek-vault `origin/main` (#1788)

Joint review across `Geoffe-Ga/adepthood` and `Geoffe-Ga/creek-vault`. All 391
then-open issues were cross-referenced against 1109 merged commits, and every
candidate verified against the code before being listed.

> **Read the re-verification section first.** Between the review and the
> actioning pass the fleet closed most of what this found. Roughly two-thirds of
> the original findings were overtaken by merged work. What survived is in §A;
> what was overtaken is recorded in §B, because "the fleet already did this" is
> itself a useful triage result.

---

## A. Live findings, actioned 2026-09-10

Each re-verified against current `main` before acting.

### A1. `openai` adoption ticket contradicted a deliberate hold — closed

creek **#1532** asked to adopt PR #1531, widening `openai` from `<3.0.0` to
`<4.0.0`. That ceiling is deliberate and its reasoning is still in the manifest
at HEAD:

```
creek-tools/pyproject.toml:84-85   # Transport hold, not a CVE … openai 3.0.0
                                   # swapped httpx for httpx2
creek-tools/pyproject.toml:111     openai = ["openai>=2.41.0,<3.0.0"]
crawdad/pyproject.toml:37          "openai>=2.41.0,<3.0.0",
```

Superseded by **#1593**, which states that anthropic 1.0.0, the mcp ceiling
(#998) and the openai ceiling (#1479) are *one* decision, all forced by the same
httpx2 swap. **Closed as not-planned.**

### A2. A dead-code issue and a coverage issue asked for opposite things — both annotated

- creek **#1347** ([scan:dead-code]) wanted `creek/classify/llm/batch.py` retired.
- creek **#1175** ([scan:coverage]) wanted tests for that same module.

#1347's premise is half stale — `batch.py` is live in production:

```
creek/classify/llm/orchestrator.py:19    from creek.classify.llm.batch import run_batch
creek/classify/llm/orchestrator.py:478   return run_batch(self, fragments, progress=progress)
```

Only the public wrapper `LLMClassifier.classify_batch` (`orchestrator.py:448`)
has no production caller. **Both issues commented**: #1347 proposed for re-scope
to the wrapper alone, which dissolves the conflict and leaves #1175 correct as
filed.

### A3. Two of epic #1041's "(to file)" items already existed — linked, not closed

creek **#1316** is #1041's decomposition item 4 (`cleaning` + the orphaned
`creek/clean/` modules), filed 10 days later and specified far more deeply.
creek **#1520** is its item 6 (`context` / `ContextExtractor`). Both were
sitting unlinked. **Both attached as sub-issues of #1041.**

Deliberately **not** closed. #1316 is not a duplicate of #1041 — it is the
missing body of one of its items. Closing #1316 would have discarded the deeper
analysis; closing #1041 would have dropped `ocr`, `compost`,
`linking.cross_source_aggregation` and `ai_style.citation_network_checks`, which
#1316 does not cover. The hierarchy link is the consolidation.

Still genuinely unfiled: items 2, 3, 5, 7.

### A4. Atomic-write work was duplicated across two issues — cross-referenced

creek **#1346** task 1 ("hoist one `_atomic_create` into `creek/_fsio.py`") is
the same work as **#1405**, which states it better (three implementations vs
two). **Both commented**: #1346 to drop task 1, #1405 to carry over #1346's
evidence — notably that the retry cap has already drifted 10x
(`save/writer.py:49 = 1000` vs `vault/writer.py:140 = 10_000`).

Not closed: #1346's other findings (two dead `VaultWriter` methods; seven
divergent sentence splitters) are its own and are duplicated nowhere.

### A5. Premises re-verified as still true at current `main`

| Issue | Verified |
|---|---|
| adepthood #1419 (bells are silent) | all six `frontend/assets/sounds/bell-*.mp3` still 0 bytes — and it has since been raised P3 → **P1** |
| creek #998 (mcp capped `<2.0.0`) | `creek-tools/pyproject.toml:26`, `crawdad/pyproject.toml:17` |

---

## B. Overtaken between review and actioning

Recorded so the same ground is not re-reviewed. All of these were live findings
on 2026-08-21 and are now closed — the fleet reached them independently.

**The original headline finding is dead.** §1.1 of the first draft reported that
adepthood #1929/#1930/#1931 carried `blocked` against a blocker that had cleared
upstream (creek contract 0.9 shipping `related_praxis`/`related_eddies` via
#873), with adepthood pinned at `CONTRACT_VERSION = "0.8.0"` and no re-vendor
issue filed. All three issues are now closed and adepthood is at
**`CONTRACT_VERSION = "0.15.0"`** — seven minors on. The gap closed itself.

| Original finding | Current state |
|---|---|
| adepthood #2171 — decision already recorded, recommend close | **Closed** |
| adepthood #1929 / #1930 / #1931 — unblock | **All closed** |
| adepthood #2253 — re-point blocker at creek #1568 | **`blocked` already removed**; creek #1568 closed |
| adepthood #2006 ↔ creek #1439 (Dependabot bridge twins) | **Both closed**; live successor is creek #1685 |
| adepthood #2255 ↔ creek #1528 (seed-docs twins) | creek #1528 **closed**; #2255 still open |
| adepthood #2126 / #2259 / #2264 (`tracer-obsolete`) | **All closed** |
| creek #1166 — superseded by #998 | **Closed** |
| creek #944 / #864 — superseded by #1440 | **All three closed** |
| creek #1291 + id-index cluster (#1543, #1299, #1300) | **All closed**; only #1424 remains |
| creek /v1 follow-ups (#1142–#1150) | **All closed** |
| creek #1519 / #1517 / #1518 (dead-config members) | **All closed** |
| creek Dependabot-config cluster (#1178, #1085, #1439) | **Closed**; only #986 remains, and #1685 is a different problem — no consolidation warranted |

Backlog movement over the three weeks: adepthood **92 → 74** open, creek-vault
**299 → 215**.

---

## C. Hygiene finding (still holds)

**Closing-keyword hygiene is clean in both repos.** Across 559 adepthood and 550
creek-vault commits on `main`, no open issue in either repo was named by a
`Closes` / `Fixes` / `Resolves` keyword in a merged commit — nothing was
silently already-done. That is unusual and worth keeping.

---

## D. Method note for the next run

The expensive half of this review was cross-referencing issues against merged
commits; the useful half was verifying each candidate against the code. The
second half is what caught #1347's stale premise and what would have caught the
0.8.0 → 0.15.0 drift sooner.

Two lessons for a future pass:

1. **Re-verify immediately before acting.** A review and its actioning must
   happen in one sitting, or the analysis decays faster than it can be executed.
   This one aged three weeks and lost two-thirds of its findings.
2. **Cross-repo supersession was the only category the per-repo triage missed**,
   and even there the fleet caught up on its own. The durable value is in
   conflicts (A2) and unlinked hierarchy (A3) — structural relationships no
   single-issue reviewer sees.
