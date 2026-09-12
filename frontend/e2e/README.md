# End-to-end lane: the real client against a real server

Every other test in this repository runs on one side of the wire. The backend
suite drives routes with an in-process client against SQLite; dozens of frontend
test files mock `src/api` outright and the rest never reach the network.
Both can be green while the two halves have never met — which is how six
shipped features turned out to be wired to nothing.

The API lane imports the production API client from
`src/api/index.ts` — unmocked, with its real Zod response validation, its real
retry and refresh loop, and a real `fetch` over a real socket — and drives it
through the journeys registered in `journeys.json` against a live FastAPI app on
a real Postgres whose schema was built by `alembic upgrade head`. The browser
lane adds the production Expo web bundle and a real Chromium process for seams
such as textarea selection that a Node process cannot represent.

## Running it locally

```bash
docker run -d --name adepthood-e2e-pg \
  -e POSTGRES_USER=aptitude -e POSTGRES_PASSWORD=aptitude -e POSTGRES_DB=aptitude \
  -p 5432:5432 postgres:16

cd frontend
TEST_POSTGRES_URL=postgresql+asyncpg://aptitude:aptitude@localhost:5432/aptitude npm run test:e2e  # pragma: allowlist secret

# The browser journey needs the pinned Chromium build once per machine.
npx playwright install chromium
TEST_POSTGRES_URL=postgresql+asyncpg://aptitude:aptitude@localhost:5432/aptitude npm run test:e2e:web  # pragma: allowlist secret
```

The account in `TEST_POSTGRES_URL` needs `CREATE DATABASE`. The lane never
touches the database that URL names: it creates a randomly-suffixed one beside
it, migrates it, and drops it at teardown.

Python has to be able to import the backend. The lane uses `E2E_PYTHON` if set,
falls back to the repo's `.venv/bin/python`, and finally to `python3`. Inside a
git worktree the virtualenv is one level up and will not be found, so point at
it explicitly:

```bash
E2E_PYTHON=/path/to/adepthood/.venv/bin/python npm run test:e2e
```

`test:e2e:web` uses the same backend launcher, database contract, and Python
selection. It additionally starts the production Expo web entry point at
`http://127.0.0.1:3000`, the explicit development-CORS origin, and drives it
with Playwright. A local machine that already has Google Chrome can avoid the
separate Chromium download with `PLAYWRIGHT_BROWSER_CHANNEL=chrome`; CI always
installs and runs the package-pinned Chromium build.

## What is real, and the four external boundaries that are not

Real: the routers, the middleware stack, CORS, session handling, the Pydantic
schemas, the migrations, the startup seeders, the JWTs, bcrypt password hashing,
Postgres constraints — and, on the client side, every wrapper, header, query
string and Zod schema in `src/api/index.ts`.

Stubbed in-process: exactly one function, `routers.auth.verify_aptitude_license`. Signup is
gated on a live HTTPS call to Gumroad's license API, and an e2e lane that
depended on a third party's uptime would be a flake generator. `backend/conftest.py`
stubs the same seam for the same reason. Everything the gate does with the
answer — the duplicate-email refusal, the password hashing, the licence binding,
the entitlement grant — still runs for real.

The stub reports the licence key itself as Gumroad's sale id. One sale binds to
exactly one active account (ADR 0008), so every account a journey creates needs
its own key — `freshLicenseKey()` in `e2e/licenseKey.ts` mints one — and a
journey that presents the same key twice is deliberately proving the invariant
across the seam (`auth.e2e.test.ts`), or the release of the key when the first
account is deleted (`account-deletion.e2e.test.ts`).

The launcher also disarms the rate limiter. Signup is capped at three per minute
per client address and every journey here shares `127.0.0.1`, so leaving it
armed would make "how many journeys exist" a hidden global constraint: one more
journey, or one retry, would start failing on a cap rather than on a defect.
Rate limiting keeps its own tests in the backend suite.

The private-vault activation journey also starts an isolated fake Creek control
plane on a kernel-selected loopback port. Adepthood still uses its production
HTTP provisioning client, bearer files, contract-version header, routers,
Postgres lifecycle, and authenticated one-way handoff endpoint; only Creek's
external allocator is represented by the fake. The fake rejects a ceremony body
containing passphrase or recovery-key fields, returns `attested_confidential:
false`, and is killed with its generated credential directory at teardown.

The spent-provider-balance journey adds the third external boundary: a
loopback process that speaks both LLM providers' HTTP APIs. The lane's server
runs the stub BotMason provider, which has no account, no key and no network and
therefore cannot refuse for billing, so the one condition that journey is about
was unreachable from any spec. The fake is reached through the SDKs' own
`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`, so nothing is patched or injected:
adepthood builds its production `openai.AsyncOpenAI` / `anthropic.AsyncAnthropic`
clients exactly as it does in production, and `openai.RateLimitError` /
`anthropic.BadRequestError` are constructed by those SDKs out of the fake's
response bytes. That is the whole point — injecting the typed error would prove
the routing and _assume_ the classification, and the classification is where the
bug lived. Which refusal a request gets is decided by the API key it presents,
because that is what decides it in reality; the three keys are minted per run
into a `0600` directory and an unrecognised key gets each provider's own 401, so
a mis-wired lane fails loudly rather than serving something that looks like
success. `GET /__lane/attempts` reports how many requests reached each surface,
by shape and never by key, which is what lets a spec prove a press actually
reached a provider instead of a wallet that never moved because nothing was ever
charged.

