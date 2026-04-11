# Security Audit — Adepthood

Full-stack security audit generated from automated and manual review of the
backend (FastAPI + PostgreSQL), frontend (React Native + Expo), and
infrastructure (CI/CD, Docker, pre-commit) layers.

## Scope

Covers OWASP Top 10, input validation, authentication, secret management,
dependency supply chain, and mobile-specific risks. Findings are prioritized
by severity and ordered by recommended fix sequence.

## Issues

| #  | Issue | Layer | Severity | Est. LoC |
|----|-------|-------|----------|----------|
| 01 | [Account enumeration via signup endpoint](sec-01-account-enumeration.md) | Backend | HIGH | ~40 |
| 02 | [Missing email format validation](sec-02-email-validation.md) | Backend | HIGH | ~15 |
| 03 | [Unbounded string fields enable payload abuse](sec-03-input-length-constraints.md) | Backend | MEDIUM | ~80 |
| 04 | [JWT error messages leak token state](sec-04-jwt-error-messages.md) | Backend | MEDIUM | ~15 |
| 05 | [BotMason system prompt path traversal](sec-05-prompt-path-traversal.md) | Backend | HIGH | ~25 |
| 06 | [LLM API key accepted as empty string](sec-06-llm-api-key-validation.md) | Backend | MEDIUM | ~15 |
| 07 | [Push token stored in insecure AsyncStorage](sec-07-push-token-storage.md) | Frontend | HIGH | ~20 |
| 08 | [HTTP fallback in API base URL](sec-08-http-fallback.md) | Frontend | HIGH | ~15 |
| 09 | [No token refresh or expiration handling](sec-09-token-refresh.md) | Full-stack | MEDIUM | ~120 |
| 10 | [Unvalidated URLs before Linking.openURL](sec-10-url-validation.md) | Frontend | MEDIUM | ~20 |
| 11 | [No rate limiting on data endpoints](sec-11-data-endpoint-rate-limits.md) | Backend | MEDIUM | ~30 |
| 12 | [GitHub Actions not pinned to commit SHAs](sec-12-action-sha-pinning.md) | Infrastructure | MEDIUM | ~10 |
| 13 | [Undocumented pip-audit vulnerability exemption](sec-13-pip-audit-exemption.md) | Infrastructure | MEDIUM | ~5 |
| 14 | [Dependency versions not pinned for production](sec-14-dependency-pinning.md) | Full-stack | LOW | ~50 |

## Dependency Graph

```
sec-01 (Account enumeration) — standalone
sec-02 (Email validation) — standalone
sec-03 (Input lengths) — standalone
sec-04 (JWT errors) — standalone
sec-05 (Path traversal) — standalone
sec-06 (LLM key validation) — standalone
sec-07 (Push token storage) — standalone
sec-08 (HTTP fallback) — standalone
sec-09 (Token refresh) — depends on sec-04 (unified error codes)
sec-10 (URL validation) — standalone
sec-11 (Rate limits) — standalone
sec-12 (SHA pinning) — standalone
sec-13 (pip-audit) — standalone
sec-14 (Dep pinning) — standalone
```

All issues are independent except sec-09 which benefits from sec-04 being
completed first (unified error codes make 401 handling cleaner).

## What Was Already Secure

The audit also confirmed strong existing practices:

- Password hashing: bcrypt with 12 rounds (OWASP minimum)
- Auth rate limiting: 3/min signup, 5/min login (slowapi)
- Account lockout: 5 failures triggers 15-minute lockout
- Timing attack prevention: lockout checked before credential verification
- CORS: explicit origins, no wildcards, HTTPS enforced in production
- Security headers: X-Content-Type-Options, X-Frame-Options, HSTS
- JWT: HS256 with explicit algorithm, 1-hour TTL
- Secret validation: SECRET_KEY fails fast if unset or placeholder
- SQL injection: parameterized queries throughout (SQLAlchemy/SQLModel)
- XSS: React Native `<Text>` auto-escapes, no dangerouslySetInnerHTML
- Auth token storage: expo-secure-store (encrypted) for JWT
- Docker: non-root user, multi-stage build, minimal base image
- Pre-commit: 15+ hooks including bandit, detect-secrets, pip-audit, mypy
- Coverage: 90% minimum enforced by pytest-cov
- Access control: user_id scoping on all protected endpoints
