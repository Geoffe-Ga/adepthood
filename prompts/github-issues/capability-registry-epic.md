# Epic: The Capability Registry — journal-driven, pluggable features

**Labels:** `enhancement`, `architecture`, `backend`, `frontend`, `capability-registry`
**Scope:** A registry that makes every feature a pluggable, opt-in, journal-addressable unit — plus the generalized detection/suggestion pipeline and MCP seam that let a user drive those features simply by writing.
**Estimated total LoC:** ~2,700 across 9 sub-issues

## Role

You are a full-stack engineer turning Adepthood's hand-wired feature set into a
**capability registry**: a declarative seam where habits, practices, self-care,
wavelength tracking, course, map — and future plugins like Apple Shortcuts — all
register the same way, are gated by the same opt-in machinery, and can be
*referenced and controlled from a journal entry* through one generalized
detection→suggestion→confirm pipeline. You build on what already exists (and a
surprising amount already exists); you do not duplicate it.

## Why (the north-star intent)

The product vision (`NORTH-STAR.md`) is a journal-first floor with optional,
self-chosen **depths** arranged as concentric rings — "you choose your depth."
The owner's hope is concrete: **to control and reference every aspect of the app
— opt-in features / plugins — simply by writing notes and morning-pages-style
journal entries that the AI reads.** New capabilities (self-care strategies,
wavelength tracking, course material, map, and eventually Apple Shortcuts so the
journal can talk to *other* apps) should plug in without bespoke wiring across
ten layers, and should immediately become writable-about.

Today, adding a top-level feature means editing ~14 files across ~10 layers
(see the pluggability audit referenced below), each ring's opt-in flag is a
hard-coded DB column, and the LLM is purely conversational — it *proposes* JSON
the server parses; it cannot *act*. This epic closes that gap while holding the
line on the vision's guardrails.

## Non-negotiable guardrails (carried from NORTH-STAR)

These are acceptance criteria for **every** sub-issue, not decoration:

- **Human-in-the-loop, always.** A journal entry never mutates app state
  directly. It produces *proposals* the user accepts or dismisses — the exact
  `pending → accepted → dismissed` lifecycle that `CompletionSuggestion` already
  has. Nothing this epic adds is allowed to auto-execute an action from text.
- **You choose your depth.** Every capability is opt-in and declinable in one
  tap; a dismissed proposal or invitation is never silently re-created (honour
  the `InvitationSignal` uniqueness precedent). The registry must never be used
  to *pressure* a depth.
- **Anti-guru / the user's own words.** Detection reflects and confirms what the
  user wrote; it does not invent goals for them. The index+quote trust model
  below is what keeps this honest.
- **Privacy floor.** Intimate/encrypted entries never leave the device boundary
  they leave today, and are **never** forwarded to a remote MCP server without
  explicit, per-action consent. Remote capability calls carry only the minimum
  the user confirmed — never raw journal text by default.
- **Care boundaries.** `domain.care.MEDICATION_GUARDRAIL` and
  `domain.safety.assess_distress` stay in the pipeline; a distress signal
  suppresses action proposals in favour of care resources.

## The trust model (the spine — do not weaken it)

Every LLM pass in this codebase uses the same safe pattern, and this epic
**preserves it verbatim**: the model is handed a numbered list of *candidates
the server built from real rows* and may only return **an index into that list
plus a verbatim quote** copied from the entry body. The server resolves the
index against its own candidate list and anchors the quote itself — **model-
supplied ids, character offsets, and free-form targets are never trusted**, and
anything that doesn't resolve cleanly is dropped
(`backend/src/domain/detection.py:1-12`, `backend/src/domain/resonance.py:1-8`).
Generalizing detection to arbitrary capabilities means the model may now also
pick a **verb** and a small **params** object — but only from a server-supplied,
schema-validated menu, never as open text. This is the whole security story for
"journal-as-control-surface."

## Context — what already exists (do NOT rebuild)

The audit confirms most of the substrate is already here.

