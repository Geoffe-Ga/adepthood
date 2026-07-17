# ADR-4: Transcription Delivery UX

**Status:** Proposed · **Date:** 2026-07-16 · **Feature:** Journal
Photographer · **Depends on:** ADR-2 (per-page transport)

**Context:** After the user taps "Transcribe", how do results reach the
editable preview — one blocking wait for everything, or page-by-page as
each finishes?

Latency reality (findings § R3.5, R5): ~5–15 s per dense handwritten page.
With ADR-2's per-page requests at concurrency 2, wall-clock is roughly:

| Pages | Expected wait (concurrency 2) |
|---|---|
| 1 | 5–15 s |
| 3 | 10–30 s |
| 5 | 15–45 s |
| 10 (cap) | 30–90 s |

Relevant house patterns: the resonance flow already runs a long LLM wait
behind a visible loading state on the button
(`frontend/src/features/Journal/GetResonanceButton.tsx:18-26` keeps the
button visible while loading); failure paths must allow retake/retry/remove
per page with no loss of edited text (scoping § UX flow 6).

**Impact:** capture-session screen state machine, preview editor behavior,
failure-path UX, perceived quality of the feature.

---

## Option A: Single blocking request-set with spinner

Fire all page requests, show one spinner, reveal the preview only when every
page has resolved (or show a single failure state).

**Pros:** simplest state machine (pending → done/error); the preview is
complete and stable the moment it appears; editing never races arriving
text.

**Cons:** 30–90 s of spinner at realistic page counts — well past mobile
patience thresholds with no evidence of progress; one slow/failed page
blanks the whole session's feedback; retry UX degrades to "try everything
again" unless failure state is per-page anyway (at which point the state
machine complexity of Option B has been paid without its benefits).

**Effort:** Low.

## Option B: Progressive per-page results in the preview

The preview opens immediately with one placeholder block per page (in
capture order). As each page's transcription resolves, its block fills in;
a failed page's block becomes an inline error card with Retry / Retake /
Remove actions. Editing is enabled per-block as it arrives; blocks are
concatenated (blank line between pages, no markers) at save time.

**Pros:** first feedback in 5–15 s regardless of page count — the user reads
and starts fixing page 1 while pages 2+ transcribe; progress is inherent
(filled blocks = progress bar); per-page failure is visible exactly where it
belongs, with the recovery actions the requirements demand; edited text in
completed blocks is never at risk from another page's retry (satisfies "no
silent data loss of an edited preview").

**Cons:** more state (per-page status array: pending → done → error, plus
edited-content tracking); must prevent a late-arriving result from
overwriting a block the user already edited (rule: a resolved transcription
fills a block only if untouched; retries replace only their own block after
confirmation); modestly more test surface.

**Effort:** Medium.

## Option C: Blocking for 1 page, progressive for 2+

Branch on page count.

**Pros:** single-page capture (likely the most common) gets the simplest
presentation.

**Cons:** two code paths to build and test for one UX; Option B with one
page *is* effectively a single filling block already — the branch buys
almost nothing; inconsistent behavior between 1 and 2 pages is itself a UX
smell.

**Effort:** Medium+ (superset of both).

---

## Comparison matrix

| Criterion | A: blocking | B: progressive | C: hybrid |
|---|---|---|---|
| Time to first feedback (5 pages) | 15–45 s | 5–15 s | 5–45 s |
| Progress visibility | ❌ spinner only | ✅ inherent | mixed |
| Per-page failure recovery (requirement) | ⚠️ bolted on | ✅ native | ✅ |
| Edited-text safety on retry (requirement) | ⚠️ | ✅ by design | ✅ |
| State-machine complexity | Low | Medium | High |
| Consistency across page counts | ✅ | ✅ | ❌ |
| Test surface | Small | Medium | Largest |

## Recommendation

**Option B — progressive per-page results.** The failure-path requirements
(per-page retake/retry/remove, edited text survives) force per-page state
tracking no matter what; once that exists, blocking presentation (A) throws
away its main payoff while keeping its cost. At the 10-page cap, blocking
means up to ~90 s of dead spinner — unacceptable on mobile. Option B
degrades gracefully to the single-page case, so C's branch is unnecessary.

Guard rails to carry into implementation: "Save entry" disabled until every
page is resolved (done, or removed by the user); a late transcription never
overwrites a user-edited block; per-block edits are the merge source of
truth.

**Question for reviewer:** confirm Option B.
