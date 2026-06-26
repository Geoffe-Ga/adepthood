# Password Recovery Runbook

Operator-facing notes for investigating and recovering from
password-reset failures.  Companion to the "Password Recovery"
section in `DEPLOYMENT.md`.

## SPEC Requirements Matrix (R1–R10)

The original SPEC document lived at ``plans/SPEC.md`` while the
feature was being built; it was retired once every requirement
landed in code.  Source comments still cross-reference these by
short label (``SPEC R4``, ``SPEC R7``, etc.) -- this matrix is
the canonical resolution for those references.

| ID  | Requirement                                                                                   | Where it lives                                                                       |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| R1  | Plaintext tokens are 256-bit ``secrets.token_urlsafe(32)``; stored only as bcrypt digest.     | ``auth.py`` ``_RESET_TOKEN_BYTES`` / ``_hash_reset_token``                           |
| R2  | Token TTL is 30 minutes.                                                                      | ``auth.py`` ``_PASSWORD_RESET_TTL``                                                  |
| R3  | Single-use: ``used_at`` or ``cancelled_at`` non-null ⇒ confirm rejects with generic 400.      | ``auth.py`` ``_select_active_token_only``                                            |
| R4  | Anti-enumeration: 202 with identical body on hit and miss; constant-time bcrypt on miss path. | ``auth.py`` ``_consume_dummy_bcrypt`` + ``_consume_dummy_password_verify``           |
| R5  | Per-IP rate limits (3/hr request, 5/hr confirm) + per-user cap of 3 outstanding tokens.       | ``auth.py`` ``_MAX_OUTSTANDING_TOKENS_PER_USER`` + ``_auto_cancel_oldest_active_token`` |
| R6  | Successful reset clears the ``LoginAttempt`` lockout window for that email.                   | ``auth.py`` ``_clear_recent_failed_attempts``                                        |
| R7  | Session invalidation via ``user.password_changed_at`` (Option α from the SPEC).               | ``auth.py`` ``_token_predates_password_reset``                                       |
| R8  | Out-of-band "your password was changed" email after every successful confirm.                 | ``auth.py`` ``_build_change_notification_email`` -- see "R8 Design Decision" below   |
| R9  | No PII in logs: ``email_fingerprint`` (SHA-256 prefix), IP, action; never raw email or token. | ``auth.py`` ``_log_reset_event`` + ``_email_log_fingerprint``                        |
| R10 | Password rules unchanged; reject reuse of the current password.                               | ``auth.py`` ``_reject_if_password_reuse``                                            |

### R8 Design Decision: change-notification recipient action

The SPEC's R8 originally proposed an automated "freeze the account
(``is_active = False``)" path triggered by the user clicking a
"this wasn't me" link in the change-notification email.  This PR
ships R8 in a slightly narrower form:

* The notification is sent on every successful confirm (the SPEC
  requirement -- shipped).
* The email asks the user to **request another reset immediately**
  if the change was unauthorized, which routes operator attention
  through the ``support`` channel and the audit-log grep flow above.
* **Automated freeze is deliberately deferred.**  The cancel
  endpoint marks an outstanding token as ``cancelled_at`` but does
  not flip ``user.is_active``.  Reasons:
  * In an account-takeover scenario the attacker already has the
    new password; an automated freeze on a button-click in the
    notification is reachable by the attacker too (they intercept
    the email).
  * Operator-driven freeze is auditable and reversible -- a
    button-driven one is not.
  * The "Manual Override" section below documents the freeze + new
    password procedure operators run when a user reports
    unauthorized access.

If the calculus changes (volume justifies automation, or a stronger
pre-freeze identity-proof exists), promote ``cancel_password_reset``
to also write ``user.is_active = False`` and emit a
``confirm_rejected_account_frozen`` audit event.  The migration
required is a no-op (column already exists).

## At a Glance

| Symptom                       | First check                                                  |
| ----------------------------- | ------------------------------------------------------------ |
| User says link never arrived  | Inbox spam folder, then audit logs by email fingerprint      |
| User says link expired        | Issue a fresh request -- old link is dead, new one works     |
| User says link is invalid     | Check the URL was not split across two lines in the email   |
| Many users, all reports today | SMTP provider outage; check provider status page first       |
| Reset succeeded but no login  | Verify `EMAIL_BACKEND=smtp` + `SECRET_KEY` are set correctly |

## Audit Trail

Every reset event lands in the application logs as a
`password_reset_event` line with:

* `action` (`requested` / `confirmed` / `cancelled` / `cancel_noop` /
  `confirm_rejected`)
* `email_fingerprint` -- the SHA-256-prefix-hash from
  `_email_log_fingerprint`; correlate by the SAME fingerprint across
  lines, never by email
* `ip_address` -- read from `X-Forwarded-For`; trustworthy only if
  the ingress chain strips/replaces the header (see `DEPLOYMENT.md`
  "Trusted Proxy / X-Forwarded-For").  Treat as advisory if the
  deployment exposes the API container directly to the public.
* `timestamp`

Recover the fingerprint for a given email locally:

```python
import hashlib
hashlib.sha256("user@example.com".strip().lower().encode()).hexdigest()[:12]
```

## Investigating "I never got the email"

1. Confirm the address is registered (database query, not the API --
   the API will not tell you and that is by design).