`BOTMASON_PROVIDER` stays unset, so every other journey still runs the stub. Two
things reach the fake at all: a request carrying a BYOK key (whose prefix selects
its own provider, which is what the 402 half is _about_), and a request whose
prompt carries the `BOTMASON_PROVIDER_PROBE_TOKEN` marker. The probe is the only
way a pass paid for by the _server's_ key can reach a provider on a
stub-configured deployment, which is the 503 half. It is off unless configured,
consulted only when no real provider is configured — so no text in a request can
redirect a deployment that already dials OpenAI or Anthropic — and
`main.validate_provider_probe_config` refuses a production boot while it is
armed, on the same terms as the capture email backend below. The privacy floor is
asserted with all of it live: an intimate page carrying the marker, on a server
whose own key is armed, still reaches no provider at all.

That journey also reads `walletaudit` out of band, through
`backend/tests/e2e/wallet_audit.py`. The table has no API by design (it is a
forensic surface for operators), and it is the only place that distinguishes
"never charged" from "charged and put back" — the resonance route commits its
deduction before the first dial, so the second is what actually happens on a
refusal. The helper only ever reads.

The two vault journeys add the fourth and last boundary: a loopback process
answering Creek Vault's published `/v1` surface, `fakeCreekVault.mjs`.
`seed.upload-document` proves a document is accepted, while
`journal.withdraw-connected-vault-copy` proves a page and its generated Voice
Draft are not presented as deleted until Creek confirms both content-free
retractions. Without this process every import takes the local-fallback path and
the withdrawal retry never reaches a remote replica; specs written anyway would
register coverage while proving neither real outcome. Creek Vault is an
external product with its own repository, which is what makes this a boundary
and not an adepthood surface.

Nothing on the request path is stubbed to reach it. The server is booted with
`CREEK_VAULT_URL` and `CREEK_VAULT_API_KEY` — ordinary production settings — so
adepthood builds its real `HttpCreekVaultClient`, negotiates the real capability
document, and posts a real `UploadRequest` over a real socket. The fake refuses
like the real thing: an unrecognised bearer is a 401, a missing
`X-Creek-Contract-Version` is a 409, a field adepthood invented is a 400, so a
mis-wired lane fails loudly rather than serving something that looks like
success. Its bearer is minted per run into a `0600` directory and dies with it.

Plaintext loopback is admitted here for one specific reason, and only here. The
**operator's** deployment-wide `CREEK_VAULT_URL` exempts loopback by design
(`services/creek_vault_url`) — whoever set it owns the machine the process runs
on. A **user-supplied** URL arriving in a `PUT /vault/connection` body is judged
by a stricter rule set (`services/creek_vault_url_user`) that refuses loopback
outright and re-judges the stored host on every dial, which is why the
connect-your-own path cannot reach a stand-in vault beside the lane, and why
this boundary is configured deployment-wide.

Two things keep it from disturbing any other journey. The vault advertises only
the five capabilities those two journeys exercise — capabilities, upload,
journal upsert, journal withdrawal, and Voice Drafts — with the exact list
ratcheted by `e2eLaneGuard.test.ts`. And `CREEK_VAULT_OWNER_USER_ID` binds the
vault to exactly one pre-provisioned account used only by those specs: every
other account in the lane is served the local fallback, which is byte-for-byte
the behaviour it had before.

`GET /__lane/uploads` reports what actually arrived — every `/v1` request in
order and the upload, journal, and Voice Draft fragments the ledger holds, by
kind, identity, action, and a digest of the bytes, never by the bytes. That is
what lets the specs prove both halves of their privacy claims: an Intimate
document adds no request, and a failed draft deletion leaves its opaque identity
present until a confirmed retry removes it. `POST
/__lane/fail-next-voice-draft-delete` arms exactly one deterministic 503 so the
recovery path is exercised over the socket rather than by replacing a client.

The owner is provisioned by `globalSetup`, and the assertion that it worked is
the point. `CREEK_VAULT_OWNER_USER_ID` is read from the server process's
environment, so it names an id fixed before the database exists. The lane closes
that circle by naming the first id `user`'s identity sequence will hand out and
then signing that account up over HTTP as the lane's very first request — real
signup, real licence gate, real hashing — and throwing the whole run down if the
id it gets back is not the one already named. A guess that stopped holding fails
at setup, loudly, instead of leaving one spec asserting `vault_unavailable` and
calling it coverage.

