# Adepthood full-stack QA runbook

> **Scope:** Adepthood web/mobile UI, FastAPI backend, Journal, Creek Vault `/v1`
> integration, corpus classification, and the True Self/Voice Draft essay pipeline.
>
> **Audience:** a QA engineer performing a release-grade manual and exploratory
> pass against a local, production-shaped stack.
>
> **Last reconciled with:** Adepthood `48e9d9f9` and
> `frontend/e2e/journeys.json` on 2026-09-11. Record the exact Adepthood and Creek
> SHAs used for every run; do not assume this revision remains current.

This is a repeatable checklist, not a substitute for the automated suites. Its
purpose is to make the seams, visual quality, privacy promises, and hostile edge
cases observable to a human. The journey ledger remains the machine-audited
inventory of critical frontend-to-database paths; this runbook adds the states a
user can see, the ways a real browser can misbehave, and the two-service
behaviour that an isolated suite can accidentally assume.

## 1. Release standard and governing principles

A run passes only when all of the following are true:

- [ ] Every applicable checklist item has a recorded result: pass, fail, or
      blocked with a concrete reason. Nothing is silently skipped.
- [ ] The Journal works as a complete product with every optional depth disabled.
- [ ] Habits, Practice, Course, and Sangha are optional, reachable when enabled,
      and removable without shame, loss, or a navigation dead end.
- [ ] No interaction pressures the user with streak shame, urgency, guilt,
      artificial scarcity, or a mandatory progression ladder.
- [ ] Intimate content never crosses an Adepthood-to-Creek or cloud-model boundary.
- [ ] Public and Personal content sent to Creek is classified into the shared
      Frequency/Wavelength ontology when classification is requested. An HTTP
      success with `complete: false`, an unchanged fragment, missing tags, or an
      all-zero wheel caused by unclassified content is a failure, not a pass.
- [ ] A True Self essay is grounded in the writer's own eligible corpus, does not
      quote or imply access to another account, and is never generated for an
      Intimate entry.
- [ ] Destructive actions are explicit, scoped, and irreversible only after clear
      confirmation; transient failures never masquerade as success.
- [ ] Keyboard, pointer, touch, screen reader, narrow viewport, wide viewport,
      light theme, dark theme, refresh, back/forward navigation, and interrupted
      requests have been sampled across every major feature.
- [ ] Every defect has reproducible evidence and is filed once, in the repository
      that owns the faulty behaviour.

Read before testing:

- `NORTH-STAR.md`
- `frontend/src/design/DESIGN.md`
- `docs/creek-vault-mcp-contract.md`
- `docs/your-data.md`
- `frontend/e2e/journeys.json`
- Creek Vault's root `CLAUDE.md`, package `creek-tools/CLAUDE.md`,
  `creek-tools/docs/api.md`, and
  `docs/decisions/2026-07-31-adepthood-http-application-api.md` at the exact Creek
  SHA under test

## 2. Test record

Copy this block into a dated run record before starting.

```text
Run ID:
Tester:
Started / finished (time zone):
Adepthood SHA / branch:
Creek SHA / branch:
Browser + version:
Viewport(s) / DPR:
OS / device:
Frontend URL:
Backend URL:
Creek URL:
Postgres version / database:
LLM provider + model (do not record keys):
Build mode and feature flags:
Network profiles exercised:
Accounts / fixture personas:
Automated gate results:
Browser console log location:
Backend log location:
Creek log location:
Screenshots / video location:
Issues filed:
Blocked items and reason:
Final verdict: PASS / FAIL / BLOCKED
```

Never put passwords, licence keys, bearer tokens, provider keys, recovery codes,
raw journal prose, imported document content, or database connection credentials
in a run record, screenshot, console export, issue, or CI artifact.

## 3. Environment and data matrix

### 3.1 Required stack

- [ ] Use isolated current-main worktrees for both repositories.
- [ ] Record exact SHAs before installing, migrating, or starting services.
- [ ] Confirm both worktrees are clean; do not reuse a developer's dirty tree.
- [ ] Use the repository virtual environments and locked frontend dependencies.
- [ ] Start a disposable PostgreSQL 16 database and run every Alembic migration.
- [ ] Start Creek Vault from its checked-out source with a disposable vault root.
- [ ] Configure a real local classification/reflection model supported by Creek.
- [ ] Mint a run-specific Creek consumer token and keep it out of shell history and
      captured output.
- [ ] Start Adepthood with its real HTTP Creek client pointed to that Creek process.
- [ ] Start the FastAPI backend and wait for its health/readiness response.
- [ ] Start the Expo web frontend and load it in the controlled browser.
- [ ] Preserve service logs with timestamps and correlation/request IDs, but no
      journal bodies or credentials.
- [ ] At teardown, stop only the PIDs created for this run and remove only the
      explicitly named disposable database, vault, and credential directory.

Repository setup commands are authoritative. At the time of this revision the
usual Adepthood entry points are:

```bash
bash scripts/dev-setup.sh
cd backend && PYTHONPATH=src python -m uvicorn main:app --reload
cd frontend && npm run web -- --port 3000
```

Do not copy a guessed Creek command from this document. Use Creek's current CLI
help and HTTP API documentation at the checked-out SHA, then record the exact
command in the run record. Verify `GET /v1/capabilities` before opening the app.

### 3.2 Browser and viewport matrix

Run the complete critical path at the primary desktop and phone widths. Sample
all other rows, concentrating on screens with dense controls or modals.

| Profile         | Suggested viewport | What it is meant to expose                   |
| --------------- | -----------------: | -------------------------------------------- |
| Small phone     |          320 × 568 | wrapping, occlusion, minimum touch targets   |
| Current phone   |          390 × 844 | primary touch experience and safe areas      |
| Large phone     |          430 × 932 | modal/card centring and excessive whitespace |
| Tablet portrait |         768 × 1024 | intermediate breakpoints and line length     |
| Desktop narrow  |         1024 × 768 | side drawers and keyboard interaction        |
| Desktop wide    |         1440 × 900 | max-width, hierarchy, and empty space        |
| Zoomed desktop  | 1280 × 800 at 200% | reflow, truncation, fixed positioning        |

For each applicable profile:

- [ ] Test light and dark appearance if the platform exposes both.
- [ ] Test keyboard-only traversal, reverse traversal, Enter/Space activation,
      Escape dismissal, and visible focus.
- [ ] Inspect at 100%, 200%, and one non-round browser zoom value such as 125%.
- [ ] Test reduced motion and increased text/font scaling where available.
- [ ] Confirm browser back, forward, refresh, and direct/deep-link entry do not lose
      or duplicate data.
- [ ] Confirm the bottom tab bar, headers, drawers, keyboards, and safe-area insets
      never cover actionable content.

### 3.3 Native iOS and Android matrix

The web pass is not a proxy for React Native. Run at least one current iOS and
one current Android build from the same SHA. Use a development build for
iteration, then repeat the release-critical path in a release-signed build;
Expo Go is insufficient wherever native configuration, entitlements, the custom
scheme, secure storage, camera, sharing, audio, or haptics are under test.

