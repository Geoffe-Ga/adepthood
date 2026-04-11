# Security Audit v2 — Adepthood

Second-pass security audit after all 14 original findings were addressed.
12 of 14 are fully resolved. 2 remain open (sec-11 rate limiting, sec-03
input constraints), plus 2 new findings discovered in this pass.

## Resolved (sec-01 through sec-14)

| # | Issue | Status |
|---|-------|--------|
| sec-01 | Account enumeration via signup endpoint | FIXED — dummy token + timing equalization |
| sec-02 | Missing email format validation | FIXED — Pydantic `EmailStr` |
| sec-03 | Unbounded string fields enable payload abuse | FIXED — `max_length` on core schemas |
| sec-04 | JWT error messages leak token state | FIXED — unified `"unauthorized"` detail |
| sec-05 | BotMason system prompt path traversal | FIXED — allowed directory + size limit |
| sec-06 | LLM API key accepted as empty string | FIXED — fail-fast `_get_llm_api_key()` |
| sec-07 | Push token stored in insecure AsyncStorage | FIXED — migrated to `expo-secure-store` |
| sec-08 | HTTP fallback in API base URL | FIXED — HTTPS enforced in production |
| sec-09 | No token refresh or expiration handling | FIXED — proactive refresh + retry-after-401 |
| sec-10 | Unvalidated URLs before Linking.openURL | FIXED — `isValidUrl()` allowlist |
| sec-11 | No rate limiting on data endpoints | PARTIALLY FIXED — see sec-16 |
| sec-12 | GitHub Actions not pinned to commit SHAs | FIXED — all actions use full SHAs |
| sec-13 | Undocumented pip-audit vulnerability exemption | FIXED — `--ignore-vuln` removed |
| sec-14 | Dependency versions not pinned for production | FIXED — `requirements-lock.txt` + Dependabot |

## Open Issues (sec-15 through sec-18)

| #  | Issue | Layer | Severity | Est. LoC |
|----|-------|-------|----------|----------|
| 15 | [Remaining unbounded string fields](sec-15-remaining-input-constraints.md) | Backend | MEDIUM | ~60 |
| 16 | [No rate limiting on data endpoints](sec-16-data-endpoint-rate-limits.md) | Backend | MEDIUM | ~30 |
| 17 | [Offering balance race condition](sec-17-offering-balance-race-condition.md) | Backend | HIGH | ~20 |
| 18 | [Frontend nginx missing security headers](sec-18-nginx-security-headers.md) | Frontend | MEDIUM | ~15 |

## Dependency Graph

```
All 4 issues are fully independent — no internal dependencies.
```

## What Is Now Secure (cumulative)

- Password hashing: bcrypt with 12 rounds (OWASP minimum)
- Auth rate limiting: 3/min signup, 5/min login, 1/min refresh (slowapi)
- Account lockout: 5 failures triggers 15-minute lockout
- Timing attack prevention: lockout checked before credentials, dummy hash on duplicate signup
- Account enumeration prevention: signup returns identical response for new and existing emails
- Email validation: Pydantic `EmailStr` (RFC 5321)
- Input validation: max_length on core request schemas (journal, botmason, practice, prompt)
- CORS: explicit origins, no wildcards, HTTPS enforced in production
- Security headers (backend): X-Content-Type-Options, X-Frame-Options, HSTS
- JWT: HS256 with explicit algorithm, 1-hour TTL, unified error messages
- Token refresh: proactive refresh 5 min before expiry, retry-after-401
- Token expiration: expired tokens discarded on app startup
- Secret validation: SECRET_KEY and LLM_API_KEY fail fast if unset
- Path traversal prevention: BotMason prompt restricted to allowed directory
- SQL injection: parameterized queries throughout (SQLAlchemy/SQLModel)
- XSS: React Native `<Text>` auto-escapes, URL allowlist on Linking.openURL
- Auth token storage: expo-secure-store (encrypted) for JWT + push token
- Docker: non-root user, multi-stage build, minimal base image
- CI: all GitHub Actions pinned to commit SHAs, Dependabot configured
- Pre-commit: 15+ hooks including bandit, detect-secrets, pip-audit, mypy
- Coverage: 90% minimum enforced by pytest-cov
- Dependencies: pinned via requirements-lock.txt and package-lock.json
- Access control: user_id scoping on all protected endpoints
