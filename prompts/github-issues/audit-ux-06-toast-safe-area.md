# audit-ux-06: Position the toast overlay using safe-area insets

**Labels:** `audit-ux`, `frontend`, `ux`, `priority-medium`
**Epic:** UX States, Accessibility & Error Copy
**Estimated LoC:** ~90  (hard cap 700)

## Problem

`ToastProvider.tsx:115-122` positions the toast overlay with a hardcoded `top: 60` magic constant in its `StyleSheet`. On devices whose status-bar / notch inset exceeds that constant (many modern phones report a top inset of 47-59pt, and landscape or larger devices more), the toast can sit partly under the status bar or notch, clipping the celebration message. The constant ignores `useSafeAreaInsets` entirely. Current state: this is a **UX correctness** defect — the toast renders but is mispositioned on real hardware (audit §8 `components/ToastProvider.tsx:115-122`).

## Scope

**Covers:** Replacing the static `top: 60` with a value derived from `useSafeAreaInsets().top` (plus a small named offset constant) so the overlay always clears the status bar / notch.

**Does NOT:** Change the toast queue mechanics (`useToastQueue`), the gap timing, the `Toast` component's animation, or the `NOOP_CONTEXT` fallback. No copy changes.

## Tasks

1. **Add a named offset constant** — Introduce a named constant (e.g. `TOAST_TOP_OFFSET = 8`) to replace the magic number; the overlay's top becomes `insets.top + TOAST_TOP_OFFSET`. Document why (clears status bar across devices).
2. **Read insets in the overlay** — In the provider's render path, call `useSafeAreaInsets()` and apply the computed top as an inline style on the overlay `View`, keeping the static `position/left/right/zIndex` in the `StyleSheet`. TDD: with `useSafeAreaInsets` mocked to `{ top: 59, ... }`, assert the overlay's resolved top is `59 + TOAST_TOP_OFFSET`; with `{ top: 0 }` it is `TOAST_TOP_OFFSET`.
3. **Guard the provider mount** — Ensure the provider still functions when `SafeAreaProvider` is present (insets resolve to real values) and degrades to zero insets otherwise. TDD: rendering without a custom inset frame does not throw and the overlay still renders the current toast.

## Acceptance Criteria

- [ ] The toast overlay's top position is `safe-area top inset + TOAST_TOP_OFFSET`, never a bare magic constant.
- [ ] With a large top inset, the resolved top scales accordingly (asserted in tests).
- [ ] No magic number remains for the overlay top; it is a named constant.
- [ ] No user-facing copy leaks internals.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/components/ToastProvider.tsx` | Modify (inset-based top) |
| `frontend/src/components/__tests__/ToastProvider.test.tsx` | **Create** or modify (add inset assertions) |