Record the exact Xcode, Android SDK/Gradle, Expo/EAS, OS, simulator/emulator, and
physical-device versions used. Never point a native build on a physical device
at `127.0.0.1`; configure the explicitly approved LAN or tunneled development
origin and verify Adepthood's environment/transport policy deliberately.

| Native profile                    | Minimum pass                                          | Platform-specific seams                                                          |
| --------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| iOS phone simulator               | current supported iOS, small and current screen sizes | safe area, software keyboard, custom scheme, status bar                          |
| iOS physical phone                | current supported iOS                                 | camera/photo permissions, SecureStore, Apple sign-in, share sheet, audio/haptics |
| iPad simulator or physical tablet | portrait, split-view restrictions recorded            | tablet layout, popovers, keyboard, large text                                    |
| Android phone emulator            | current API and oldest supported API                  | system Back, IME, process recreation, adaptive icon                              |
| Android physical phone            | current supported Android                             | camera/photo permissions, Keystore, share sheet, audio/haptics, app links        |

- [ ] `npm run ios` and `npm run android` (or the repository's current documented
      native commands) build from a clean lockfile with no red-box error or
      native-module/version warning.
- [ ] Release builds install, launch from a cold process, show the intended splash
      and icon, and reach authentication without a Metro connection.
- [ ] Bundle identifier/package name, version/build numbers, app name, adaptive
      icon, splash, portrait policy, and privacy permission strings match
      `frontend/app.json` and the release artifact.
- [ ] iOS status bar, home-indicator safe area, notch/Dynamic Island, Android
      status/navigation bars, display cutouts, and edge-to-edge layouts never
      cover controls or text.
- [ ] Small/large devices, iPad/tablet, maximum supported Dynamic Type/font scale,
      bold text, display zoom, and Android display/font scaling remain operable.
- [ ] Hardware/software keyboard show, hide, next/previous, submit, autocorrect,
      password manager, autofill, dictation, selection, and IME composition do
      not obscure fields or corrupt Journal text.
- [ ] Android system Back dismisses keyboard → modal/drawer → child screen in that
      order and never exits or loses an edit unexpectedly. iOS swipe-back and
      interactive cancellation preserve the same state.
- [ ] Background, foreground, screen lock, process suspension, OS process kill,
      memory-pressure recreation, app upgrade, and device reboot preserve only
      the state promised by the product and never duplicate a mutation.
- [ ] SecureStore/Keychain/Keystore retains auth and BYOK material when intended,
      never falls back to plaintext, purges on account switch/logout as specified,
      and handles a locked/inaccessible store without a crash.
- [ ] `adepthood://reset-password?...`, practice-share links, Settings/API-key
      links, cold-start links, warm links, malformed tokens, encoded path
      segments, and links opened while logged out resolve to the correct stack
      without exposing tokens in visible copy.
- [ ] Apple sign-in appears only where supported and completes/cancels/errors on
      iOS; Google auth uses the correct per-platform client ID and survives
      provider-app/browser cancellation on both platforms.
- [ ] Camera and photo-library prompts use the configured human-readable purpose
      strings. Allow once, allow, limited library, deny, deny permanently, and
      revoke-in-Settings states each offer a truthful recovery path.
- [ ] Native document picker imports local, iCloud/Files, and Android content-
      provider documents; cancelled, slow-cloud, unavailable, permission-lost,
      zero-byte, and provider-returned URI cases do not crash or lose progress.
- [ ] Native export and recovery-key save invoke the system share sheet, handle
      cancel/no-target/failure, leave a readable file only where promised, and do
      not leak plaintext into logs, previews, recent-item thumbnails, or another
      account's flow.
- [ ] Practice bells/audio work with the silent switch and expected audio route;
      headphones, Bluetooth changes, phone call/audio interruption, background,
      and volume changes have a clear visual equivalent and do not corrupt timing.
- [ ] Haptics occur once at intended cues, degrade silently when unavailable or
      disabled, and never replace the visible completion signal.
- [ ] Notification permission is requested only from the user-visible feature
      that needs it. Allow/deny/revoke and tapped-notification cold/warm launches
      reach the right account and destination without stale content.
- [ ] External Gumroad, provider-key, Sangha, legal, and support links open only
      approved HTTPS destinations; cancel/no-handler paths leave Adepthood usable.
- [ ] Airplane mode, Wi-Fi↔cellular handoff, captive portal, flaky radio, and OS
      low-data/battery restrictions produce the same honest offline/retry and
      idempotency semantics as the browser pass.
- [ ] Accessibility Inspector/TalkBack finds correct labels, roles, values,
      headings, rotor/order, focus restoration, custom-action alternatives, and
      touch targets. VoiceOver/TalkBack can complete the Journal critical path.
- [ ] Capture native screenshots of every primary screen and modal at the small
      phone and tablet widths; compare typography, wrapping, shadows, icon
      alignment, keyboard avoidance, and scroll endpoints with Candle & Ink.
- [ ] TestFlight/internal-track install and upgrade preserve migrations/device
      state; a clean uninstall/reinstall has the platform-documented credential
      outcome and never resurrects another account's cached prose.
- [ ] Review the iOS privacy manifest/permission declarations and Android manifest
      permissions emitted by the release build. Nothing undeclared is used and no
      unused sensitive permission is shipped.

### 3.4 Fixture personas

Use unique accounts and unique licence claims. Do not repurpose one account for
contradictory states.

1. **Fresh journal-only user:** no entries, no optional rings, no vault, no BYOK.
2. **Journal + connected vault user:** Public/Personal corpus, classification and
   reflection enabled, several entries spread across dates and Frequencies.
3. **Privacy user:** Public, Personal, and Intimate entries with unique canary text.
4. **Full-depth user:** all rings enabled, stages/progress, habits, practices,
   course reading, prompts, and invitations.
5. **Long-history user:** at least 100 journal entries, 30 habits, 30 practices,
   multiple pages of every paginated collection, long titles, and Unicode.
6. **Offline/recovery user:** valid cached session and queued local actions.
7. **Empty/spent wallet user:** no included credits and no BYOK key.
8. **BYOK user:** one valid provider key, one invalid key, one billing-exhausted key.
9. **Second tenant:** distinct corpus containing an unmistakable cross-tenant canary.
10. **Deletion/export user:** a row in every user-owned data family and a connected
    vault whose independent deletion semantics can be observed.

### 3.5 Adversarial input corpus

Prepare non-sensitive synthetic fixtures:

- Empty, whitespace-only, one-character, and maximum-length values.
- A 100,000-character journal body and documents at, just below, and just above the
  advertised size limit.
- Very long unbroken tokens, URLs, emoji sequences, combining characters, RTL/LTR
  mixtures, CJK, accents, curly quotes, tabs, CRLF, and trailing newlines.
- Markdown headings, lists, blockquotes, emphasis, code, links, raw HTML, malformed
  markdown, and text that resembles script or SQL injection.
- Duplicate filenames, no extension, misleading extension/MIME pairs, uppercase
  extensions, zero-byte files, binary files, corrupt files, and password-protected
  archives/PDFs if the importer claims to support them.
- Two documents with identical bytes, two with identical names but different bytes,
  and repeated import of the same external identifier.
- Synthetic passages designed to classify clearly into F1, F4, F8/True Self, and
  F10, plus ambiguous and multi-frequency passages.
