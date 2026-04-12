---
name: security
description: >-
  Security best practices for Adepthood's FastAPI + React Native stack.
  Use when handling user input, API keys, JWT tokens, database queries,
  CORS configuration, or preparing for production deployment.
  Covers OWASP Top 10, secrets management, and deployment hardening.
metadata:
  author: Geoff
  version: 1.0.0
---

# Security

Defense in depth, least privilege, fail securely, never trust user input.

## Instructions

### Principles

1. Defense in depth — multiple layers of security
2. Least privilege — minimal access required
3. Fail securely — errors don't expose sensitive data
4. Input validation at all boundaries
5. Never trust user input
6. Secure by default, not by configuration

### Pre-Launch Security Checklist

**Authentication & Authorization:**
- [ ] JWT tokens expire (check TTL)
- [ ] SECRET_KEY is cryptographically random (not `replace-me`)
- [ ] Password hashing uses bcrypt with adequate rounds (≥12)
- [ ] Account lockout after failed attempts
- [ ] Rate limiting on auth endpoints
- [ ] Timing-attack resistant error messages (generic "invalid credentials")

**Input Validation:**
- [ ] All user inputs validated via Pydantic models
- [ ] No raw SQL (parameterized queries via SQLAlchemy)
- [ ] Email format validated
- [ ] Password minimum length enforced
- [ ] Request body size limits

**API Security:**
- [ ] CORS restricted to specific origins (not `*`)
- [ ] HTTPS enforced in production (HSTS header)
- [ ] Security headers set (X-Content-Type-Options, X-Frame-Options)
- [ ] No sensitive data in error responses
- [ ] No debug endpoints in production

**Secrets Management:**
- [ ] No hardcoded secrets in source code
- [ ] .env files in .gitignore
- [ ] detect-secrets baseline up to date
- [ ] API keys never logged or returned in responses
- [ ] User API keys never stored in plaintext

**Dependencies:**
- [ ] `pip-audit` passes (no known vulnerabilities)
- [ ] `npm audit` reviewed (no critical/high)
- [ ] Docker base images are slim/minimal
- [ ] Non-root user in Docker containers

**Database:**
- [ ] No raw SQL injection vectors
- [ ] Sensitive fields not exposed in API responses
- [ ] Database credentials via environment variables only

### User API Key Handling

When users provide their own LLM API keys:
- Never store keys server-side (keep in client SecureStore/localStorage)
- Pass via request header (`X-LLM-API-Key`), not in URL or body
- Never log the key value
- Never return the key in API responses
- Validate key format before forwarding to LLM provider
- Clear from memory after use

## Examples

### Safe Secret Handling
```python
# WRONG - logs the secret
logger.info(f"Using API key: {api_key}")

# CORRECT - never log secrets
logger.info("LLM request initiated for user %s", user_id)
```

### Safe Error Response
```python
# WRONG - leaks internal details
raise HTTPException(status_code=500, detail=str(exc))

# CORRECT - generic error, log details server-side
logger.exception("Database error in endpoint X")
raise HTTPException(status_code=500, detail="internal_error")
```

## Troubleshooting

### Error: detect-secrets flags false positives
- Add to `.secrets.baseline` with `detect-secrets scan --baseline .secrets.baseline`
- Use `# pragma: allowlist secret` for test fixtures only

### Error: pip-audit finds vulnerability in transitive dependency
- Check if it's exploitable in your usage
- Pin a safe version or add to `.pip-audit-known-vulnerabilities`
- Document the decision
