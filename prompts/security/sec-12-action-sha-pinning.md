# sec-12: GitHub Actions not pinned to commit SHAs

**Labels:** `security`, `infrastructure`, `priority-medium`
**Severity:** MEDIUM
**OWASP:** A08:2021 — Software and Data Integrity Failures
**Estimated LoC:** ~10

## Problem

GitHub Actions workflows use mutable version tags (`@v4`, `@v5`, `@v3`,
`@v1`) instead of immutable commit SHAs:

```yaml
# .github/workflows/backend-ci.yml
- uses: actions/checkout@v4           # line 19
- uses: actions/setup-python@v5      # line 22
- uses: astral-sh/setup-uv@v3        # line 27

# .github/workflows/frontend-ci.yml
- uses: actions/checkout@v4           # line 20
- uses: actions/setup-node@v4         # line 23

# .github/workflows/claude.yml
- uses: anthropics/claude-code-action@v1  # line 36

# .github/workflows/claude-code-review.yml
- uses: anthropics/claude-code-action@v1  # line 34
```

Mutable tags can be force-pushed by the action maintainer (or an attacker who
compromises their repository). A supply chain attack on any of these actions
would execute arbitrary code in the CI environment with access to repository
secrets (`CLAUDE_CODE_OAUTH_TOKEN`).

## Tasks

1. **Pin all actions to full commit SHAs**
   - Look up the current commit SHA for each action's tag
   - Replace tag references with SHA + comment showing the version
   ```yaml
   - uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11  # v4.1.7
   - uses: actions/setup-python@82c7e631bb3cdc910f68e0081d67478d79c6982d  # v5.1.0
   ```

2. **Add a Dependabot config for action updates**
   ```yaml
   # .github/dependabot.yml
   version: 2
   updates:
     - package-ecosystem: "github-actions"
       directory: "/"
       schedule:
         interval: "weekly"
   ```

3. **Document the pinning practice** in AGENTS.md or a contributing guide

## Acceptance Criteria

- All action references use full 40-character commit SHAs
- Version comments explain which tag each SHA corresponds to
- Dependabot is configured to propose action updates

## Files to Modify

| File | Action |
|------|--------|
| `.github/workflows/backend-ci.yml` | Pin to SHAs |
| `.github/workflows/frontend-ci.yml` | Pin to SHAs |
| `.github/workflows/claude.yml` | Pin to SHAs |
| `.github/workflows/claude-code-review.yml` | Pin to SHAs |
| `.github/dependabot.yml` | Create (Dependabot config) |