- Unique privacy canaries for Public, Personal, Intimate, and the second tenant.

## 4. Evidence and defect protocol

For every checklist failure:

1. Stop and reproduce from a known state at least twice unless the first occurrence
   caused data loss, privacy exposure, or an unrecoverable crash.
2. Capture the exact SHAs, viewport, browser, preconditions, steps, expected result,
   actual result, timestamps, request method/path/status, and sanitized log excerpts.
3. Determine the owning boundary:
   - file in `Geoffe-Ga/adepthood` when Adepthood renders, validates, persists,
     routes, retries, times out, or interprets a valid Creek response incorrectly;
   - file in `Geoffe-Ga/Creek-Vault` when Creek advertises or implements the wrong
     `/v1` contract, loses/misclassifies corpus, violates ceilings, or produces an
     invalid response;
   - cross-link two issues only when each repository needs an independently shippable
     change. Do not duplicate one root cause in both repositories.
4. Search open and closed issues by symptom, route, component, and error before filing.
5. Apply `bug`, the owning area (`frontend`, `backend`, `testing`, or the repository's
   current equivalent), the appropriate epic label if one exists, and exactly one
   priority label:
   - **P0:** active privacy/security breach, cross-tenant exposure, data destruction,
     unrecoverable corruption, or release-wide outage;
   - **P1:** a critical intended journey is broken with no reasonable workaround,
     classification/True Self silently gives materially false results, or persistent
     data diverges between services;
   - **P2:** a meaningful but bounded functional, accessibility, reliability, or
     visual defect with a workaround;
   - **P3:** minor polish or low-impact inconsistency. P3 findings are recorded but
     are outside the requested backlog drain.
6. Add `agent-ready` only when the issue has exact acceptance criteria, reproducible
   evidence, and no unresolved product/design decision. Use `needs-spec`, `blocked`,
   or the current repository equivalent honestly when it does not.

Issue body template:

```markdown
## Summary

## Environment

- Adepthood SHA:
- Creek SHA:
- Browser / viewport:

## Preconditions

## Steps to reproduce

1.

## Expected

## Actual

## Evidence

- Sanitized request/status/timestamp:
- Screenshot/video/log:

## Impact and priority rationale

## Acceptance criteria

- [ ]
- [ ] Regression test fails before the fix and passes after it.
- [ ] Relevant journey is registered or updated.
- [ ] No privacy tier, cross-tenant, retry, or offline regression.
```

## 5. Global shell, navigation, and visual quality

Run these checks on every screen, sheet, modal, drawer, card, loading state, empty
state, error state, and destructive confirmation encountered later.

### 5.1 Navigation and state

- [ ] The authenticated app opens on Journal, not an optional ring.
- [ ] Journal and Map remain reachable; Habits, Practice, and Course appear only when
      their depth switches are enabled.
- [ ] Disabling the currently focused ring returns to Journal without a blank screen.
- [ ] Tab order, drawer destination order, titles, icons, selected state, and browser
      history agree.
- [ ] The settings gear remains reachable at all supported sizes.
- [ ] Every back/close/cancel control returns to the originating context exactly once.
- [ ] Rapid double-click/tap does not push duplicate routes or submit twice.
- [ ] Refreshing every route produces a valid screen or intentional redirect.
- [ ] A stale deep link, missing ID, deleted ID, and another user's ID produce safe,
      comprehensible states without leaking existence or content.
- [ ] Switching accounts purges cached entries, habits, course state, wallet state,
      prompts, vault status, and offline queues before the next account renders.

### 5.2 Pixel and content inspection

- [ ] Candle & Ink colours, editorial serif hierarchy, spacing rhythm, borders,
      shadows, and icon weights match the design tokens rather than one-off values.
- [ ] No text clips, overlaps, jumps after loading, or extends beyond its card.
- [ ] Long titles and translated/Unicode-like strings truncate or wrap intentionally.
- [ ] Buttons have stable size between idle, loading, success, and failure labels.
- [ ] Spinners and progress indicators are aligned, labelled, and cannot remain forever.
- [ ] Empty space feels intentional at both narrow and wide breakpoints.
- [ ] Scroll containers reach their final control with keyboard open and closed.
- [ ] Drawers and modals centre correctly, trap focus where appropriate, dim the
      underlying surface, and restore focus on dismissal.
- [ ] Scrims dismiss only where intended; clicking inside never dismisses.
- [ ] No raw enum, stack trace, `undefined`, `[object Object]`, test ID, internal ID,
      or infrastructure vocabulary is user-visible.
- [ ] Dates, times, durations, counts, singular/plural copy, and time zones are correct.

### 5.3 Accessibility

- [ ] Every actionable element has a name, role, state, and at least a 44×44 target.
- [ ] Headings form a meaningful order; decorative icons/images are hidden.
- [ ] Inputs have persistent labels, helpful errors, correct autocomplete/input modes,
      and errors associated with the field.
- [ ] Colour is never the only carrier of locked, completed, selected, destructive,
      error, or privacy state.
- [ ] Screen-reader reading order matches visual order and excludes hidden layers.
- [ ] Dynamic loading, saves, failures, and completion states are announced without
      stealing focus.
- [ ] Contrast remains adequate in normal, pressed, disabled, selected, and dark states.
- [ ] Timers, audio cues, motion, and haptics have equivalent visible/non-audio meaning.

### 5.4 Request and recovery behaviour

- [ ] Slow every request class; the UI shows progress without allowing unsafe repeats.
- [ ] Drop the connection before send, after send/before response, and during polling.
- [ ] Retry after 401, 403, 404, 409, 422, 429, 500, 502/503, timeout, malformed JSON,
      schema-valid negative outcomes, and unexpected content type where reachable.
- [ ] A server fault is not labelled offline, and an offline state is not labelled a
      server fault.
- [ ] A late response cannot update an unmounted screen or the wrong record.
- [ ] Refresh-token rotation survives concurrent requests and rejects the rotated-away
      token immediately.
- [ ] Optimistic UI rolls back or clearly marks unsynced work; it never lies that a
      failed mutation was saved.
- [ ] Retrying idempotent operations does not duplicate rows, charges, sessions,
      fragments, marginalia, essays, invitations, or imports.

## 6. Authentication, account recovery, and first run

### 6.1 Get started, signup, and login

- [ ] Inspect Get Started at every viewport; Login and Sign up are distinct and clear.
- [ ] Sign up with a valid unique email, strong valid password, matching confirmation,
      and valid giftable licence claim; confirm one account is created and authenticated.
- [ ] Present the same licence under another email; receive the generic refusal with no
      disclosure that the claim is valid or who owns it.
- [ ] Exercise missing, malformed, expired, revoked, and network-failed licence states.
- [ ] Exercise empty, whitespace, mixed-case, leading/trailing-space, Unicode, malformed,
      duplicate, and maximum-length email inputs.
- [ ] Exercise weak, too-long, mismatched, pasted, manager-autofilled, and Unicode
      passwords. Password text remains masked and is never logged.
- [ ] Submit with Enter and with the button; rapid repeat creates at most one account.
- [ ] Login succeeds with valid credentials and fails generically for unknown email,
      wrong password, deleted account, and malformed request.