| Capability | Status | Files |
|---|---|---|
| Journal → resonance pass that fans out to detection + marginalia + care + safety atomically | ✓ | `backend/src/routers/journal.py:19-23,584-633` |
| Completion **detection** over candidates with index+quote trust model | ✓ | `backend/src/domain/detection.py` |
| Candidate gathering unifying habits **and** practices under one budget | ✓ | `backend/src/services/completion_candidates.py:1-28` |
| `CompletionSuggestion` with `pending→accepted→dismissed` + anchor span | ✓ (polymorphic FKs) | `backend/src/models/completion_suggestion.py:78-148` |
| `InvitationSignal` — the system→user channel — with **generic `(target_type, target_id)` addressing, no per-type FK** | ✓ | `backend/src/models/invitation_signal.py:73-128` |
| Provider-registry LLM layer (`stub`/`openai`/`anthropic`), conversational only | ✓ | `backend/src/services/botmason.py:99-123` |
| Store-reset **self-registration registry** (the frontend plugin precedent) | ✓ | `frontend/src/store/registry.ts:18-36` |
| Config-driven bottom-tab assembly gated by per-ring flags | ✓ (flags hard-coded) | `frontend/src/navigation/BottomTabs.tsx:100-152` |
| Depth-preference opt-in toggles | ✓ (one boolean column per ring) | `backend/src/models/user_depth_preferences.py:30-49`, `frontend/src/store/useDepthPreferencesStore.ts` |
| Practice **mode/engine** discriminator — a working in-feature plugin system | ✓ | `backend/src/domain/practice_modes.py`, `frontend/src/features/Practice/engine/` |
| Wheel-of-wholeness / Wavelength fullness view (derived, not its own store) | ✓ | `backend/src/domain/wheel.py` |

## Context — what's missing (the gaps this epic fills)

| Gap | Sub-issue |
|---|---|
| No registry: features are hand-wired into `main.py`, `models/__init__.py`, nav, store, api | 01, 06 |
| Opt-in is one DB **column per ring** — every new feature drags a migration | 02 |
| `CompletionSuggestion` addresses targets with per-type FK columns — resists new target types | 03 |
| Detection only knows habits/practices, only the "complete" verb | 04 |
| No generic accept/execute path — accept handlers are hand-written per target in the journal router | 05 |
| No frontend feature manifest; `RING_TABS`, depth flags, deep-links all hard-coded | 06 |
| Suggestion UI is completion-specific, not capability-agnostic | 07 |
| LLM cannot call tools; no MCP client; the "Creek Vault MCP seam" is doc-only | 08, 09 |
| No outbound integration (Creek Vault, Apple Shortcuts, other apps) | 09 (+ future) |

## The core abstraction: a Capability

A **Capability** is a registered, addressable, opt-in unit of behaviour that a
feature/plugin contributes. Each descriptor carries:

- `key` — stable string id (e.g. `"habit"`, `"practice"`, `"wheel_note"`, `"shortcut"`).
- `label` / `icon` — human presentation.
- `feature_flag` — the opt-in key the registry gates it by (replaces the
  boolean-column-per-ring; see 02).
- `candidates(user, session)` — builds the `DetectionCandidate` menu the LLM may
  reference (generalizes `completion_candidates.gather_candidates`).
- `verbs` — the closed set of actions the model may propose for this capability
  (e.g. habit → `{complete}`; practice → `{complete}`; course → `{mark_read}`;
  wheel → `{note}`; a future `shortcut` → `{run}`), each with a params schema.
- `execute(target, verb, params, ctx)` — the server-side handler the *accept*
  path dispatches to (generalizes the per-target accept handlers in the journal
  router).
- optional `mcp_tool` — binds the verb to an MCP tool (local in-process or a
  remote server like the Creek Vault) for 08/09.

Features register their capabilities at import, exactly as stores publish their
reset today (`frontend/src/store/registry.ts`) and as providers register in
`botmason.PROVIDER_REGISTRY`. The registry becomes the single source of truth
that detection, the accept endpoint, navigation, depth-preferences, and the MCP
layer all read from — so a new plugin is *one manifest*, not fourteen edits.

## Output format

