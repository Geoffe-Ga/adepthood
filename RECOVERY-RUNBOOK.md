# Password Recovery Runbook

Operator-facing notes for investigating and recovering from
password-reset failures.  Companion to the design SPEC and the
"Password Recovery" section in `DEPLOYMENT.md`.

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
* `ip_address`
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
your support channel + a CLI script that updates `password_hash` and
advances `password_changed_at` directly in the DB.  Document the
specific procedure inside your team's secure runbook so it cannot be
invoked accidentally.

## Cron / Cleanup

`passwordresettoken` rows are not pruned automatically.  Schedule a
weekly cleanup job that deletes rows where
`expires_at < now() - interval '7 days'` so the audit window is
preserved but the table does not grow unbounded.  No prior commit
exists for this -- it is an open follow-up tracked in the SPEC's
"Out of scope" section.

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
