# Phase 6-07: Enforce Design Token Usage

## Problem

`design/tokens.ts` defines a comprehensive design system (colors, spacing, radii, shadows, typography) but components ignore it:

- `BottomTabs.tsx:85` — `color: '#4a90d9'` (hardcoded blue, not in palette)
- `HabitsScreen.tsx:248` — `color: '#c00'` (hardcoded red)
- `ErrorBoundary.tsx:46-70` — `#fff`, `#b00020`, `#555` instead of `colors.text.*`
- Duplicate radius definitions: `radius.md = 8` AND `BORDER_RADIUS.md = 8`
- `typography()` function in tokens.ts is never called anywhere

## Fix

### 1. Remove Duplicate Token Definitions
- Consolidate `radius` and `BORDER_RADIUS` into one export
- Remove unused `typography()` function or start using it

### 2. Replace All Hardcoded Values
Search for hex color patterns (`#[0-9a-fA-F]{3,6}`) in `.tsx` files and replace with token references.

### 3. Add ESLint Rule (Optional but Recommended)
Custom ESLint rule or eslint-plugin-react-native that warns on inline color strings:

```javascript
// eslint.config.cjs
'no-restricted-syntax': ['error', {
  selector: 'Property[key.name="color"][value.type="Literal"]',
  message: 'Use design tokens from design/tokens.ts instead of hardcoded colors',
}],
```

### 4. Standardize Responsive Scaling
Currently `spacing(1, scale)` and `spacing(1)` produce different results with no documentation on when to use which. Document the pattern or remove the scale parameter.

## Acceptance Criteria

- [ ] Zero hardcoded hex colors in .tsx files (all use `colors.*` tokens)
- [ ] No duplicate token definitions
- [ ] Unused `typography()` function either used or removed
- [ ] Responsive scaling pattern documented or simplified
- [ ] ESLint rule prevents regression (optional)

## Estimated Scope
~250 LoC