- [ ] Repeated failures are rate limited without allowing account enumeration.
- [ ] Google and Apple sign-in succeed when configured; cancel, provider denial,
      invalid token, existing-email collision, and popup-blocked paths recover cleanly.

### 6.2 Session lifecycle

- [ ] Login persists across refresh/restart for the documented sliding lifetime.
- [ ] Half-life refresh rotates the token and concurrent requests converge on one valid
      session rather than forcing logout.
- [ ] Logout clears every account-specific device store and returns to auth.
- [ ] Browser back after logout cannot reveal cached authenticated screens.
- [ ] Expiry during editing preserves unsaved text locally and offers a safe re-login.
- [ ] The same account on two sessions behaves consistently; deleting the account kills
      both on their next request.

### 6.3 Password recovery

- [ ] Forgot Password gives the same 202-style response for known and unknown emails.
- [ ] The real captured email contains a browser-openable HTTPS link and no token leaks
      to responses or ordinary logs.
- [ ] Valid reset updates the password once; old password and replayed token fail.
- [ ] Expired, malformed, already-used, and cancelled tokens fail safely.
- [ ] “This wasn't me” cancels the token, including when opened in another browser.
- [ ] Two reset requests have clear newest/older-token semantics.
- [ ] Network loss and double-submit do not produce ambiguous password state.

### 6.4 Welcome walkthrough

- [ ] A fresh account sees each intended page in order, with accurate progress.
- [ ] Next, back, swipe, keyboard, Skip, and Begin work; Skip never shames.
- [ ] Begin and Skip both arrive at an empty Journal ready to write.
- [ ] Dismissal persists across refresh and devices according to the server/local-source
      contract; clearing only one store does not create a loop.

## 7. Journal and writing floor

### 7.1 Shelf, drawer, search, and pagination

- [ ] Fresh shelf is honest, empty, and presents New entry without sample data.
- [ ] Entries sort/group by the documented saved timestamp across day, month, year,
      daylight-saving, and time-zone boundaries.
- [ ] Untitled entries have one consistent fallback; long/special titles remain legible.
- [ ] New entry, Morning pages, current prompt, Corpus, and drawer controls are reachable.
- [ ] Opening the drawer loads once, keeps cached rows across close/reopen, highlights the
      current entry, and restores focus/scroll correctly.
- [ ] “Load more” appends exactly one page with no omissions or duplicates; pressing it
      repeatedly while loading is harmless.
- [ ] Title search is immediate and case/Unicode sensible.
- [ ] Body search asks permission before loading older pages, reports progress, retries
      failure, and finds matches beyond the first page without exposing bodies in logs.
- [ ] Selecting a result opens the right entry; back returns to the prior shelf context.
- [ ] Corpus remains in the drawer after its invitation band has been set aside.

### 7.2 Create, autosave, edit, and read

- [ ] Create an untitled empty entry, close it, and verify the intended empty-entry policy.
- [ ] Write title and body; observe save state; close immediately after the last keystroke;
      reopen and verify byte-for-byte text preservation.
- [ ] Title stays single-line under paste, Enter, IME composition, long tokens, and emoji.
- [ ] Body accepts multiline text, selection, undo/redo, cut/copy/paste, IME, emoji, RTL,
      very long content, and markdown without cursor jumps.
- [ ] Lightweight markdown renders headings, lists, emphasis, blockquotes, code, links,
      malformed syntax, and raw HTML safely; edit/read transitions preserve source.
- [ ] Autosave debounces but never loses the final edit; rapid edits do not apply an older
      response over a newer one.
- [ ] Refresh/crash/offline during edit has an explicit preservation and reconciliation
      outcome; the same entry is not duplicated.
- [ ] Two tabs/devices editing the same entry have a visible, deterministic conflict rule.
- [ ] Public, Personal, and Intimate selectors persist and are visually/audibly distinct.
- [ ] Changing privacy while a save, reflection, or vault mirror is in flight cannot leak
      text under the previous ceiling.
- [ ] Read/list/get never returns another tenant's entry or soft-deleted content.

### 7.3 Delete

- [ ] Delete requires a clear confirmation naming the page-level consequence.
- [ ] Cancel is lossless; confirm removes the entry from shelf, drawer, direct read,
      searches, grounding, promotions, voice drafts, and the Creek corpus mirror.
- [ ] Double-confirm, timeout, and a response lost after commit remain idempotent.
- [ ] There is no misleading restore promise; export-before-delete guidance agrees with
      `docs/your-data.md`.
- [ ] Deleting one page touches no other entry or account data.

### 7.4 Morning pages, prompts, and reflection cadence

- [ ] Ordinary New entry remains untitled; Morning pages prefills the local calendar date
      in the documented title form and never produces tomorrow/yesterday at boundaries.
- [ ] The stage/week prompt matches the program calendar, including future/unconfirmed,
      looped, and time-zone states.
- [ ] Multiple prompts for a week are selectable and attributed to the right ordinal.
- [ ] Set a prompt aside; it stays quiet, can be restored from history, and never nags.
- [ ] Prompt history paginates, labels cadence correctly, and opens the expected writing
      context.
- [ ] Weekly, stage, cycle, and contraction reflection invitations appear only when due,
      are one-tap declinable, resume safely, and do not repeat after dismissal/completion.
- [ ] Beginning a reflection, abandoning it, and returning cannot consume or duplicate the
      invitation incorrectly.

### 7.5 Photograph a page

- [ ] Camera permission allow, deny, deny-permanently, and later-enable paths explain what
      the user can do next.
- [ ] Capture/retake/retry/remove works for portrait, landscape, rotated, blurry, dark,
      multi-block, blank, handwriting, and unsupported images.
- [ ] Image pixels are not persisted or transmitted beyond the documented local boundary.
- [ ] Transcription blocks preserve order and allow editing/removing before save.
- [ ] “Type it instead” opens an Intimate entry when required and carries no image bytes.
- [ ] Appending to an existing entry uses the correct hand-off token; a late transcript
      cannot land in a different or newly opened page.
- [ ] Offline, timeout, corrupt response, and navigation-away states do not lose the page
      already being written or create a phantom entry.

### 7.6 Timed writing and cross-feature offers

- [ ] Quick-launching a saved Journaling practice opens the right entry with timer running.
- [ ] Pause/resume/finish/dismiss/reopen/background/clock-change paths keep one coherent
      duration and at most one session row.
- [ ] A completed timed page can become a habit and/or practice through a gentle optional
      offer; decline is one tap and remains respected.
- [ ] Short entries still receive an eligible habit check-off offer.
- [ ] Successful check-off changes the correct habit; a failed check-off says so beside
      the card and does not show a false completion.
- [ ] A contraction/Return offer opens the correct recovery flow and remains non-coercive.

## 8. Creek corpus ingestion and classification

This section is release-critical. Run it against a real Creek process and real
local provider, not only the fake Creek used by Adepthood's automated E2E lane.

### 8.1 Preflight and contract negotiation

- [ ] Record Creek's exact `contract_version`, `contract_minor`, availability, and
      advertised capability set from `GET /v1/capabilities`.
