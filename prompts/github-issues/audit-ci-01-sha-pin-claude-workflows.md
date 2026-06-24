# audit-ci-01: SHA-pin the four mutable-tag actions in the Claude workflows

**Labels:** `audit-ci`, `ci`, `security`, `priority-critical`
**Epic:** CI, Infra & Docs Truth
**Estimated LoC:** ~10  (hard cap 700)

## Problem

Two GitHub Actions workflows consume third-party actions on **mutable tags**:
`.github/workflows/claude.yml:46` (`actions/checkout@v6`) and `:52`
(`anthropics/claude-code-action@v1`), and `.github/workflows/claude-code-review.yml:30`
(`actions/checkout@v6`) and `:36` (`anthropics/claude-code-action@v1`). Both workflows
run with `id-token: write` (OIDC) and one with `pull-requests: write`, so a hijacked or
force-moved tag executes attacker code with write + token-exchange power. This violates
`AGENTS.md §6` (pin third-party actions to a full commit SHA) and is the only place in
the repo that does — `backend-ci.yml` and `frontend-ci.yml` already pin every `uses:` to
a 40-char SHA with a version comment.

**Current state:** CI/infra — supply-chain. Critical per audit §9 (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:142`).

## Scope

**Covers:** Pinning the four `uses:` lines above to immutable 40-char commit SHAs, each
carrying a trailing `# vX.Y.Z` comment matching the established style in `backend-ci.yml:19`.

**Does NOT:** Change workflow logic, permissions, triggers, or prompts. Does not touch any
already-pinned action. Does not bump versions beyond the tag currently referenced — pin the
SHA that the current tag resolves to, preserving behaviour.

## Tasks

1. **Resolve the current SHA for each referenced tag at implementation time** — do not pin to a SHA from memory; tags move. For each action+tag, resolve the commit the tag currently points to (e.g. `gh api repos/actions/checkout/git/ref/tags/v6 --jq .object.sha`, dereferencing annotated tags to the underlying commit, or read the SHA already used for the same tag in `.github/workflows/backend-ci.yml`). Record the resolved version string for the comment.
2. **Pin `actions/checkout@v6`** in `.github/workflows/claude.yml:46` and `.github/workflows/claude-code-review.yml:30` to `actions/checkout@<sha>  # v6.x.y`. Reuse the exact SHA already pinned in `backend-ci.yml` for `actions/checkout` if it is the same `v6` line, to keep the repo on one revision.
3. **Pin `anthropics/claude-code-action@v1`** in `.github/workflows/claude.yml:52` and `.github/workflows/claude-code-review.yml:36` to `anthropics/claude-code-action@<sha>  # v1.x.y`, using the freshly resolved SHA.
4. **Verify no mutable tags remain** — `grep -REn 'uses:.*@(v[0-9]+|main|master|latest)' .github/workflows/` must return nothing.

## Acceptance Criteria

- [ ] No workflow `uses:` references a mutable tag — `grep -REn 'uses:.*@(v[0-9]+|main|master|latest)' .github/workflows/` is clean.
- [ ] All four edited lines pin a full 40-char commit SHA with a trailing `# vX.Y.Z` version comment, matching the existing style in `backend-ci.yml`.
- [ ] The pinned SHAs were resolved from the live tag refs at implementation time (not guessed) and correspond to the same major version the tag pointed to (`v6` checkout, `v1` action).
- [ ] No existing tests break; coverage ≥ 90% where applicable.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `.github/workflows/claude.yml` | Modify (pin lines 46, 52) |
| `.github/workflows/claude-code-review.yml` | Modify (pin lines 30, 36) |
