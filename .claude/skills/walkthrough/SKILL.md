---
name: walkthrough
description: >-
  Hand-hold Geoff through a `[HUMAN ACTION]` ops ticket one gated block at a
  time. Use when he says "walk me through", "/walkthrough", "help me do the
  human action issue", "let's do the Gumroad setup", "provision the OAuth
  credentials", or names an ops ticket he has to click through himself.
  Verifies the ticket's claims against HEAD *and* against the vendor's current
  documentation before giving a single instruction, because console UIs drift
  and this repo's issue bodies go stale. Then delivers ONE doable block at a
  time — exact click path or exact command — and stops at a gate he clears by
  pasting back non-sensitive evidence.
  Do NOT use for coding tickets (use continue-epic), for PR review feedback
  (use address-feedback), or to perform the console steps itself — the whole
  point is that a human holds these credentials.
---

# Walkthrough — a human-in-the-loop ops runbook

Geoff owns the accounts. You own the *sequencing, the verification, and the
proof*. He should never have to hold the whole ticket in his head, guess which
console tab he is in, or wonder whether a step actually worked.

## The three rules that make this useful

1. **One block at a time.** A block is what a person can finish in a sitting
   without switching accounts or waiting on someone else. Never print the whole
   runbook. Never queue two console visits in one block.
2. **Every block ends at a gate.** He pastes evidence; you confirm it or send
   him back. No "let me know when you're done" — that is not a gate.
3. **Never ask for a secret or PII.** See "Gate safety" below. This is absolute:
   a walkthrough that leaks a client secret into a transcript has done more harm
   than the ticket was worth.

---

## Phase 0 — pick the ticket and read it whole

```bash
gh issue list --state open --search "HUMAN ACTION in:title" --json number,title
gh issue view <N> --json title,body,labels,comments
```

Read the **entire** body and every comment before saying anything. These tickets
carry audit notes that supersede the original text.

If he named no ticket and there is more than one, list them with a one-line
"what this unlocks" each and ask which. That is the one question worth asking up
front.

## Phase 1 — verify before you instruct

**Do not skip this and do not do it silently.** Two independent checks:

### 1a. Does the repo still match the ticket?

Check every file, env var and symbol the ticket names. This repo's issues have
repeatedly described architecture that moved — four `agent-ready` issues in one
day had false premises. An ops ticket sending him to create a credential for a
variable the code no longer reads wastes an afternoon in someone else's console.

```bash
grep -rn "GOOGLE_OAUTH_CLIENT_IDS" backend/src backend/.env.example
jq '.expo.ios, .expo.android, .expo.scheme' frontend/app.json
```

### 1b. Do the vendor's docs still match the ticket?

**Console UIs change and the ticket may be a year old.** Before you tell him to
click something, confirm the path exists *today* with WebSearch/WebFetch against
the vendor's own documentation — Google Cloud Console, Apple Developer, Gumroad,
Railway, Expo/EAS. Prefer the vendor's docs over blog posts and over your own
memory.

Report what you checked, with URLs. When the ticket and the live docs disagree,
say so plainly and follow the docs — then note it on the ticket at close-out.

**If you cannot verify a step, say "I could not confirm this path" rather than
inventing a menu item.** A wrong click path in a billing or credentials console
is worse than an admission.

## Phase 2 — show the map, then start

Give him, in one short message:

- **What this unlocks** in one sentence (why bother).
- **The blocks**, numbered, each with a rough time and what account it needs.
- **What he'll need open** — which accounts, any card, any device.
- **Where it can't be undone**, if anywhere. Publishing an OAuth consent screen,
  taking a product live, rotating a token other things use: flag these *before*
  he starts, not in the block.
- **Anything genuinely blocked** on a decision only he can make (naming a bundle
  ID, choosing a price). Ask those now, not mid-flow.

Then start block 1. Do not wait for permission to begin.

## Phase 3 — the block format

Each block is one message, in this shape:

> **Block 3 of 6 — Create the Google Web client ID** *(~5 min, Google Cloud Console)*
>
> **Why:** this is the only client ID the web app needs, and web ships without a
> store build — so this is the fastest path to a visible working button.
>
> **Do this:**
> 1. Go to https://console.cloud.google.com/apis/credentials (project selector
>    top-left — make sure it says `adepthood`).
> 2. **+ Create credentials** → **OAuth client ID**.
> 3. Application type: **Web application**.
> 4. Authorised JavaScript origins → **+ Add URI** → `https://<your-railway-domain>`
> 5. Authorised redirect URIs → **+ Add URI** → `https://<your-railway-domain>`
> 6. **Create**. A dialog shows the client ID and client secret.
>
> **Do NOT paste me the client secret.** You do not need it for this flow and I
> will not ask for it at any point.
>
> **Gate — paste this back:**
> ```
> the Client ID only (it ends in .apps.googleusercontent.com)
> ```
> It is a public identifier that already ships inside the web bundle, so it is
> safe here. If you would rather not, paste just the last 12 characters and I
> will work with that.

