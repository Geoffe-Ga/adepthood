# sec-04: Frontend nginx missing security headers

**Labels:** `security`, `frontend`, `infrastructure`, `priority-medium`
**Severity:** MEDIUM
**OWASP:** A05:2021 — Security Misconfiguration
**Estimated LoC:** ~15

## Problem

The new frontend Dockerfile at `frontend/Dockerfile:21-26` serves the Expo web
build via nginx, and the nginx config at `frontend/nginx.conf` has no security
headers:

```nginx
server {
    listen       80;
    server_name  _;
    root         /usr/share/nginx/html;
    # ... no security headers ...
}
```

The backend adds security headers via `SecurityHeadersMiddleware` in
`backend/src/main.py:93-111` (X-Content-Type-Options, X-Frame-Options, HSTS),
but those headers only apply to API responses. The HTML page itself, served by
nginx, is missing:

- **X-Content-Type-Options: nosniff** — prevents MIME-type sniffing of JS/CSS
- **X-Frame-Options: DENY** — prevents clickjacking by embedding in iframes
- **Content-Security-Policy** — prevents XSS by restricting script sources
- **Referrer-Policy** — prevents leaking URLs to third parties
- **Permissions-Policy** — disables unused browser features

Without these headers on the HTML response, the frontend is vulnerable to
clickjacking (attacker embeds the app in an iframe on a phishing site) and
MIME-type confusion attacks.

## Tasks

1. **Add security headers to `frontend/nginx.conf`**
   ```nginx
   server {
       listen       80;
       server_name  _;
       root         /usr/share/nginx/html;
       index        index.html;

       # Security headers
       add_header X-Content-Type-Options "nosniff" always;
       add_header X-Frame-Options "DENY" always;
       add_header Referrer-Policy "strict-origin-when-cross-origin" always;
       add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

       # ... existing location blocks ...
   }
   ```

2. **Consider adding Content-Security-Policy**
   - Start with a report-only policy to avoid breaking the app:
     ```nginx
     add_header Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https://api.adepthood.com;";
     ```
   - Tighten to enforcing mode after testing

3. **Add a test or CI check** that validates the headers are present
   - `curl -I http://localhost:80/ | grep X-Frame-Options`

## Acceptance Criteria

- nginx responses include X-Content-Type-Options, X-Frame-Options,
  Referrer-Policy, and Permissions-Policy headers
- No existing functionality is broken by the new headers
- CSP is at least in report-only mode

## Files to Modify

| File | Action |
|------|--------|
| `frontend/nginx.conf` | Add security headers |