2. Compute the fingerprint above and grep the logs for it.
3. If you find a `password_reset_event` with `action=requested`, the
   server accepted the request and called the email backend.
4. Check the SMTP provider's outbound log for a delivery attempt to
   that address within the relevant minute window.
5. If the provider shows a deferral or bounce, that is the answer
   (full inbox, blocked sender, etc.).  Direct the user to check
   spam, then re-issue.

## "Help, I am locked out"

A reset succeeds even if the account is mid-lockout (SPEC R6 -- the
reset clears the recent failed-attempt window).  If a user reports
"locked out forever", they are conflating two things:

1. The lockout was for password attempts, which a reset fixes.
2. The reset itself failed -- check the audit trail for a
   `confirm_rejected` event.

A `confirm_rejected` line means one of: token expired, token used,
token cancelled, password matched the current one (R10).  All return
the same generic 400 to the client; the audit log distinguishes them
when you cross-reference the row state in `passwordresettoken`.

## "This wasn't me" (cancel link tap)

If a user taps the cancel link from a recovery email they did not
request:

1. The token is marked `cancelled_at = now()`; subsequent confirm
   attempts return the generic 400.
2. No login is required for cancel -- possession of the token is the
   trust anchor (same model as confirm).
3. Follow up via the support channel: someone tried to reset their
   password.  Often this means a credential-stuffing attempt against
   the email address; consider asking the user to enable a stronger
   password or pause notifications until investigated.

## Operational Limits

* **Rate limits:** 3 requests/hour and 5 confirms/hour per IP, plus
  3 outstanding tokens per user (the 4th auto-cancels the oldest).
  Spike beyond either is a signal to look at the source IP for
  abuse, not a bug to fix in the limits.
* **Token TTL:** 30 minutes.  Operators cannot extend an issued
  token; issue a fresh one instead.
* **Plaintext token retention:** zero.  We store only a bcrypt
  digest.  No SQL query can recover a leaked token after the fact;
  the user must request a new one.

## Manual Override

There is no operator UI to manually reset a password; it is
intentional.  If a user truly cannot complete the email flow (lost
inbox access, etc.), the recovery path is account verification via
your support channel + a one-shot Python REPL session that updates
`password_hash` and advances `password_changed_at` directly in the DB.

A reference snippet (run inside `python -m asyncio` from the backend
container, with `SECRET_KEY` and `DATABASE_URL` already set):

```python
from datetime import UTC, datetime
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlmodel import select
from database import engine
from models.user import User
from routers.auth import _hash_password

email = "user@example.com"  # the verified support contact
new_hash = _hash_password("a-temporary-passphrase-rotate-immediately")
async with async_sessionmaker(engine, expire_on_commit=False)() as s:
    user = (await s.execute(select(User).where(User.email == email))).scalar_one()
    user.password_hash = new_hash
    user.password_changed_at = datetime.now(UTC)
    await s.commit()
```

Distribute the verified-temporary password via a side channel (phone
+ SMS, or in-person), require the user to log in and rotate
immediately, and revoke any outstanding sessions by relying on the
`password_changed_at` JWT gate (already in place).  Anything more
durable (a CLI subcommand, an admin UI) is deliberately deferred --
moving manual overrides out of an interactive REPL would lower the
friction below what a recovery flow this powerful warrants.

A purpose-built CLI for this (e.g. `python -m scripts.manual_reset
--email ...`) is tracked as a follow-up GitHub issue rather than
shipped here; an interactive REPL is enough until support volume
justifies the wrapper.

## Cron / Cleanup

`passwordresettoken` rows are not pruned automatically.  Schedule a
weekly cleanup job that deletes rows where
`expires_at < now() - interval '7 days'` so the audit window is
preserved but the table does not grow unbounded.  Note the retention
window is "7 days **after token expiry**", not 7 days after creation:
a token minted at T with a 30-minute TTL expires at T+30m and is
purged at T+30m+7d (~7 days, 30 minutes after creation).  This is
deliberate -- it gives ops a full week of post-mortem data on every
expired token.  No prior commit exists for this -- it is an open
follow-up tracked in the SPEC's "Out of scope" section.

Concrete recipe (PostgreSQL with `pg_cron`):

```sql
-- One-time setup (run as the DB superuser):
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Weekly purge of reset tokens older than the 7-day audit window.
SELECT cron.schedule(
    'purge_password_reset_tokens',
    '0 4 * * 0',  -- Sundays 04:00 UTC
    $$DELETE FROM passwordresettoken
       WHERE expires_at < now() - interval '7 days'$$
);
```

If `pg_cron` is unavailable (e.g. some managed Postgres tiers), wire
the same `DELETE` into a Railway / GitHub Actions cron job that hits
the DB once a week.

## Accepted Risks

* **Reset tokens travel in the URL query string.**  The deep-link
  format is `adepthood://reset-password?token=...`.  Mobile OS
  link-handling APIs and crash reporters can capture full URLs, so
  the token may transiently land in OS / vendor logs.  Mitigation:
  the 30-minute TTL and single-use lifecycle bound the exposure
  window even if a token leaks via this channel.  A future migration
  to URL fragments (`#token=...`) is not viable for mobile deep
  links; promoting to a POST-only confirmation form behind a
  one-time landing page is the long-term fix.