- [ ] Confirm Adepthood sends authentication and the correct `X-Creek-Tier-Ceiling` on
      every `/v1` call; deliberately omits `X-Creek-Contract-Version` from the
      unversioned `GET /v1/capabilities` negotiation; and sends the negotiated
      major/minor header on every post-handshake capability call. No bearer, request
      content, or response content may reach logs.
- [ ] Test compatible patch/minor, unsupported version, absent capability, unavailable
      vault, invalid bearer, redirect, DNS/connect refusal, TLS failure, and malformed
      capability response.
- [ ] Adepthood never calls a capability Creek did not advertise and never counts a merely
      advertised but unwired capability as exercised.
- [ ] Telemetry distinguishes success, refusal, timeout, unavailable, schema failure, and
      other failure without recording corpus content.

### 8.2 Journal-created document path

Use a new Public entry and a new Personal entry, each with a unique canary and a
clear expected Frequency. Observe Adepthood, Creek HTTP, Creek's durable job, and
the persisted vault fragment.

- [ ] Saving commits the Adepthood journal row before or atomically with an eligible mirror;
      a failed mirror never loses the local page.
- [ ] Exactly one stable external/source identity is used across autosaves; editing updates
      rather than duplicates the Creek fragment.
- [ ] The stored Creek fragment preserves eligible text and source metadata without
      Adepthood-only secrets or another user's data.
- [ ] Semantic classification is actually invoked and its durable job is polled to a
      terminal state beyond the ordinary HTTP deadline when necessary.
- [ ] Terminal success means the fragment has a valid F1–F10 tag, method/provenance,
      confidence/metadata promised by Creek, and the expected tier. Inspect persisted
      frontmatter; do not infer success from HTTP 2xx or a completed poll alone.
- [ ] `complete: false`, unchanged tags after all retries, internal provider timeout,
      partial counts, or a terminal job with per-fragment failure is shown/telemetried as
      incomplete and is recoverable. It must not be counted as a successful classification.
- [ ] Temporal linking runs only after the required classification outcome and produces no
      duplicate or self-links on retry.
- [ ] Re-editing into a different obvious Frequency updates classification deliberately;
      a stale F-tag cannot silently survive if the contract says reclassification occurs.
- [ ] Changing Public↔Personal preserves the ceiling and classification. Changing to
      Intimate withdraws the mirrored fragment and prevents every future Creek/model call.
- [ ] Deleting the page withdraws the exact fragment and removes it from wheel, retrieval,
      reflections, and voice drafts after convergence.

### 8.3 Bulk import path

Run one supported document at a time, then a mixed multi-file batch if the UI permits.

- [ ] File chooser, drag/drop, cancel, repeated selection, and keyboard activation work.
- [ ] Supported formats are accurately advertised; content and MIME validation agree.
- [ ] Unsupported, corrupt, empty, too-large, encrypted, and misleading-extension files are
      refused individually with actionable copy and without blocking valid siblings.
- [ ] Filename, size, privacy tier, progress, success, failure, and retry belong to the
      correct row under concurrent uploads.
- [ ] Personal import reaches Creek exactly once under the Personal ceiling; Intimate import
      makes zero Creek requests and stores no fragment/digest there.
- [ ] The upload response's `vault_ref`, status, and tags correspond to the persisted Creek
      fragment rather than an optimistic placeholder.
- [ ] The same semantic classification and terminal-proof checks from section 8.2 pass.
- [ ] Two same-name files remain distinct; identical-byte and repeated external-ID behaviour
      matches the documented idempotency contract.
- [ ] Network loss before upload, mid-body, after commit, and during classification can be
      retried without duplicate fragments or misleading success.
- [ ] Leaving while import is in flight has an explicit outcome and does not strand a job
      forever or apply its result to a later import.
- [ ] A mixed batch reports partial success honestly and allows retry of only failed items.

### 8.4 Classification quality and consistency

- [ ] Run the synthetic F1, F4, F8/True Self, F10, ambiguous, and multi-frequency fixtures.
- [ ] Classification is deterministic enough for the documented tolerance; uncertain input
      is represented as uncertainty rather than invented confidence.
- [ ] Journal and bulk-import copies of identical prose receive compatible ontology tags.
- [ ] Unicode, markdown, long text, headings-only, and whitespace-normalized variants do not
      crash or flip classification for irrelevant formatting.
- [ ] A young corpus with eligible unclassified fragments does not appear as an honestly
      empty/all-zero wheel.
- [ ] Wheel counts and shares reconcile with persisted eligible fragments, total classified,
      unclassified, deletion, tier ceiling, and retries.
- [ ] The F1–F10 colour identity maps to Adepthood's stage/aspect labels; Creek's divergent
      middle labels never leak directly into the Adepthood UI.
- [ ] Classification cannot read the second tenant's fragment or the Intimate canary.

## 9. Resonance, marginalia, True Self, and Voice Draft essays

### 9.1 Resonance request and wallet

- [ ] An eligible saved entry offers “Get resonance” only at the intended time/state.
- [ ] First use explains exactly what the reflection does, what corpus it may read, which
      provider/key pays, and what it costs before any charge.
- [ ] Cancel/decline makes no provider call and no wallet change.
- [ ] Successful request deducts exactly once and returns the refreshed balance.
- [ ] Empty wallet offers a working refill/BYOK path; it does not loop or hide the entry.
- [ ] Provider billing exhaustion is distinguished from transient outage; any deducted
      balance is refunded exactly once and a retry can succeed.
- [ ] Timeout, refusal, malformed response, care interception, rapid repeat, refresh, and
      navigation-away preserve idempotency and accurate wallet audit.

### 9.2 Privacy and grounding

- [ ] Public and Personal requests carry their exact ceiling.
- [ ] An Intimate entry never dials Creek or a cloud/local model for resonance or essay,
      even if it contains a provider-probe marker or changes tier during the request.
- [ ] Grounding excludes the current entry itself and all Intimate content.
- [ ] With eligible corpus, grounding uses the best relevant fragments and records corpus as
      its source. With an honestly empty corpus, it falls back to recent eligible entries.
- [ ] The current Wavelength/Stage bias is applied by shared Frequency identity, not by a
      mismatched label join.
- [ ] Second-tenant canary text never appears in prompts, notes, essays, logs, or responses.
- [ ] Care/crisis language triggers reviewed human/professional support and does not leave
      the writer alone with only model text. Medication copy never advises stopping care.

### 9.3 Marginalia

- [ ] Notes anchor to the exact quoted span, including duplicate quotes, Unicode, edits,
      markdown, and long entries.
- [ ] Creek kinds map only to Adepthood's supported theme/connection/symbol vocabulary;
      unknown kinds are dropped safely rather than stored as invalid rows.
- [ ] Reopening an entry preserves notes and anchors; editing re-anchors eligible notes and
      marks/removes stale ones intentionally.
- [ ] Tap/click, keyboard activation, hover/focus, mobile selection, and screen reader all
      expose the note without obscuring the passage.
- [ ] Promoting a quote creates exactly one promotion; reopening and removing it update the
      right row and future grounding.

### 9.4 True Self essay expansion

- [ ] Expanding a margin note opens a letter-like modal over the still-visible dimmed page.
- [ ] The anchor quote and note context are correct; loading, success, empty completion,
      provider refusal, timeout, and retry are visually distinct.
