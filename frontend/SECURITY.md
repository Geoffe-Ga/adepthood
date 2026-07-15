# Frontend security — threat model and known accepted risks

This document tracks security tradeoffs that live in the frontend codebase.
It is **not** a substitute for the backend's own security boundaries (input
sanitization, JWT signing, rate limiting, CORS) — those are in `backend/`.

## Auth token persistence

**File:** `src/storage/secureStringStore.ts` (the shared factory that owns
the web `localStorage` branch). The auth token and BYOK LLM key reach it
through two thin wrappers: `src/storage/authStorage.ts` and
`src/storage/llmKeyStorage.ts`.
**Bug ID:** BUG-FE-AUTH-007
**Status:** Accepted risk on web; migration tracked.

### What happens today

- **Native (iOS / Android):** the JWT is persisted via
  `expo-secure-store`, which delegates to the OS keychain/keystore. The
  token is never readable by the React Native JS context.
- **Web (Expo Web build):** the JWT is persisted via `AsyncStorage`, which
  resolves to `localStorage` in the browser. This is fully readable by
  any JavaScript running on the same origin.

`expo-secure-store` v55 has no web implementation (its web bundle is
literally `export default {}`), so calling `SecureStore.setItemAsync` on
web throws `TypeError`. The platform branch in `secureStringStore.ts`
exists to prevent that crash; the alternative would be the auth flow
failing end-to-end on every web load.

### Concurrent write ordering

Store mutations (`save`/`clear`) on both platforms run through a per-key
serialized write lane (`serializedWrite.ts`, marker `BUG-FE-STORAGE-002`),
so a stale proactive-refresh write issued before a subsequent login or
logout can no longer settle _after_ it via keychain/`localStorage` latency
and strand a stale token. Reads (`load`) stay unserialized. This is a
storage-layer complement to the `expectedPriorToken` identity guards in
`AuthContext.tsx`, which independently protect React state.

### The XSS-window risk

A single successful XSS exploit on the web build yields **full account
takeover**: the attacker reads the JWT from `localStorage` and replays it
from anywhere until it expires or the user logs out. Standard
mitigations like Content-Security-Policy and dependency hygiene reduce
the probability of XSS but do not bound the impact once it happens.

### What we do today to compensate

1. The JS path that uses `localStorage` is isolated to a single file
   (`src/storage/secureStringStore.ts`) and a single platform branch
   (`Platform.OS === 'web'`). `authStorage.ts` and `llmKeyStorage.ts`
   are thin wrappers over that factory; they do not reach into
   `localStorage` themselves, and no other module reaches into
   `localStorage` for the token.
2. The factory file carries a header comment block describing the risk
   so any diff that touches it shows the warning in PR review.
3. The web branch in the factory carries a per-line `BUG-FE-AUTH-007`
   reference, and the `authStorage.ts` wrapper repeats it at its
   factory-instantiation site, so `git grep BUG-FE-AUTH-007` finds
   every token accepted-risk site in one command. The `llmKeyStorage.ts`
   wrapper carries its own `BUG-FE-STORAGE-001` marker at its
   instantiation site (its `localStorage` writes ride the same
   factory branch), so a full audit greps both IDs.

### The migration plan

Move the web build to **httpOnly + SameSite=Strict session cookies**
issued and validated by the backend. The JWT (or a session ID) never
touches JavaScript on web. This requires:

- backend cookie issuance + verification middleware,
- a CSRF mitigation strategy (double-submit token or origin check) since
  cookies are sent automatically,
- a `/auth/refresh` endpoint so the session can be rotated without the
  user re-typing credentials,
- frontend changes to remove the explicit `Authorization: Bearer …`
  header on web and rely on the cookie.

Native builds keep the keychain/keystore path — they are not affected by
this migration.

This work is a separate post-MVP epic, not a hotfix. Until it ships, the
status quo (web `localStorage` + accepted XSS risk) is the documented,
reviewed default.

### Reviewers — what to reject

- **Adding new web persistence code** that puts secrets, tokens, or
  user-identifying data in `localStorage`, `sessionStorage`,
  `IndexedDB`, or any global JS-readable surface, without coming through
  the shared `secureStringStore.ts` factory (or reading this doc and
  updating it).
- **Removing the `BUG-FE-AUTH-007` markers** in `secureStringStore.ts`
  (or the pointer markers at the `authStorage.ts` / `llmKeyStorage.ts`
  factory-instantiation sites) without simultaneously deleting the
  `isWeb` branch and replacing it with a cookie-based flow.
- **Loosening Content-Security-Policy** in a way that adds new XSS
  surface without compensating for the elevated-impact fact above.

## Bot-message ZWJ decomposition

The backend sanitizer strips U+200D (zero-width joiner) so it can also
defeat zero-width smuggling attacks; the side effect is that legitimate
ZWJ-composed emoji written by either the user OR the BotMason model
(`👨‍👩‍👧‍👦` family, `🏳️‍🌈` rainbow flag, professional emoji like
`🧑‍💻` "technologist") decompose into their separate component glyphs in
journal display. Skin-tone modifier and flag-pair sequences are
_unaffected_ because they do not use ZWJ.

This is a deliberate tradeoff documented in
`backend/src/security/text_sanitize.py` — defense-in-depth wins over
rendering fidelity at the trust boundary. If the product later wants
ZWJ-emoji to render correctly, the right path is to allow ZWJ only when
it appears in an emoji ZWJ sequence (per Unicode UTS #51), not to drop
the strip entirely.

## Stored XSS at render time

The backend sanitizes user free-text at insertion (see
`backend/src/security/text_sanitize.py`). The frontend nevertheless
**must** treat any string read from the API as untrusted at render
time:

- React Native's `<Text>` component escapes string children by default.
  Do **not** use `dangerouslySetInnerHTML` (or its RN equivalents) on
  any value that came from the API.
- When rendering Markdown (e.g. `react-native-markdown-display`), make
  sure the configured renderer disables raw-HTML passthrough.
- New rendering paths that interpolate API values into HTML / Markdown
  must be reviewed for XSS even though the backend strips control
  codepoints; render-layer escaping is still the UI's job.

## Where to file new concerns

Open an issue tagged `security` in the project tracker and link this
file in the description. Critical findings (account takeover,
data-exfil, RCE) should also page the on-call directly per the project
incident runbook.