Nine sub-issues. Tracer-code order (see the repo's `tracer-code` skill): build a
thin end-to-end skeleton first (registry → generic suggestion → generic detect →
generic accept), retrofit the two existing features onto it so behaviour is
provably unchanged, then light up new capabilities and the MCP seam. Each
sub-issue is independently shippable and stays green.

Dependency graph:

```
01 backend-registry ──┬── 02 generic-feature-flags ──┐
                      ├── 03 action-suggestion-model ─┤
                      │                               ├── 04 intent-detection ── 05 execute-handlers ──┐
                      └───────────────────────────────┘                                                │
                                                                                                       ├── 07 suggestion-inbox
06 frontend-manifest (needs 01, 02) ───────────────────────────────────────────────────────────────── ┘
05 ── 08 mcp-client-tool-calling ── 09 creek-vault-binding  (09 BLOCKED on creek-vault repo access)
```

## Sub-issues

| # | Title | Scope | LoC |
|---|-------|-------|-----|
| 01 | [Capability descriptor + backend registry](capability-registry-01-backend-registry.md) | Backend | ~250 |
| 02 | [Generic feature-flag opt-in (retire boolean-per-ring)](capability-registry-02-generic-feature-flags.md) | Full-stack | ~250 |
| 03 | [Generalize `CompletionSuggestion` → `ActionSuggestion`](capability-registry-03-action-suggestion-model.md) | Backend | ~300 |
| 04 | [Registry-driven intent detection (verbs + params)](capability-registry-04-intent-detection.md) | Backend | ~300 |
| 05 | [Capability execute handlers + generic accept endpoint](capability-registry-05-execute-handlers.md) | Backend | ~300 |
| 06 | [Frontend feature manifest → registry-driven nav/store/flags](capability-registry-06-frontend-manifest.md) | Frontend | ~300 |
| 07 | [Capability-agnostic suggestion inbox UI](capability-registry-07-suggestion-inbox.md) | Frontend | ~250 |
| 08 | [MCP client + tool-calling in the LLM layer](capability-registry-08-mcp-client-tool-calling.md) | Backend | ~300 |
| 09 | [Creek Vault MCP binding + external capability](capability-registry-09-creek-vault-binding.md) | Full-stack | ~300 |

## Acceptance Criteria (epic-level)

- [ ] A new backend feature registers a `Capability` and is reachable by detection + accept with **no edits** to `detection.py`, the accept endpoint, or `main.py`'s wiring beyond importing the feature module.
- [ ] A new frontend feature ships as **one manifest**; `RING_TABS`, its depth toggle, deep-link entry, and store-reset all derive from it.
- [ ] Adding an opt-in feature requires **no new DB column** (feature flags are generic — 02).
- [ ] Writing a journal entry that mentions completing a habit, doing a practice, or (new) leaving a wheel/wavelength note surfaces a confirmable proposal for each — all through one pipeline and one inbox.
- [ ] Existing habit + practice completion detection behaviour is **provably unchanged** (their tests pass untouched; they now run through the generalized path).
- [ ] The LLM can invoke a **local** capability as an MCP tool call, still gated behind a human-confirmed suggestion (08).
- [ ] Every guardrail above holds: no auto-execution, opt-in + declinable, privacy floor intact, care/safety passes retained.
- [ ] `pre-commit run --all-files` green and coverage/complexity thresholds unchanged on every sub-issue PR.

## Constraints

- **Do not weaken the index+quote trust model.** Verbs and params must come from
  a server-supplied, `extra="forbid"` schema per capability — never free text.
- Prefer **generic `(target_type, target_id)` addressing** (the `InvitationSignal`
  precedent) over per-type FK columns (the `CompletionSuggestion` shape) for all
  new tables, so target types are additive without migrations.
- Retrofit **before** extending: 01 must register the *existing* habit + practice
  capabilities and 03/04/05 must route the existing flow through the generic path
  with the current tests green, before any new capability is added.
- Keep the LLM layer provider-agnostic; MCP tool-calling (08) degrades to the
  current conversational path when the active provider/tier can't tool-call.
- Remote MCP (09) is **config-driven and consent-gated**; it must be shippable
  as "off by default" and must not send journal text to the Vault implicitly.

## References

- Pluggability audit (this session): ~14 files / ~10 layers to add a feature today; `store/registry.ts` + `RING_TABS` + practice-mode discriminator are the three existing plugin precedents.
- `backend/src/domain/detection.py` — index+quote detection (the pattern to generalize)
- `backend/src/services/completion_candidates.py` — candidate gathering (→ capability candidates)
- `backend/src/models/completion_suggestion.py` — lifecycle + anchor (polymorphic FK shape to generalize)
- `backend/src/models/invitation_signal.py` — generic `(target_type, target_id)` addressing to copy
- `backend/src/routers/journal.py:819-843` — hand-written per-target accept handlers to unify
- `backend/src/services/botmason.py:99-123` — `PROVIDER_REGISTRY` (the backend registry precedent + MCP seam host)
- `frontend/src/store/registry.ts` — self-registration seam to generalize to features
- `frontend/src/navigation/BottomTabs.tsx:100-152` — `RING_TABS` to derive from a manifest
- `backend/src/models/user_depth_preferences.py` — boolean-per-ring to retire
- `backend/src/domain/wheel.py` — wavelength/wheel fullness (first *new* capability target)
- `NORTH-STAR.md:70` — names the Creek Vault MCP seam + the shared ontology (Aspects = Frequencies = Wavelength phases)

## Open questions (resolve before/inside the relevant sub-issue)

- **Creek Vault manifest (blocks 09).** The `geoffe-ga/creek-vault` repo is
  **not in this session's GitHub scope**, so its MCP server framework, transport
  (stdio vs HTTP/SSE), exposed tools/resources, auth model, and the concrete
  shared-ontology representation are unconfirmed. Add `geoffe-ga/creek-vault` to
  the environment's allowed repositories and pin 08/09's tool schemas to the
  real manifest before implementing them. Until then, treat 08's *local* tools
  as the shippable target and 09 as design-complete-but-blocked.
- Whether generic feature flags (02) should fully replace the four boolean
  columns or run alongside them for one release before the columns are dropped.
- Whether `CompletionSuggestion` rows are migrated in place (03) or the old model
  is kept as a read adapter over `ActionSuggestion`.
