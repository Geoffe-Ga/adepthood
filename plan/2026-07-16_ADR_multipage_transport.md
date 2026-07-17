# ADR-2: Multi-Page Transport Strategy

**Status:** Proposed · **Date:** 2026-07-16 · **Feature:** Journal
Photographer · **Depends on:** ADR-1 (server-side call)

**Context:** A capture session holds 1–10 pages (cap per R5) that must be
transcribed and merged into one entry in capture order. The question is how
pages travel from client to provider: one request carrying N images vs N
requests merged client-side.

Constraints measured in research (findings § R3.5):

- Per-page payload at 1568px long edge ≈ 400–800 KB base64.
- Server LLM timeout is **30 s per provider call**
  (`backend/src/services/botmason.py:139`); client fetch timeout is **30 s**
  default with per-request override (`frontend/src/api/index.ts:81, 271-272`).
- Realistic vision latency is ~5–15 s per page of dense handwriting; a
  single call transcribing N pages scales roughly linearly and blows the 30 s
  budgets around 3–5 pages.
- Client retry only covers idempotent/keyed requests
  (`index.ts:91-94, 319-322`); there is no app-level body-size limit
  server-side (findings § R3.3) — whatever we choose defines the policy.
- Provider ceilings (Anthropic ≤100 images/request, ~5 MB each) do not bind
  at ≤10 pages.

**Impact:** endpoint contract, client capture-session logic, failure-path
UX, and ADR-4 (progress display).

---

## Option A: One request, N images, one LLM call

`POST /journal/transcribe` accepts all pages; the backend sends one
multi-image message ("transcribe pages in order, blank line between pages").

**Pros:** single round trip; prompt tokens paid once (~600–900 tokens saved
per additional page); ordering handled in one place.

**Cons:** one provider call transcribing N pages exceeds the 30 s LLM
timeout at roughly ≥3 pages — would force raising a global timeout that
resonance/essay also share; partial failure = retransmit and re-pay for
every page; a 10-page request is a 4–8 MB body through the JSON client;
model quality degrades merging many dense pages in one completion (ordering/
omission errors are harder to attribute to a page); no per-page progress
possible (locks ADR-4 into a blocking spinner).

**Effort:** Low (one endpoint, one call).

## Option B: N requests, one page each, client merges

`POST /journal/transcribe-page` accepts exactly one image; the client fires
one request per page (bounded concurrency of 2), keeps results indexed by
page position, and joins them with blank lines in capture order.

**Pros:** every call fits comfortably inside both 30 s budgets; per-page
retry with no wasted spend (retry only the failed page — matches the
"retake/retry/remove page" failure-path requirement); per-page progress for
free (enables ADR-4's progressive option); bodies stay ≤ ~1 MB each —
smallest payload policy to define and validate; per-page results make
"page 3 unreadable" attributable and recoverable; endpoint is simpler to
test and to rate-limit.

**Cons:** prompt tokens paid N times (~+0.6–0.9 K input tokens/page ≈
+$0.002–0.003/page on the default model — negligible vs the image tokens);
N HTTP round trips (mitigated by concurrency 2); ordering is client-side
(trivial: index-keyed array); N slowapi hits per session — the `10/minute`
convention must be sized for pages, not sessions (e.g. `20/minute` on this
endpoint, still bounding a 10-page session).

**Effort:** Low–Medium (same endpoint complexity; small client scheduler).

## Option C: One request, N images; server loops per-page calls internally

Single upload; backend makes N sequential/parallel provider calls and
returns the merged text.

**Pros:** one upload; per-page LLM calls keep provider timeouts safe;
merging server-side.

**Cons:** the *HTTP* request now lasts N × page latency (50–150 s at 10
pages) — far beyond the client's 30 s fetch timeout and any sane
request-duration budget on Railway; requires either long-poll/SSE/job
polling machinery (net-new infrastructure, contradicts "no new heavyweight
dependencies") or an unacceptably long override; partial-failure semantics
get complicated (which pages failed inside one 200/502?); still a 4–8 MB
body; per-page progress needs streaming.

**Effort:** High (job/streaming machinery).

---

## Comparison matrix

| Criterion | A: 1 req / 1 call | B: N reqs / N calls | C: 1 req / N calls |
|---|---|---|---|
| Fits 30 s server LLM timeout | ❌ ≥~3 pages | ✅ | ✅ per call |
| Fits 30 s client fetch timeout | ❌ | ✅ | ❌ |
| Partial-failure recovery cost | ❌ whole session | ✅ one page | ⚠️ complicated |
| Per-page progress (ADR-4) | ❌ | ✅ | ⚠️ needs streaming |
| Max request body | 4–8 MB | ~1 MB | 4–8 MB |
| Token overhead | best | +~0.7 K in-tokens/page | best |
| New infrastructure needed | none | none | job/SSE machinery |
| Attribution of unreadable pages | ⚠️ | ✅ | ✅ |

## Recommendation

**Option B — one request per page, client-side merge.** It is the only
option that fits both existing 30 s timeout budgets without touching shared
constants, gives the failure-path UX the requirements demand (retry/retake a
single page), and unlocks progressive delivery for ADR-4 — at a token
overhead of well under a cent per session. Bound client concurrency at 2 and
set the endpoint rate limit at `20/minute` (named constant), with the
10-page session cap enforced client- and server-side.

**Question for reviewer:** confirm Option B (and the `20/minute` /
concurrency-2 parameters).
