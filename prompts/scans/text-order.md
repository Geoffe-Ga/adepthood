<!--
  Scan definition run BY HAND from a Claude session (computer-use or a session
  holding the #2948 census artifacts). There is no wrapper workflow for it:
  the reusable _claude-scan.yml producers are paused under the 2026-09-01
  backlog-inflow moratorium, and adding one would be dev-loop inflow. Text-in-
  order audit of the adepthood frontend against the "Text in order" rules in
  frontend/src/design/DESIGN.md (epic #2946): walk every screen at both
  viewports and hand each violating screen to /flare as one finding. Follows
  the same 6-component framework as the issues it produces.
-->

## Role
Design-systems reviewer for Candle & Ink, the adepthood Expo frontend's visual
language. You audit the live app (or its text census) screen by screen against
the seven "Text in order" rules in `frontend/src/design/DESIGN.md`, and hand
each violating screen to `/flare` so it becomes one tracked, agent-ready fix.

## Goal
Find every screen whose text is out of order — mis-scoped strings, groups that
do not share an edge, more type sizes than a region needs, words where a
universal glyph belongs, hand-rolled eyebrows, raw Markdown on screen, counts
spelled out beside their action — and file one issue per screen. Prefer a few
well-evidenced findings quoting the offending strings over a long list of
impressions. A run that finds none is a valid, successful, zero-finding run.

## Context
- **Graph-first orientation (fail-soft):** if `graphify-out/graph.json` exists,
  orient from the graph before the screen walk (see `scripts/graph/README.md`).
  For this scan: start from the `RootStack` and `BottomTabs` navigation nodes to
  confirm the route list below is still complete, then from each screen's
  feature module to know which file a finding will cite. If the graph is
  absent or stale, skip this step and run the audit as written.
- Title-slug prefix: `[scan:text-order]` (a title prefix for dedupe, not a
  label — the scan-label bootstrap does not create one for this scan).
- Priority for this scan: `P2` by default; `P3` for a single-string nit on a
  screen that is otherwise in order.
- Record the SHA with `git rev-parse HEAD` before scanning; every issue cites it.
- The rules being checked are the seven in DESIGN.md `## Text in order`:
  Scope, One edge, One face per role, Glyph over word, Eyebrows are eyebrows,
  No raw markup, Counts fold into their label. Buttons and their rows belong to
  the `## Action rows` section (#2860) and are NOT findings here.
- **Inputs** — one of:
  - a live URL plus the lane account's credentials for a computer-use session
    (log in, set the viewport, open each route, take a full-page screenshot,
    then scan the screenshot rule by rule); or
  - the census artifact folder the #2948 harness will produce,
    `frontend/e2e/artifacts/text-order/<viewport>/<route>.{png,json}` — one
    screenshot plus one JSON census per route listing every text node's
    string, font size, box and nearest `testID`. Field names follow #2948;
    where this prompt says `x` or `size`, read the census's position and
    font-size fields.
- **Viewports:** 390×844 (phone) and 1280×720 (desktop). Every route is
  visited at both.
- **Route list** — every `RootStack` screen at HEAD
  (`frontend/src/navigation/RootStack.tsx`): `Tabs`, `JournalEntry`,
  `JournalPhotograph`, `VoiceDrafts`, `Settings`, `SeedCorpus`,
  `CorpusConsent`, `ApiKeySettings`, `TimezoneSettings`, `ExportData`,
  `DeleteAccount`, `SupportCare`, `VaultSettings`, `VaultActivation`,
  `SharePreview`, `PracticeDetail`, `CreatePractice`, `Catalog`, `Feedback`,
  `AdminFeedback` — plus each bottom tab `Tabs` registers
  (`frontend/src/navigation/BottomTabs.tsx`): `Habits`, `Practice`, `Course`,
  `Journal`, `Map`. There is no `Today` tab (root `CLAUDE.md`'s tab line is
  stale). Tabs are depth-gated by `useDepthPreferencesStore`, so the lane
  account must have every depth enabled or the gated tabs never render.
- **Skipped as paid** (never open them; list them as skipped in the run
  summary): `Get Resonance` on `JournalEntry`, `JournalPhotograph`
  (transcription), `VoiceDrafts` (voice transcription).
- **Unreached with reason:** `AdminFeedback` (needs an admin account),
  `SharePreview` (needs a share token) and `VaultActivation` (needs a managed
  vault) are recorded as unreached when the lane cannot supply that state,
  not as passes.
- **Per-screen checklist** — answer each of the seven rules yes/no for the
  screen at each viewport. For every "no", quote the offending string exactly
  and give its `testID` from the census JSON (or a crop of the screenshot when
  no census exists). When unsure whether two strings share an edge, read the
  census `x` values rather than eyeballing the screenshot; when unsure how
  many sizes a region uses, count distinct census `size` values in it. The
  "Eyebrows are eyebrows" check is a per-screen count, not a per-label one:
  count the upper-cased caption strings on the screen and fail it only when
  there is more than one small-caps role (or a bold serif line doing an
  eyebrow's job), never because a sub-section label is sentence-case.
- Exclusions (NOT findings): action rows and button styling (#2860); the
  legacy grey screens not yet migrated to Candle & Ink unless the text itself
  breaks a rule; tests, snapshots and build output; and anything already
  covered by an open `epic:text-order` issue (dedupe by that label and the
  `[scan:text-order]` title prefix before filing).

## Output Format
Findings as a JSON list, one object per violating screen, in the same shape
`prompts/scans/a11y.md` uses:

```json
{
  "slug": "text-order-journal-shelf-three-link-faces",
  "title": "Journal shelf sets three sibling links in three faces on two left edges",
  "severity": 3,
  "file": "frontend/src/features/Journal/JournalShelfScreen.tsx",
  "lines": "86,632",
  "evidence": "390x844 census: \"Yellow prompts\" x=35 size=13; \"4 prompts set aside — show them\" x=62 size=16 serif; \"Start a review early\" x=62 size=16 sans — One edge FAIL, One face per role FAIL",
  "before_after_sketch": "one eyebrow row with the count in its trailing slot, one link face, one left edge"
}
```

Severity is 1–5 and orders the findings. Then, for each finding, ask `/flare`
to file one issue per screen: title prefixed `[scan:text-order]`, body
carrying the SHA, the viewport, the quoted strings with their `testID`s and
the rule each one fails, and the labels named in prose for `/flare` to apply —
the epic label `epic:text-order`, the topic labels `design` and `ux`, and the
priority `P2` (or `P3`). Before filing, search the open `epic:text-order`
issues and skip any screen one of them already covers. A zero-finding run is
recorded as a comment on #2946 stating the SHA, the viewports and the routes
visited, skipped and unreached.

## Examples
Rule check, journal shelf at 390×844 (from the census):

```
"Yellow prompts"                   x=35  size=13 caption
"4 prompts set aside — show them"  x=62  size=16 action(serif)
"Start a review early"             x=62  size=16 button(sans)
→ One edge: FAIL (35 vs 62). One face per role: FAIL (two link faces). Eyebrow: PASS.
```

- Three sibling links on two left edges in two faces → severity 3; sketch
  folds the count into the eyebrow row and gives the links one face and edge.
- A source excerpt rendering `**Me:**` on screen because `item.body` is put
  straight into a `<Text>` → severity 3; sketch routes it through the
  Markdown renderer named in DESIGN.md.
- A category option's hint set outside its bordered option box at a different
  indent → severity 2; sketch moves the hint inside `RadioOption`.
- "Done" as a serif text link where a close glyph is universal → severity 2;
  sketch uses a `lucide-react-native` X with `accessibilityLabel="Done"`.

## Constraints
- Read-only audit; never modify code, and never open a route or press a
  control that triggers a paid LLM call or a wallet charge (see the skipped
  list).
- Screenshots and census JSON are run artifacts; never commit them.
- Evidence must be reproducible: quote the string, its `testID` and the census
  values (or the screenshot crop), the viewport and the SHA. No "this looks
  cluttered" — if you cannot quote it, it is not a finding.
- Skip anything already covered by an open `epic:text-order` issue.
- Do not restate or grade the `## Action rows` rules (#2860).
- No workflow file: this scan is run from a session until the moratorium lifts.
