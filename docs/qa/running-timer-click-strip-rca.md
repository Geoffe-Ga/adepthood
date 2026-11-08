# Running writing timer swallows clicks across the page (#3694)

## Problem and reproduction

On web, open a journal entry, write enough to reach the lower part of the page,
and start the writing timer. Click on the writing to the left of the timer, at
the timer's height. Nothing happens. A horizontal strip about as tall as the
timer runs across the whole viewport and cannot be clicked, even though the
timer pill sits in the trailing corner. This was reported on a laptop and also
reproduces at 390x844.

## Root cause

`frontend/src/features/Journal/WritingSessionSurface.tsx` mounts the running
timer in an absolutely positioned `writing-session-band` that spans the page
(`left: 0`, `right: 0`), so it can place the pill on the trailing edge. The
band and its `ScrollView` are both `pointerEvents="box-none"`, which was meant
to let pointers pass through everything except the pill.

React Native Web does not apply `box-none` to the whole subtree. Its style
compiler (`react-native-web/dist/exports/StyleSheet/compiler/index.js`) emits
two rules:

```css
.x      { pointer-events: none !important; }
.x > *  { pointer-events: auto; }
```

On web a `ScrollView` is two elements: the scroller and an inner content
container, which is the scroller's direct child. That content container
therefore gets `pointer-events: auto`. It is as wide as the band and as tall as
the timer plus its shadow padding, so it catches every pointer in that strip.
In Chromium, `document.elementFromPoint` beside the pill returns the untagged
child of `writing-session-band-content`, computed `pointer-events: auto`,
1280px wide.

## Impact

High for writers on web. While a session runs, the bottom lines of the entry,
the part being written, cannot be clicked to place the cursor. This is the
moment the timer exists to support. Native platforms resolve `box-none` per
view and are not affected the same way.

## Contributing factors

- The existing timer hit-tests (`journal-idle-timer-obstruction`,
  `journal-writing-timer`) check that the pill and nearby page actions can be
  clicked. None of them checks that the empty part of the band lets clicks
  through.
- Jest's `ScrollView` mock renders no styled content container, so unit tests
  cannot see this layer. Only the real RN Web DOM shows it.
- `box-none` reads as "this subtree passes clicks through", but on RN Web it
  covers only one level.

## Fix

Add `pointerEvents: 'box-none'` to the ScrollView's `contentContainerStyle`
(`styles.passThrough`). The container's own box then lets pointers through,
and its children (the timer wrapper, already `box-none`, and the standing note
card) keep their normal hit-testing.

Two other options were considered and rejected:

- Shrinking the band to the pill's width would break the band's measured
  clearance and the note layout that spans it.
- Dropping the ScrollView would lose the scroll fallback for short windows at
  large text sizes.

## Prevention

`frontend/e2e/journal-running-timer-passthrough.browser.e2e.test.ts` hit-tests
a grid across the running band at 1280x800 and 390x844. Every point outside
the pill must fall through to the page. Before the fix it failed with 72
swallowed points at 1280x800; after the fix it passes. When a full-width
`box-none` container wraps another full-width element on web, that inner
element needs its own `box-none` too.
