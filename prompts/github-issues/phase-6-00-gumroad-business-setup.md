# phase-6-00: Gumroad business setup — products, API application, secrets

**Labels:** `phase-6`, `monetization`, `needs-spec` (human runbook — never
Ralph-pickable)
**Epic:** Phase 6 — Gumroad-gated access and monetization
**Blocks (soft):** production rollout of phase-6-02/03/05. Code sub-issues
are NOT blocked — they build against env-var config and mocked Gumroad
responses; this runbook supplies the real values.
**Owner:** Geoff (dashboard clicks cannot be automated — Gumroad's API has
no product-creation endpoint; the `POST /v2/products` route 404s and is an
open feature request, antiwork/gumroad#4019)

## Context

The Gumroad account already exists. What's missing is the APTITUDE product,
the token-pack products, an API application/token the backend can use, and
the webhook (ping) wiring. Everything below happens in the Gumroad
dashboard; the final step hands four secrets/IDs to the backend config.

Pricing model (resolved in the epic): gift economy with a $0 floor —
"pay what feels right" — with suggested contributions in line with
comparable course apps (Reframe ≈ $100/yr).

## Runbook

### 1. Create the APTITUDE membership product

1. Gumroad dashboard → **Products** → **New product** → type
   **Membership** (subscription).
2. Name: `APTITUDE — the 36-week Adepthood course` (or preferred copy).
3. Create **two tiers**:
   - **Annual** — billing yearly, price **$0+** (enable
     "Allow customers to pay what they want"), suggested amount **$150**.
   - **Monthly** — billing monthly, price **$0+**, suggested amount
     **$15**.
4. In product settings, **enable license keys** ("Generate a unique
   license key per sale"). This is the key users redeem at Adepthood
   signup — the whole gate depends on it.
5. Product description: state plainly that $0 is a real, honored price
   (dana framing), and that the license key emailed after checkout is
   what unlocks the Adepthood app.
6. Publish, then record:
   - the **product ID** (visible in the product's edit-page URL, or via
     `GET https://api.gumroad.com/v2/products` once the token from
     step 3 exists)
   - the **variant/tier IDs** if Gumroad reports tiers as distinct IDs
   - the public **product URL** (needed by the frontend as
     `EXPO_PUBLIC_GUMROAD_PRODUCT_URL`).

### 2. Create BotMason token-pack products

Three one-time products (not memberships), each with license keys
**disabled** (webhook crediting is by sale, not key) and fixed prices —
packs are a concrete exchange, not dana:

| Product | Price | Tokens |
|---------|-------|--------|
| BotMason Tokens — Small | $5 | 500,000 |
| BotMason Tokens — Medium | $10 | 1,200,000 |
| BotMason Tokens — Large | $20 | 3,000,000 |

(Token counts are a starting point; final numbers should be set from the
live per-token LLM cost with margin. They live in the
`GUMROAD_TOKEN_PACK_SIZES` env var, so retuning is a config change.)

Record each product ID.

### 3. Create the API application + access token

1. Gumroad → **Settings** → **Advanced** → **Applications** →
   **Create application** (name: `Adepthood backend`; redirect URI can
   be a placeholder like `https://adepthood.example/oauth/callback` —
   we use a direct access token, not the 3-legged flow).
2. Click **Generate access token**. This is `GUMROAD_API_TOKEN`.

### 4. Wire the webhook (ping)

1. Gumroad → **Settings** → **Advanced** → **Ping**: set the ping URL to
   the deployed backend's `POST /webhooks/gumroad/ping` (Railway URL),
   **including the shared-secret query parameter** the backend
   implements (see note below), e.g.
   `https://<railway-app>/webhooks/gumroad/ping?secret=<GUMROAD_WEBHOOK_SECRET>`.
2. Generate `GUMROAD_WEBHOOK_SECRET` locally:
   `python -c "import secrets; print(secrets.token_urlsafe(32))"`.

> **Implementation note for phase-6-01:** verify Gumroad's *current* ping
> authentication at build time. Historically Gumroad pings are plain
> form-encoded POSTs without an HMAC signature header; if that is still
> true, authenticate via (a) the shared secret in the ping URL compared
> with `hmac.compare_digest`, AND (b) server-side re-verification of the
> sale via the License/Sales API before trusting payload fields. If
> Gumroad now signs pings, prefer the signature. Either way the
> `GUMROAD_WEBHOOK_SECRET` env var is the shared secret.

### 5. Set the secrets

Railway (backend service) env vars:

```
GUMROAD_API_TOKEN=<from step 3>
GUMROAD_WEBHOOK_SECRET=<from step 4>
GUMROAD_APTITUDE_PRODUCT_IDS=<annual-and-monthly IDs, comma-separated>
GUMROAD_TOKEN_PACK_PRODUCT_IDS=<pack IDs, comma-separated>
GUMROAD_TOKEN_PACK_SIZES=<id>:500000,<id>:1200000,<id>:3000000
```

Frontend (EAS/Expo env):

```
EXPO_PUBLIC_GUMROAD_PRODUCT_URL=<APTITUDE product URL>
EXPO_PUBLIC_GUMROAD_HELP_URL=https://gumroad.com/help/article/76-license-keys
```

Optionally add `GUMROAD_API_TOKEN` as a GitHub Actions secret if CI ever
needs live-API smoke tests (not required — all tests mock Gumroad).

### 6. Verify end-to-end

1. Make a **$0 purchase** of the annual tier with a personal email.
2. Confirm the receipt email contains a license key.
3. `curl https://api.gumroad.com/v2/licenses/verify -d "product_id=<id>" -d "license_key=<key>"`
   → `success: true`.
4. Once phase-6-01 is deployed: refund the test purchase and confirm the
   ping arrives (check structured logs for the persisted `GumroadSale`).

## Acceptance criteria

- [ ] APTITUDE membership live with $0+ annual (suggested $150) and $0+
      monthly (suggested $15) tiers, license keys enabled
- [ ] Three token-pack products live
- [ ] API access token generated and stored in Railway
- [ ] Ping URL configured with shared secret
- [ ] All five backend env vars + two frontend env vars set
- [ ] $0 test purchase verified via the license API