One consequence is worth stating rather than leaving to be discovered: with
`CREEK_VAULT_URL` set, `DELETE /users/me` reports `vault.configured: true` and
the guidance a vault-holding deployment owes, for **every** account rather than
only the owner's — `services/account_deletion` reads the deployment variable,
not the caller's own connection. That is the one observable difference this
boundary makes to another journey, and `account-deletion.e2e.test.ts` now
asserts that exact sentence rather than merely a non-empty one, so it is pinned
instead of merely tolerated.

One thing is configured rather than faked, and it is worth stating plainly
because it looks like a fake and is not. The password-recovery journey has to
read a plaintext reset token, and that token exists nowhere but the rendered
body of an email: the row holds a bcrypt digest, the response is a fixed
anti-enumeration sentence, and the console adapter masks the token to its first
eight characters before it reaches any log. So the lane boots the server with
`EMAIL_BACKEND=capture`, a `services.email` adapter that appends every rendered
message verbatim to the file `EMAIL_CAPTURE_FILE` names. Nothing is stubbed,
patched or rebound to reach it — the adapter is selected the way `console` and
`smtp` are, and the routers, the renderer and the token minting are the
production ones. It writes a live credential to disk, which is why
`services.email` refuses to build it when `ENV` names production, and why
`main.validate_email_config` refuses the boot as well; both refusals have tests,
and the second is driven through the app's own `lifespan`. The lane also sets
`APP_BASE_URL` to an `https://` origin under the reserved `.invalid` TLD, so the
journey can assert on the browser-followable link the mail carries without
anything ever resolving it. The captured mail is deleted at teardown with the
directory it lives in.

`frontend/__tests__/e2eLaneGuard.test.ts` enforces every one of those boundaries
mechanically. It runs in the ordinary frontend suite and fails if a journey ever
mocks the API module or `fetch`, if the launcher stubs anything besides the
license check, if the vault fake widens what it advertises, or if the CI job
acquires a way to be disarmed.

Note what the guard's "exactly one stub" rule is and is not about. It reads the
lane's **Python** for a module attribute rebound to a callable — a function, a
lambda, a `Mock` — because that is what stubbing means on the request path. A
loopback process that the production client genuinely dials over a real socket
is the opposite of that: nothing is rebound, the transport is real, and the
protocol is exercised rather than assumed. All four boundaries above are of that
second kind. The one in-process stub is still, and only, the Gumroad licence
check.

## The ledger

`journeys.json` beside these specs is the repository's journey coverage ledger:
every critical journey, the surfaces it crosses (screen → client wrapper →
route → table), and either the spec that covers it or the issue tracking the
gap. It is not documentation. `npm run check:journeys` — and the
`journey-ledger` job in `.github/workflows/e2e.yml` — audits every claim in it
against the tree, and goes red when a covering spec is renamed, deleted or
turned off, when a spec here is not declared, or when a crossed surface no
longer exists under the name the ledger gives it.

A declared route has to clear two checks, because "the server serves it" and
"the app can ask for it" are different claims. The first reads
`backend/openapi.json`; the second reads the call sites in `src/api/index.ts`,
matching a declared `{param}` against an interpolated segment. A route that
passes the first and fails the second is served and unreachable, and a journey
naming one describes a seam with no client half — a spec written to it would
have to hand-roll the request and would prove only that the server works.

Honest gaps are the point. A journey may declare `status: "uncovered"` with a
linked issue; the gate counts it and reports it and does not fail on it, because
a gate that goes red for accurate bookkeeping is a gate that gets deleted.
Omitting an uncovered journey to keep the number down is the one thing the
ledger cannot catch and the one thing that would make it worthless. An uncovered
journey names no `coveredBy`: claiming a spec while counting as a gap would drop
that spec out of the covered tally and out of the "no journey registers it"
check at once, which is coverage disappearing quietly — the exact thing this
ledger exists to prevent.

"Turned off" is judged per test registration rather than by searching the file
for marker text. A spec that parks one `it.skip` beside a live journey test
still covers the journey; a spec whose only live test sits inside a
`describe.skip` does not; and a spec narrowed by `.only` fails whatever else it
contains, because the tests `.only` silences are exactly the ones the ledger is
claiming. A comment or a test name that merely mentions `it.skip(` is not a
skipped test.

The checker lives at `frontend/__tests__/journeyLedger.ts` with the repository's
other structural guards, and is exercised by `journeyLedger.test.ts` against
synthetic fixtures for each failure mode — so the gate is proven to fire, not
merely proven to be green.

## No skips, ever

An absent Postgres, a server that will not boot, or a health probe that answers
wrong all throw. There is no conditional skip anywhere in the lane, because a
lane that quietly passes without making a request is precisely the gap it was
built to close.

## Teardown

`globalTeardown` SIGTERMs the server's process group, escalates to SIGKILL after
ten seconds, and then drops the database. The server cannot reliably drop its
own: uvicorn re-raises the signal that stopped it, ending the process before any
`finally` of its own runs. If the whole jest process is itself SIGKILLed, one
randomly-named database survives — it can never collide with a later run, and
`DROP DATABASE IF EXISTS adepthood_e2e_<suffix>` cleans it up.