- [ ] A blank or missing essay never renders an empty card; retry performs one new attempt.
- [ ] Closing while loading ignores a late response; reopening the same note shows the
      cached essay or an intentional retry state, never another note's essay.
- [ ] Double-clicking expand produces at most one generation/charge.
- [ ] Generated essay is encrypted in Adepthood storage, paired with its timestamp, and
      never written plaintext to logs.
- [ ] Reopening uses the cached essay without a provider charge or text drift.
- [ ] The essay is grounded in the anchor and eligible writer corpus, speaks as reflection
      rather than authority, avoids diagnostic certainty, and contains no second-tenant or
      Intimate canary.
- [ ] The local Adepthood essay commits before the one-way Creek Voice Draft mirror. A mirror
      failure does not erase the local essay and is observable/retryable as designed.
- [ ] The Creek voice-draft record has stable identity, correct tier/provenance, and one copy
      after retry. Deleting or privacy-withdrawing its source removes/withholds it.
- [ ] Prior essays supplied for anti-repetition produce meaningfully distinct wording without
      inventing facts or abandoning the current source.

### 9.5 Voice Draft shelf and readiness

- [ ] Voice readiness explains where the voice comes from and accurately reflects corpus
      sufficiency; it never implies access to content not consented or classified.
- [ ] Voice Draft listing paginates with no duplicates/omissions, orders predictably, and
      includes only notes whose essays exist.
- [ ] Opening a draft returns the correct cached essay and source context.
- [ ] Empty, loading, partial failure, unavailable vault, and deleted-source states are honest.

## 10. Corpus controls, import, export, and deletion

### 10.1 Corpus invitation and consent

- [ ] First-reflection invitation to build a corpus is gentle, relevant, and one-tap
      declinable; decline persists and does not nag.
- [ ] Corpus remains reachable from the Journal drawer and Settings after decline/dismissal.
- [ ] Each source consent switch starts off according to policy, states what may be sorted,
      and persists across refresh/device session.
- [ ] Revoking consent stops future classification/retrieval and has the documented effect on
      already classified fragments; the UI does not overpromise deletion if it is not done.
- [ ] Consent changes during import/pipeline jobs cannot race into an unauthorized result.

### 10.2 Import without a vault

- [ ] Import remains useful without Creek and reports local fallback honestly.
- [ ] No-vault copy never claims the document is classified, mirrored, or available to a
      feature that depends on Creek.
- [ ] Connecting a vault later has a clear backfill/non-backfill outcome; no silent omission.

### 10.3 Data export

- [ ] Export is reachable in Settings and warns that the resulting archive is plaintext.
- [ ] One action yields the documented JSON archive and readable Markdown journal.
- [ ] Manifest covers all user-owned families and explicitly lists every omission/reason.
- [ ] Export contains decrypted user content, never `enc::v1::` ciphertext markers, secrets,
      password hashes, reset tokens, OAuth credentials, vault keys, or unrelated tenants.
- [ ] Deleted entries are absent; ordering, Unicode, markdown, dates, tags, and tiers survive.
- [ ] Empty account, long-history account, slow generation, sharing cancellation, unavailable
      share sheet, and disk/download failure are usable and honest.
- [ ] Audit row records only allowed metadata, never archive content.

### 10.4 Account deletion

- [ ] Screen states immediate/irreversible consequences and offers export first.
- [ ] Exact-email confirmation handles case/whitespace deliberately and refuses the wrong
      address without disclosing unnecessary data.
- [ ] Cancel preserves all data; confirm is guarded against duplicate submission.
- [ ] Every owned row is deleted/anonymized according to `docs/your-data.md`; the second
      tenant is byte-for-byte unaffected.
- [ ] Session tokens on all devices fail on their next request and browser history/cache does
      not reveal content.
- [ ] Licence binding is released for exactly one new account without transferring content.
- [ ] Purchase receipt and contributed shared practices survive only as documented.
- [ ] A connected/unreachable Creek vault never blocks Adepthood deletion; guidance clearly
      explains that Creek requires its own purge. The app never claims it purged Creek.
- [ ] Failure before commit leaves the account usable; lost response after commit resolves to
      a deleted-account state rather than inviting unsafe repeat.

## 11. Habits and energy scaffolding

### 11.1 First use and creation

- [ ] A successful empty response shows an honest empty state and Add a habit CTA.
- [ ] Demo content appears only in explicitly configured demo mode and is unmistakably local.
- [ ] Create a habit with minimum/maximum/Unicode/duplicate names, icon, goals, units, stage,
      carryover classification, and future/today/past dates.
- [ ] Client-minted/demo IDs never go onto the wire as server row IDs.
- [ ] Added program habits join the program cadence; carryover preserves its real start date.

### 11.2 Energy scaffolding and onboarding

- [ ] Every onboarding step is readable, optional in tone, keyboard/touch usable, and retains
      choices across back/forward.
- [ ] Chosen program start date becomes the universal anchor used by Habits, Map, Practice,
      Course, and Journal.
- [ ] Existing carryover rows do not move the anchor earlier.
- [ ] Re-scaffolding reviews existing habits, preserves user edits/history, and clearly shows
      what will change before save.
- [ ] Partial save/offline/retry does not create duplicate habits or split the program anchor.

### 11.3 Daily use, goals, and stats

- [ ] Check in each goal tier/unit; count, star fill, streak, date, and stats change once.
- [ ] Long-press/alternate interaction for stretch goals is discoverable and accessible.
- [ ] Edit name/icon/start date/goals/units and verify history is preserved intentionally.
- [ ] Undo/reset completions and missed-days flows affect only intended days and time zone.
- [ ] Day rollover while the screen stays mounted updates eligibility and today state without
      refresh.
- [ ] Weekly, streak, and aggregate stats handle no data, one event, many events, DST,
      timezone change, future data, and legacy rows.

### 11.4 Reveal, reorder, and deletion

- [ ] Stage-gated habits reveal once when the program reaches them; start date alone does not
      open every ring on an established account.
- [ ] Re-lock/decline remains respected on later reads.
- [ ] Manual reveal and legacy unnumbered habits preserve a deterministic order.
- [ ] Reorder by pointer, touch, and keyboard within and across carryover/program partitions;
      signed lap, stage colour, dates, and persisted `is_carryover` reconcile.
- [ ] Saturating more than ten stages/laps remains usable and does not corrupt ordering.
- [ ] Delete names the habit and history consequence, cancel is lossless, confirm removes the
      intended habit only, and double-submit is safe.

### 11.5 Offline queue and errors

- [ ] Offline check-in queues visibly and replays on next load.
- [ ] Permanent validation/authorization failures move to bounded quarantine with an honest
      visible count; one poison row does not block later valid rows.
- [ ] Dropped connection requeues the unsent suffix in order.
- [ ] Logout/account switch wipes queues/quarantine before another user can see or replay them.
- [ ] A fake/demo habit operation remains local and never shows a misleading sync failure.

## 12. Practice and ritual engine

### 12.1 Practice home, catalogue, and detail

- [ ] Empty, loading, error/retry, recent practices, active stage practice, weekly progress,
      long lists, and pagination render without duplicate/refetch loops.
