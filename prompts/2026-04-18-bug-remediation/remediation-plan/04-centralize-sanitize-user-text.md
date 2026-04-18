# Prompt 04 — Centralize user-text sanitization (Wave 3, parallelizable)

## Role
You are an application security engineer focused on stored XSS and LLM prompt injection. You treat every free-text field as a potential vector and prefer defense at the boundary (insertion time) over defense at the sink (render time).

## Goal
Introduce a single `sanitize_user_text()` helper in the backend and apply it at every point where user free-text is persisted or forwarded to an LLM. No sanitization at render time — defense is at the insertion boundary. A matching frontend helper exists for any client-side persistence paths.

Success criteria:

1. Any router that writes user-authored text to the DB routes the value through `sanitize_user_text()` first.
2. BotMason history replay wraps prior user messages so they cannot forge system/assistant turns (prompt-injection hardening).
3. `X-Request-ID` and any other logged header are validated against a strict regex before emission (stops log injection).
4. JWT/auth wrappers for web persist via an abstraction that surfaces a clear "web fallback — XSS risk accepted" warning in the README (the fix is not "move to cookie now" — that is a larger change; the fix is "document + lint").
5. A test matrix proves the helper strips `<script>`, null bytes, CR/LF, zero-width chars, control characters; preserves legal unicode (emoji, accents, RTL); and is idempotent.

## Context
Bug IDs by report:
- `prompts/2026-04-18-bug-remediation/12-journal.md` — **BUG-JOURNAL-003** (Critical; journal messages stored raw, rendered in chat, echoed into LLM context).
- `prompts/2026-04-18-bug-remediation/13-botmason-wallet-llm.md` — **BUG-BM-004** (history replay enables system-prompt exfiltration).
- `prompts/2026-04-18-bug-remediation/15-weekly-prompts.md` — **BUG-PROMPT-003** (prompt responses stored raw and mirrored into journal).
- `prompts/2026-04-18-bug-remediation/05-backend-app-cors.md` — **BUG-APP-008** (inbound `X-Request-ID` log-injection vector).
- `prompts/2026-04-18-bug-remediation/08-backend-observability-admin.md` — **BUG-OBS-001** (`X-Request-ID` not validated — log-injection + header-splitting).
- `prompts/2026-04-18-bug-remediation/02-frontend-auth-context.md` — **BUG-FE-AUTH-007** (web fallback stores JWT in `localStorage` without XSS warning). This is a doc/lint fix in this prompt, not a redesign.

Files you will touch (expect ≤14): new `backend/src/security/text_sanitize.py`, new test file `backend/tests/security/test_text_sanitize.py`, `backend/src/routers/{journal,botmason,prompts}.py`, `backend/src/middleware/request_id.py` (or equivalent), `frontend/src/storage/authStorage.ts` (doc comment + README note).

## Output Format
Four atomic commits:

1. `feat(backend): add sanitize_user_text helper with full unicode test matrix` — helper + exhaustive tests, no call sites yet.
2. `fix(backend): sanitize journal, weekly-prompt, and botmason-history inputs (BUG-JOURNAL-003, BUG-PROMPT-003, BUG-BM-004)`.
3. `fix(backend): validate X-Request-ID; reject non-ASCII/non-uuid (BUG-APP-008, BUG-OBS-001)`.
4. `docs(frontend): document web JWT fallback XSS risk; add lint-rule note (BUG-FE-AUTH-007)`.

## Examples

Helper contract:
```python
# backend/src/security/text_sanitize.py
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]")
_ZERO_WIDTH = re.compile(r"[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]")

def sanitize_user_text(text: str, *, max_len: int = 10_000) -> str:
    """Strip control/zero-width chars, normalize NFC, enforce length. Pure; idempotent."""
    if not isinstance(text, str):
        raise TypeError("expected str")
    t = unicodedata.normalize("NFC", text)
    t = _CONTROL_CHARS.sub("", t)
    t = _ZERO_WIDTH.sub("", t)
    t = t.strip()
    if len(t) > max_len:
        raise ValueError(f"text exceeds {max_len} chars")
    return t
```

LLM history hardening:
```python
# Wrap prior user turns so the model can't be tricked into treating them as system.
system = {"role": "system", "content": SYSTEM_PROMPT}
history = [
    {"role": m.role, "content": f"<user_message>{sanitize_user_text(m.content)}</user_message>"}
    if m.role == "user" else m
    for m in prior_messages
]
```

Request-ID validation:
```python
_REQ_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
def validate_request_id(raw: str | None) -> str:
    if not raw or not _REQ_ID_RE.fullmatch(raw):
        return uuid.uuid4().hex
    return raw
```

## Requirements
- `security` + `max-quality-no-shortcuts`: reject `# noqa` on any security-related rule; no `type: ignore` on the helper.
- Tests MUST cover: script tags, null bytes, CRLF, zero-width, RTL override (`\u202E`), long emoji sequences, mixed NFD→NFC normalization, empty strings, length-exceeded.
- Do NOT HTML-escape in the backend helper — that belongs at render time in the UI. The helper strips dangerous code points and normalizes; it does not mutate legal content.
- Do NOT combine this with a render-time fix — this prompt is the insertion-boundary fix.
- `pre-commit run --all-files` before each commit; keep coverage >=90%.
- Safe to run in parallel with Prompts 05-10 — no file overlap expected beyond each feature router; if conflict with Prompt 12 arises, Prompt 04 lands first.
