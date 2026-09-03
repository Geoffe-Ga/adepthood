# Journal writing surface: restore the Candle & Ink workspace

## Report

The desktop journal-writing view is visually and functionally fragmented: the
timer spans the viewport, text and marginalia do not share a scroll surface,
controls crowd the writing measure, and browser-native blue selection conflicts
with Candle & Ink. A failed autosave also leaves the writer without a direct
retry.

## Acceptance criteria

- The journal header, metadata, title, body, footer, and marginalia move in one
  scroll surface; long writing can use the available viewport.
- The title wraps, privacy controls and word count keep trailing breathing room,
  and marginalia remain reachable while scrolling.
- Starting the timer collapses it into the desk-side margin on desktop. It stays
  collapsed after completion and expands into restart controls when pressed.
- Get Resonance floats above the end of the writing, appears after an idle pause,
  and never hides behind the timer.
- Bulleted lists and blockquotes continue their Markdown prefixes on newline;
  bold and italic delimiters remain intact in the saved Markdown.
- A failed autosave offers an explicit retry that persists the latest text.
- Close, Pause, Resume, Stop, and the drawer toggle use Lucide vector icons with
  accessible names.
- The drawer panel itself slides over the current screen without a dark scrim
  appearing before it.
- Text selection/caret colors use Candle & Ink terracotta, never browser blue.
- Tests, frontend checks, pre-commit, CI-equivalent checks, and self-review pass.

## Journey

Update the journal writing journey in `frontend/e2e/journeys.json` and cover the
cross-screen/API seam in the existing journal E2E spec where practical.