### Writing good instructions

- **Name the exact UI label in bold**, as it appears on screen today.
- **Deep-link where a deep link exists.** `console.cloud.google.com/apis/credentials`
  beats "navigate to APIs & Services then Credentials".
- **Say which account/project/org**, every time. Wrong-project is the single most
  common way these go sideways.
- Prefer a **terminal command** to a click whenever the vendor has a CLI
  (`railway variables`, `eas env:list`, `gh secret set`). Commands are
  copy-pasteable, verifiable, and produce a gate for free.
- If a step takes minutes to propagate (DNS, store builds, consent screen
  review), **say so** and make the gate check the effect rather than the click.

## Gate safety — the part that matters most

**Never ask him to paste:**

- client secrets, API tokens, private keys, `.p8` / `.pem` / keystore files
- webhook signing secrets, session cookies, bearer tokens, recovery codes
- passwords, 2FA codes, or anything from a password manager
- full customer records, real email addresses, or anything identifying a user
- screenshots of a console page that also shows any of the above
- the *value* of any variable named `*_SECRET`, `*_TOKEN`, `*_KEY`, `*_PASSWORD`

**Prefer gates that prove the effect without revealing the value.** In order of
preference:

1. **A command that checks presence, not content.**
   ```bash
   railway variables --json | jq 'keys'          # names only
   [ -n "$GUMROAD_API_TOKEN" ] && echo SET || echo UNSET
   echo -n "$SECRET" | wc -c                     # length, not value
   ```
2. **An external observation of the effect.**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://<api>/health
   gh api repos/Geoffe-Ga/adepthood/actions/secrets --jq '.secrets[].name'
   ```
3. **A public identifier** — an OAuth client ID, a bundle ID, a product
   permalink. These already ship in client bundles; they are safe.
4. **A quoted UI string** — "paste the green banner text" — when nothing else
   is available.

If the only possible proof is sensitive, **redesign the gate**: ask for a
derived fact (length, prefix, last 4, exit code, HTTP status). If even that is
not possible, say "I can't verify this one without a secret, so I'm trusting
you — tell me it's done" and mark it *unverified* at close-out. Be honest that
it is weaker.

**If he pastes a secret anyway:** tell him immediately, in the next message,
that it appeared in the transcript and should be rotated. Do not quietly
continue. Do not repeat the value back.

## Phase 4 — clearing a gate

- **Passed:** say what the evidence proves in one line, then go straight to the
  next block. No ceremony.
- **Failed or ambiguous:** do not advance. Say exactly what you expected versus
  what you saw, give the single most likely cause, and give one corrective
  action. Never say "try again".
- **Unexpected output:** treat it as information about the world, not as him
  making a mistake. Vendor UIs change; your instruction may be the wrong thing.
  Re-check the docs before blaming the paste.

If he goes quiet mid-walkthrough and comes back later, re-establish state from
the last cleared gate before continuing — do not assume the intervening blocks
happened.

## Phase 5 — close out

When every block is cleared:

1. **Tick the ticket's acceptance criteria** that are genuinely met, and say
   plainly which are not. Never tick one you did not verify.
2. **Comment on the ticket** with: what was provisioned, which values live where
   (names only — never values), anything that diverged from the ticket, and
   anything left undone with why.
3. **Correct the ticket body** where the live docs contradicted it, so the next
   person is not misled — same discipline as any stale premise here.
4. **Close it** only if every AC is met. Otherwise leave it open with a comment
   saying exactly what remains, and file a follow-up for anything new you found.
5. **Say what changed for the product** in one line — "social sign-in is now
   live on web; iOS needs a fresh EAS build" — so he knows what to go look at.

## When to stop and ask

- A step **costs money** or changes a plan tier.
- A step is **irreversible and unverifiable** beforehand (publishing a consent
  screen, taking a product live, rotating a token other systems use).
- The ticket's premise turns out to be **false** — stop, report, and offer to
  correct the ticket rather than improvising a path it never specified.
- Anything touching **a real customer's data**.