- [ ] Browse/search/filter system and community/custom catalogues; results, empty search, and
      back navigation are correct.
- [ ] Adopt a custom practice once; repeat adoption is idempotent and stage locks are honest.
- [ ] Practice detail shows identity, instructions, duration, stage, tags, total sessions,
      total minutes, mode configuration, and eligible actions accurately.
- [ ] Copy to another stage, customize, and future/unconfirmed-stage behaviour are explicit.

### 12.2 Create, edit, tag, share, and delete

- [ ] Create wizard validates name, description, instructions, duration, stage, mode, and
      every mode-specific field at boundaries.
- [ ] Personal recipes/tags create, rename, search, attach, detach, and delete without
      orphaning unrelated practices.
- [ ] Sharing preview contains intended public fields and no account/corpus/private metadata.
- [ ] Cancelled/expired/malformed/duplicate share links and already-adopted shares recover.
- [ ] Delete/customize actions confirm scope and preserve historical sessions appropriately.

### 12.3 Session lifecycle common to every mode

- [ ] Start, pause, resume, complete, save, save-anyway, cancel, background/foreground,
      refresh, clock change, audio interruption, and navigation-away paths are coherent.
- [ ] Only one active session and at most one saved session result from rapid controls.
- [ ] Log a current and past session; date/time/timezone and weekly count update correctly.
- [ ] Capture, edit, save, and dismiss an insight without losing or duplicating the session.
- [ ] Audio/haptic/visual cues agree and respect mute, denied haptics, reduced motion, and
      browser autoplay constraints.

### 12.4 Mode matrix

For every mode, test valid defaults, every boundary, a malformed saved config, a live
configuration change, pause/resume, completion, and persistence:

- [ ] Meditation timer: zero/one/max duration, end bell, background timing.
- [ ] Count up: no cap, soft cap, crossing the cap, very long session.
- [ ] Metronome: min/max BPM, beat subdivisions, timer coupling, audio drift.
- [ ] Interval bell: interval/count/duration combinations and final-bell duplication.
- [ ] Random interval bell: min=max, min>max refusal, seeded/unseeded timing, background.
- [ ] Rep counter: increments/decrements, target crossing, rapid taps, accessible count.
- [ ] Sense grounding: each sense/prompt, skip/back, completion state.
- [ ] Tallied grounding: multiple tallies, zero/target/over-target, labels and completion.
- [ ] Mindful anchor: choose/change anchor, keep going, save anyway, no selection.
- [ ] Tarot meditation: deck/card choice, draw/re-draw, missing asset, readable card details.
- [ ] Card meditation: fixed/custom deck, empty/one/many cards, image failure and alt text.

### 12.5 Journal/practice seam

- [ ] A saved Journaling practice quick-launches a timed Journal page with the right identity.
- [ ] A future locked practice may open writing but never posts a forbidden session.
- [ ] Completing the page records exactly one eligible session and returns to the expected
      Practice state.

## 13. Course and passage workflow

- [ ] Course works when enabled independently of Habits/Practice.
- [ ] Current stage, introduction, content list, locked/read states, and progress match the
      program calendar and Map.
- [ ] Stage drawer search/navigation, loading, retry, long list, and direct stage link work.
- [ ] Open every content type; markdown, images, links, headings, and long content are safe.
- [ ] Previous/next/Done controls have correct endpoints, labels, and disabled states.
- [ ] Mark read is idempotent, persists, and updates progress once.
- [ ] Write a note on a selected passage with mouse and keyboard selection; the blockquote,
      source title, and return scroll offset are exact.
- [ ] Cancel selection, select across elements, reverse selection, select at viewport edges,
      refresh, and stale content do not produce wrong quotes.
- [ ] Reflect from a reading and return to that content at the documented top/offset.
- [ ] Map's Continue opens the correct stage/course content and browser back returns cleanly.
- [ ] Seeded curriculum stage names/copy match across Course, prompts, Practice, Habits, and Map.

## 14. Map, calendar, and depth selection

- [ ] Wheel shows exactly ten facets with Adepthood labels, correct colour identity, fullness,
      current stage, and no altitude/ranking/shame language.
- [ ] Empty/unclassified corpus is distinguishable from a genuinely balanced zero state.
- [ ] Local fallback and Creek wheel paths render consistent meanings and honest provenance.
- [ ] Advance stage follows eligibility/confirmation rules and updates every dependent ring.
- [ ] Unconfirmed/future/looped stages and the 3/6-week cadence display correctly.
- [ ] Choose each combination of Habits/Practice/Course rings; save, refresh, and another
      session retain the preference.
- [ ] Turning a ring off preserves its data and offers no guilt copy; turning it on restores
      the correct state.

## 15. Settings, vault, wallet, Sangha, legal, and care

### 15.1 Settings hub

- [ ] Account, Corpus, Privacy, Choose your depths, Sangha, Your data, Session, Support & care,
      and Legal sections appear in a coherent order at every width.
- [ ] Privacy statement says the user chooses Public/Personal/Intimate and Intimate never
      reaches any AI; screen-reader output includes both promises.
- [ ] Every row's label, description, icon, destructive style, focus, and destination agree.

### 15.2 Time zone and BYOK

- [ ] Time zone search/select/save accepts valid IANA zones, rejects invalid values, persists,
      and immediately updates day-based stats without rewriting historical instants.
- [ ] BYOK disclosure identifies the two service boundaries and wallet implications before
      a key is saved or used.
- [ ] Show/hide, paste, whitespace, invalid format, wrong provider, revoked key, billing
      exhaustion, replacement, removal, and account switch never expose or cross-wire keys.
- [ ] Key values are absent from UI after save, logs, export, screenshots, and error text.

### 15.3 Connect your own vault

- [ ] Empty/invalid/non-HTTPS/user-loopback/private-network/redirecting URLs are rejected by
      the user-supplied URL policy before credentials can be sent.
- [ ] Valid URL + key handshake negotiates current contract, displays safe host identity, and
      never reflects the key.
- [ ] Wrong key, unavailable host, TLS failure, incompatible contract, missing capabilities,
      timeout, rebinding, and DNS changes fail closed with actionable copy.
- [ ] Replacing a vault is explicit; an old in-flight response cannot mark the new vault valid.
- [ ] Disconnect removes Adepthood's pointer/credential and accurately explains what remains
      in Creek.

### 15.4 Private-vault activation and recovery

- [ ] Activation is optional and asynchronous; Journal remains usable while provisioning.
- [ ] Loading, retry, allocator refusal, non-confidential attestation, timeout, and stale job
      are honest and do not create duplicate vaults.
- [ ] Recovery ceremony keeps the recovery material user-held, displays it only when needed,
      supports copy/save confirmation, and never sends it to the provisioning request.
- [ ] Refresh/back/close during ceremony cannot silently lose the only recovery path or expose
      material to logs/another account.

### 15.5 Wallet/refill

- [ ] Included and purchased/provider balances are labelled distinctly and reconcile after
      resonance success, refund, BYOK use, refill, refresh, and concurrent requests.
- [ ] Refill URL/product selection is correct; cancel, failed payment, delayed webhook,
      duplicate webhook, and account-email mismatch do not mint or lose credit incorrectly.

### 15.6 Sangha, legal, and support

