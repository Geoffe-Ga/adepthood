# Telemetry egress inventory

> **DRAFT. Owner review required.** This draft is for #3064. It lists every
> transport through which the backend or the app emits operational telemetry,
> and what each one carries **as the code at this commit enforces it**. It
> makes no claim about deployed configuration. Three things are left open:
> retention (B08 / #3063), who can read each sink (owner: needs the Sentry and
> Railway consoles), and the public no-content claim (B01 / #3057, B24 /
> #3076). Nothing here is privacy-policy copy.

## The invariant

No telemetry sink carries user content. An exception is described by its
class, its frame locations, and a static `safe_code` the class declares;
otherwise it reads `message_withheld`. A request is described by its method,
its matched **route template** (`/practices/share/{token}`, never the raw path
or its query string), its status and its latency.

`backend/tests/security/test_telemetry_sentinels.py` enforces this. Canaries
(short, 600-char, Unicode, multiline, RTL, emoji) are planted in exception
messages, chained causes, exception groups, pydantic `ValidationError`
input, path parameters, query strings and SDK-shaped keys. The tests assert
that none of them reaches the Sentry envelope, the root log stream, uvicorn's
handlers or the access record. The frontend counterpart is
`frontend/src/observability/__tests__/sentryEnvelope.test.ts`.

## Transports

| # | Transport | What it may carry | Chokepoint (code) | Enforcing test | Retention | Who can read |
|---|---|---|---|---|---|---|
| 1 | **Backend Sentry** (only if `SENTRY_DSN` is set) | `event_id`, `timestamp`, `platform`, `level`, `environment`, `release`, `sdk{name,version}`, `tags.request_id`, `contexts.adepthood_request{request_id, request_path = route template, request_method}`, and per exception: `type`, `module`, `mechanism{type, handled}`, frames `{filename, function, lineno, in_app}`, and `value` = declared `safe_code` or `message_withheld`. No integrations are installed. | `sentry.scrub_event` (allowlist rebuild), `sentry.APPROVED_INTEGRATIONS` | `test_telemetry_sentinels.py` (Sentry sections), `test_error_monitoring.py`, `test_legal_documents.py` | TBD (B08) | TBD (owner) |
| 2 | **Frontend Sentry** (only if `EXPO_PUBLIC_SENTRY_DSN` is set) | `event_id`, `timestamp`, `platform`, `level`, `environment`, `release`, `exception.values[0] = {type: class-shaped name or Error/UnknownError, value: message_withheld}`, `contexts.react.componentStack` (component names), `contexts.errorBoundary{boundary, name}` | `observability/sentryEnvelope.ts` `buildEvent` | `sentryEnvelope.test.ts`, `sentry.test.ts` | TBD (B08) | TBD (owner) |
| 3 | **Root log stream → stderr → Railway log collection** | Each record's static message and `[trace_id]`. Tracebacks render frames plus `Type: safe_code / message_withheld`. Exceptions passed as `%`-arguments or as the message are replaced by their label. A record that cannot be formatted becomes a fixed line. `extra=` fields are not printed by the format. | `observability.ContentFreeFormatter` on the app handler | `test_telemetry_sentinels.py` (log-stream section) | TBD (B08; Railway plan) | TBD (owner; Railway project members) |
| 4 | **`adepthood.access`** (the app's own access record, on #3) | Rendered line: `request_completed method=… route=<template or <unmatched>> status=… elapsed_ms=…` plus `[trace_id]`. Extras: `http_method`, `http_path`, `http_status`, `elapsed_ms`, and `original_host` when the canonical-host layer replaced the authority | `middleware/logging.py`, `observability.route_template` | `test_share_token_never_reaches_the_access_log`, `test_an_unmatched_path_logs_the_marker`, `test_middleware_stack.py`; the nightly DAST evidence gate reads this line (`test_scan_evidence_reads_the_app_log.py`) | as #3 | as #3 |
| 5 | **`uvicorn` / `uvicorn.error`** (server's own handlers → stderr) | Server lifecycle lines. "Exception in ASGI application" tracebacks, rendered content-free. | `observability._harden_library_loggers` installs `ContentFreeFormatter` on them | `test_uvicorns_own_traceback_is_content_free` | as #3 | as #3 |
| 6 | **`uvicorn.access`** | **Nothing (disabled).** It used to carry the raw request line *with the query string* (journal `?search=`) and the client IP. | `--no-access-log` in `backend/Dockerfile` CMD; `uvicorn.access` disabled in `configure_logging` | `test_the_runtime_cmd_disables_uvicorns_access_log`, `test_uvicorns_access_logger_is_switched_off` | n/a | n/a |
| 7 | **`httpx` / `httpx2`** (outbound HTTP client loggers) | WARNING and above only. The INFO per-request line, which carries the outbound URL (a user's vault address and an entry id in its path), is suppressed. | `observability._OUTBOUND_CLIENT_LOGGERS` | `test_outbound_request_urls_stay_out_of_the_info_stream` | as #3 | as #3 |
| 7a | **`slowapi`** (rate limiter logger, on #3) | Its "limit exceeded" warning, reduced to the limit itself (`ratelimit 30 per 1 hour exceeded`). The throttle key (the caller's address) and the raw path (which can hold a share token) are dropped. Its storage warnings and errors are kept. | `observability.RateLimitRecordFilter` | `test_a_rate_limited_share_token_never_reaches_the_log` | as #3 | as #3 |
| 8 | **Creek vault telemetry** (in-process tally plus one log line on #3) | Closed vocabulary only: `VaultTelemetryOutcome`, `CreekCapability` wire name, `VaultErrorCode` | `services/creek_vault_telemetry.py` | that module's own suite | in-process tally: process lifetime; log line: as #3 | as #3 |
| 9 | **LLM metering** (`LLMUsageLog` rows, Postgres) | Per-call usage accounting. Field review belongs to B08. | `models/llm_usage_log.py` | B08 | TBD (B08) | TBD (owner; database access) |
| 10 | **Feedback correlation id** | A random per-session id the app generates, stored on a feedback report alongside the seven-field allowlisted context | `routers/feedback.py` | feedback suites | TBD (B08) | TBD (owner) |
| 11 | **Email relay** (transactional mail provider) | The outbound message itself (product function, not telemetry). Its log lines are static plus provider status. | `services/email.py` | email suites | provider-side: TBD (owner) | TBD (owner) |

## Open rows (not closed by this slice)

- **`alembic upgrade head` in the runtime CMD.** If a migration fails, the
  traceback is printed by Python's default excepthook or by alembic's own
  logging config, not by `ContentFreeFormatter`. An `IntegrityError` there can
  quote row data. Follow-up: AC24.
- **Python's default excepthooks.** `threading.excepthook` and an unhandled
  exception at interpreter level print to stderr directly, outside logging.
  Follow-up: AC24.
- **Pre-stringified exception text.** The formatter neutralises exception
  *objects*. An f-string or `str(exc)` built into the message before logging
  is not caught. At this commit the grep finds one such site in
  `backend/src`: `sentry.py` logs the SDK's `BadDsn` text, which describes
  configuration and is passed through credential redaction. The AC24 audit
  should keep the grep in CI.
- **Deployed configuration.** None of the following can be verified from the
  repository: Sentry project server-side scrubbing, IP storage, retention and
  member access; Railway log retention and drains; a future Fly host (B16),
  whose launcher must keep `--no-access-log`. All of these are owner
  escalations (#3064 AC18, AC19).
- **Privacy policy.** `docs/legal/privacy-policy.md` (the Sentry paragraph)
  still says the exception message is sent. That now over-discloses. B01 owns
  the wording (#3064 AC17).
