# 2026-05-24 — Practice Customization Epics: Backlog Grooming

**Scope:** Joint pass across the two open practice-customization epics (#336 Generalize grounding techniques, #345 Customizable practices). Six PRs from these epics have merged to `main` since the plans were filed; this file reconciles the issue tracker against `main`, lists remaining work, and locks in the fastest path to landing both.

## Status snapshot

- **#336 Grounding epic:** 2 / 6 sub-issues merged.
- **#345 Custom-practices epic:** 3 / 7 sub-issues merged.
- **8 sub-issues remain open** across both epics; **6 are unblocked today**.
- Both epics share a common downstream consumer (#352 catalog + create wizard).

## Merged work (verified file-by-file on `origin/main`)

| Issue | PR | Evidence on `main` |
|---|---|---|
| #337 tallied_grounding backend | #343 | `PracticeMode.TALLIED_GROUNDING` in `backend/src/domain/practice_modes.py` |
| #338 mindful_anchor backend | #344 | `PracticeMode.MINDFUL_ANCHOR` in same enum |
| #347 card_meditation backend | #357 | `PracticeMode.CARD_MEDITATION` in same enum |
| #348 share-link feature | #359 | `practice_share_link.py`, `practice_share.py`, `ShareSheet.tsx`, `SharePreviewScreen.tsx`, migration `f5b6c7d8e9a0` |
| #349 RWS deck content | #360 | `frontend/src/features/Practice/data/decks/rws.ts`, `index.ts`, tests |
| (docs) grounding epic plans | #353 | `prompts/github-issues/grounding-techniques-*.md` |

## Grooming actions this session

| Action | Issue | Reason |
|---|---|---|
| Closed (completed) | #337 | Resolved by PR #343; auto-close didn't fire (no `Closes #` keyword in PR body) |
| Closed (completed) | #348 | Resolved by PR #359; same root cause |
| Closed (duplicate) | #331 | Superseded by #345 / #352 — original was a roadmap concern about reachability; the catalog + create wizard delivers exactly that |

## Stealth-closure scan

Scanned all 19 merged PRs in the past window for `#NNN` references against the 26 open issues at the time. **No additional stealth closures detected.** Two PRs reference still-open issues but only as "out of scope, see #N" pointers:

- PR #325 → defers journal cleanup to #320 (still legitimately open)
- PR #330 → cites #331 as roadmap (now closed as duplicate of #352)

No PR in the window did real work without an issue reference, so no retrospective issues need to be filed.

## What remains — 8 open sub-issues

| Issue | Title | Blocker | Wave |
|---|---|---|---|
| #339 | seed Find Shapes + Find Colors presets | none (deps met) | A |
| #340 | seed Touch Grass + Mindful Eating presets | none (deps met) | A |
| #341 | `TalliedGroundingView` (FE) | none (deps met) | A |
| #342 | `MindfulAnchorView` (FE) | none (deps met) | A |
| #346 | `random_interval_bell` backend | none | A |
| #351 | `CardMeditationView` (FE) | none (deps met) | A |
| #350 | `RandomIntervalBellView` (FE) | #346 | B |
| #352 | catalog + create-custom wizard | #341, #342, #350, #351 | C |

## Fastest path to land everything

Critical path is **#346 → #350 → #352** — depth 3. Everything else fits around it.

```
Wave A (open NOW — 6 PRs fully parallel):
  #339   #340   #341   #342   #346   #351
                                 │
                                 ▼
Wave B (after #346):       #350
                                 │
                                 ▼
Wave C (after Wave A's #341 #342 + #350 #351):  #352
```

**Migration ordering note:** #346 is the last `ck_practice_mode_value` extension. Tallied / mindful / card already landed cleanly, so #346's migration has a stable `down_revision` base — trivial rebase if any preset-seed migration in #339/#340 lands first.

## Open recommendations for the owner

1. **Custom-practices epic plan files (`d2d9cfd`) live only on branch `claude/add-grounding-techniques-MyXO4`.** Grounding-epic docs were merged via PR #353; the symmetric move is to merge the custom-practices docs the same way. If the branch is ever deleted, the URLs in issues #345–#352 break. Recommend opening a small docs PR. **Not opened in this pass — awaiting confirmation.**
2. **11 stale Dependabot PRs** (#248–#258) from 2026-04-25, all ~4 weeks old. Likely some have been superseded by newer versions. Out of scope for this grooming pass but worth a dedicated 30-min triage soon.

## Statistics

| Metric | Count |
|---|---|
| PRs analyzed | 19 merged + 11 open |
| Issues closed | 3 (#337, #348, #331) |
| Issues created | 0 |
| Retrospective issues | 0 (no gaps found) |
| Open issues before | 28 |
| Open issues after | 25 |
| Open epic sub-issues remaining | 8 |
| Issues unblocked today | 6 |