- [ ] Sangha invitation is optional, one-tap declinable, does not nag, and opens the configured
      Discord destination externally with accurate third-party copy.
- [ ] Privacy policy and Terms open the canonical external documents; blocked popup/offline
      states do not freeze the app.
- [ ] Support & care is always reachable, readable without a model/provider/vault, and offers
      accurate human/professional/crisis resources for the user's locale where promised.

## 16. Security, privacy, tenancy, and abuse pass

- [ ] Attempt every ID-bearing route with a second tenant's ID; receive the repository's
      consistent missing/not-owner response and create/update/delete nothing.
- [ ] Test sequential, negative, huge, float-like, malformed, encoded, and duplicate IDs.
- [ ] Inspect all requests/responses/logs for passwords, tokens, keys, recovery material,
      reset links, raw journal text, imported bytes, essays, and cross-tenant identifiers.
- [ ] Confirm CORS admits only intended origins/methods/headers and credentials behaviour.
- [ ] Confirm auth, signup, reset, resonance, import, and destructive endpoints have appropriate
      rate/size/concurrency controls without account enumeration.
- [ ] Render injection fixtures everywhere user/provider/Creek text appears; no script runs,
      raw HTML escapes sandboxing, log line is forged, bidi text spoofs adjacent chrome, or
      external link gains unsafe opener access.
- [ ] Malformed/oversized Creek responses are bounded before allocation/render/storage.
- [ ] SSRF controls survive redirects, alternate IP spellings, IPv6, DNS rebinding, userinfo,
      encoded hosts, trailing dots, and credentials-in-URL attempts.
- [ ] Privacy downgrade/upgrade races fail closed at every boundary.
- [ ] Encryption-at-rest canaries are ciphertext in raw database columns and plaintext only at
      explicitly authorized read/export surfaces.

## 17. Performance, endurance, and concurrency

- [ ] Measure cold and warm load for auth, Journal shelf, opening an entry, first autosave,
      drawer, Habits, Practice, Course, Map, and Settings; record outliers and layout shifts.
- [ ] Long-history fixture remains responsive during pagination/search/scroll and does not
      fetch unbounded data without explicit consent.
- [ ] Run a 30-minute editing/autosave session; memory, network calls, timers, and logs remain
      bounded.
- [ ] Open/close each drawer/modal 50 times; no event-listener, focus, scroll, or request leak.
- [ ] Trigger parallel autosave, resonance, import, classification, wheel, and navigation;
      connection-pool use remains bounded and the correct record receives each response.
- [ ] Restart Creek during a durable classification job and Adepthood during polling; terminal
      work is recoverable and never reported complete prematurely.
- [ ] Restart Postgres/backend/frontend independently; recovery states are comprehensible and
      already committed user data remains intact.

## 18. Automated corroboration and journey reconciliation

Before signing off, run the repository gates from clean current-main worktrees:

- [ ] Adepthood backend targeted/full tests and `./scripts/backend/check-all.sh`.
- [ ] Adepthood frontend targeted/full tests and `./scripts/frontend/check-all.sh`.
- [ ] `npm run check:journeys`.
- [ ] Real-Postgres API E2E lane.
- [ ] Real-browser E2E lane.
- [ ] The active real-Creek `/v1` E2E verification, including persisted classification
      evidence and telemetry asserting zero schema failures.
- [ ] Creek's relevant check-all/pre-commit suites at its exact SHA.

Reconcile every row in `frontend/e2e/journeys.json` with this pass. At this
revision the ledger declares journeys in these families:

- Auth: signup/login/licence, password recovery, and sliding session.
- Welcome: walkthrough to Journal.
- Journal: write/read/delete, Morning pages, markdown, final-save close, title geometry,
  promoted passages, reflection folding, prompts/history, resonance/cost/refill, habit and
  practice offers, Return, photograph capture, entry-control responsiveness, corpus drawer,
  voice readiness, failed check-off, and anti-repetition.
- Corpus/Seed: invitation/decline, import with and without vault, in-flight import, consent,
  BYOK boundary, and document upload.
- Habits: create/check-in/streak, empty/demo/offline states, cadence, start anchor, reveal,
  reorder, re-scaffold, legacy order, day rollover, and deletion.
- Practice: current/past session, weekly/detail statistics, adoption, tags, long-list paging,
  quick-launch journaling, and unconfirmed stage.
- Course: read/progress, passage note, and reflect/return.
- Map/Depth: advance, continue in Course, and choose optional rings.
- Vault: connect and activate with user-held recovery.
- Account: export, delete, and account-switch purge.
- Errors: boundary recovery, server-versus-offline truth, and provider-balance refusal.

If a discovered critical user journey is not present, update the ledger in the
same PR as the user-facing change or file a clearly scoped journey-gap issue.
Never mark a manual observation as automated coverage.

## 19. Exit and teardown

- [ ] Re-run every failed case after its fix from a reset fixture and once from an existing
      upgraded fixture.
- [ ] Confirm all filed issues are deduplicated, correctly owned, prioritized, labelled, and
      contain testable acceptance criteria.
- [ ] Confirm no test credentials, canaries, raw content, databases, vaults, or background
      processes remain outside the explicitly retained evidence directory.
- [ ] Confirm both repository worktrees are clean except for intentional reviewed changes.
- [ ] Record automated gate URLs/results and the final exact default-branch SHAs.
- [ ] A failing, skipped, or unexplained checklist item makes the run FAIL or BLOCKED—not PASS.

## Appendix A: quick Murphy's-law probes

Use these when a surface appears done; they often expose the seam behind it.

- Double-click, then click again after the spinner disappears.
- Submit with Enter while the pointer simultaneously presses the button.
- Navigate away at 10%, 90%, and just after the request commits.
- Refresh with a modal open, a drawer open, text unsaved, and a poll in flight.
- Put the clock just before midnight, cross DST, then change time zone while mounted.
- Paste 10× the expected input, a single 10,000-character word, emoji, RTL, and CRLF.
- Delete the target in another tab between opening and confirming.
- Revoke auth/provider/vault credentials after handshake but before mutation.
- Let the backend commit and discard its response; retry from the unchanged UI.
- Return responses in reverse order and after the component unmounts.
- Make one row in a batch fail permanently while later rows are valid.
- Use identical names, identical bytes, repeated external IDs, and another tenant's numeric ID.
- Change Public/Personal to Intimate while classification or reflection is running.
- Make a durable job end `complete: false` with HTTP 200 and plausible counts.
- Make Creek advertise a capability it cannot serve, and serve one it did not advertise.
- Exhaust wallet/provider budget between preflight and model request.
- Close an essay modal while loading, open another note, then release the first response.
- Disable the current navigation ring while a child modal is open.
- Log out, log into a second account, then release all delayed first-account requests.

## Appendix B: pass statement

Use this only when every condition is true:

```text
I tested Adepthood SHA ______ against Creek SHA ______ using this runbook.
Every applicable item has evidence; all critical journeys were exercised on the
real local stack; Journal and bulk-import fragments were verified classified in
Creek's persisted corpus; the True Self essay path was verified for grounding,
privacy, caching, and mirroring; all defects were filed in the owning repository;
all required automated gates passed; and no unexplained skip remains.
```
