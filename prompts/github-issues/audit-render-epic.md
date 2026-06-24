# EPIC: Frontend Render Cost & List Virtualization

**Labels:** `epic`, `frontend`, `performance`, `priority-high`

## Summary

The Habits and Practice features pay render costs that the Journal feature
already avoids. Per the 2026-06-24 audit (§5, §5.2 "Frontend render cost, lists
& animation"), the Habits tree contains **zero** `React.memo` and rebuilds its
`renderHabitTile` closure on every render, so any state change re-renders every
visible tile (`HabitsScreen.tsx:434-483`, `HabitTile.tsx`). The Practice catalog
and selectors render long lists via nested `.map()` inside a `ScrollView` with no
virtualization (`PracticeCatalogScreen.tsx:90,323`, `PracticeSelector.tsx:85`).
On top of that, one bug renders the Habits chrome non-functional on a real
device — `HabitsScreen.tsx:3` imports icons from `lucide-react` (the DOM
package) instead of `lucide-react-native`, so native chrome renders nothing or
crashes. Several smaller costs round out the picture: a duplicated stats fetch
(`StatsModal.tsx:251-274` + `useHabitStats`), a full FlatList remount on
breakpoint change (`key={cols-${columns}}`, `HabitsScreen.tsx:355-369`),
index/counter-based list keys that remap state to the wrong row, and O(N²)
lookups / inline literals scattered across `Course`, `Practice`, `navigation`,
and `components`.

The audit is explicit that the fix is mostly "do what Journal already does":
Journal is the gold standard with stable `keyExtractor`, `getItemLayout`,
windowing, and memoized rows (§10). This epic brings Habits and Practice up to
that bar.

## Success Criteria

- [ ] Updating one habit (e.g. logging a unit) re-renders **only that habit's
      row**, verified by a render-count test using `@testing-library/react-native`.
- [ ] Updating one message bubble does not re-render unchanged bubbles in the
      inverted Journal list, verified by a render-count test.
- [ ] **No app file imports `lucide-react`** (only `lucide-react-native`),
      enforced by a guard test and/or lint rule.
- [ ] Opening the stats modal fires `habitsApi.getStats(id)` **exactly once**,
      verified by a mocked-API call-count test.
- [ ] The Practice catalog, the Practice selector, and the Practice editable
      forms render through virtualized lists (`FlatList`/`SectionList`) with
      stable keys — no `.map()` over unbounded collections inside `ScrollView`.
- [ ] The Habits FlatList provides `getItemLayout` and no longer fully remounts
      (loses scroll position) on a breakpoint/column change.
- [ ] All work is behavior- and visually-neutral: snapshot/behavior tests pass,
      no existing tests break, coverage stays ≥ 90%, and all pre-commit hooks
      pass on `--all-files`.

## Sub-Issues

| # | Issue | Priority | Est. LoC |
|---|-------|----------|----------|
| 01 | [Fix lucide-react → lucide-react-native import](audit-render-01-lucide-native-import.md) | Critical | ~60 |
| 02 | [Memoize HabitTile + stabilize renderHabitTile](audit-render-02-memoize-habittile.md) | High | ~180 |
| 03 | [Memoize Journal MessageBubble](audit-render-03-memoize-messagebubble.md) | High | ~120 |
| 04 | [Dedup stats fetch on stats modal open](audit-render-04-dedup-stats-fetch.md) | High | ~150 |
| 05 | [Virtualize the Practice catalog](audit-render-05-virtualize-catalog.md) | High | ~300 |
| 06 | [Virtualize the Practice selector](audit-render-06-virtualize-selector.md) | High | ~160 |
| 07 | [Habits FlatList getItemLayout + no remount](audit-render-07-habits-flatlist-config.md) | Medium | ~200 |
| 08 | [Stable keys in Practice editable forms](audit-render-08-stable-form-keys.md) | Medium | ~220 |
| 09 | [Inline-literal & O(N²) lookup cleanup](audit-render-09-inline-literal-cleanup.md) | Low | ~180 |

**Total estimated scope:** ~1,570 LoC across 9 issues.

**Sequencing:** Land `01` first (it is a correctness bug — the screen is broken
on device). `02`–`04` are the high-value Habits/Journal render wins and can land
in parallel. `05`–`06` virtualize Practice. `07`–`09` are progressive cleanup.
Every issue traces back to a row in audit §5.
