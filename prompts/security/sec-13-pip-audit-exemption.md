# sec-13: Undocumented pip-audit vulnerability exemption

**Labels:** `security`, `infrastructure`, `priority-medium`
**Severity:** MEDIUM
**OWASP:** A06:2021 — Vulnerable and Outdated Components
**Estimated LoC:** ~5

## Problem

The pre-commit config at `.pre-commit-config.yaml:63` silently ignores a
vulnerability:

```yaml
args: ["-r", "backend/requirements.txt", "--ignore-vuln", "PYSEC-0000"]
```

There is no comment explaining:
- What `PYSEC-0000` is
- Why it was deemed acceptable to ignore
- When it should be re-evaluated
- Who approved the exemption

`PYSEC-0000` is a placeholder/test ID in the PyPI Advisory Database. If this
was added to suppress a real vulnerability during development, it may be
masking a genuine issue. If it was added in error or as a template, it should
be removed since ignoring a nonexistent vulnerability is confusing.

## Tasks

1. **Investigate PYSEC-0000**
   - Run `pip-audit -r backend/requirements.txt` without the ignore flag
   - Determine if any real vulnerabilities are present

2. **Either document or remove the exemption**
   - **If real:** Add a comment explaining the vulnerability, why it's
     acceptable, and a date for re-evaluation
     ```yaml
     args: [
       "-r", "backend/requirements.txt",
       "--ignore-vuln", "PYSEC-0000",
       # PYSEC-0000: [description]. Accepted because [reason].
       # Re-evaluate by: 2025-07-01
     ]
     ```
   - **If unnecessary:** Remove the `--ignore-vuln PYSEC-0000` flag entirely

3. **Also check the CI workflow** — `backend-ci.yml:47` runs pip-audit
   without the ignore flag, so CI and pre-commit may give different results

## Acceptance Criteria

- The exemption is either documented with justification or removed
- Pre-commit and CI pip-audit configurations are consistent
- No real vulnerabilities are being silently suppressed

## Files to Modify

| File | Action |
|------|--------|
| `.pre-commit-config.yaml` | Document or remove --ignore-vuln |
| `.github/workflows/backend-ci.yml` | Align with pre-commit config |
