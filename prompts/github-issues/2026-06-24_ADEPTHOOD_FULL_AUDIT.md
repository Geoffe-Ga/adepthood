# 2026-06-24 — Adepthood Full-Stack Audit

> **Type:** Evidence base for the Audit → Backlog → Autonomous-Loop mandate (Phase A deliverable).
> **Method:** One disciplined sweep of the whole tree (frontend, backend, infra, CI, content, docs)
> against the "vibe sloppiness" taxonomy — aspirational/stub/fake, render cost, list virtualization,
> event-loop blocking, N+1, pagination, contracts, auth, UX states/a11y, test quality, docs drift.
> **Headline:** This is a mature, unusually disciplined codebase (≈20k LoC backend, ≈70k LoC
> frontend incl. tests; work merged through PR #455). The historical "712-line `HabitsScreen` god
> component" and "fake stats generation" are genuinely resolved. The remaining gaps are real but
> concentrated: a handful of **event-loop / perf** issues, a **data-loss schema-drift** bug, several
> **un-paginated/un-virtualized lists**, a few **honest-but-hollow** capabilities (Sentry, encryption
> flag, energy persistence, tarot art), and some **CI/docs-truth** drift.

---

## 1. Baseline gate state (captured 2026-06-24)

| Gate | State | Evidence |
|---|---|---|
| Backend full suite (`pytest`) | **RED** | `tests/services/test_streaks.py::test_streak_uses_user_timezone_across_utc_midnight` fails. The test hardcodes completions on 2026-06-15 but `compute_consecutive_streak` measures against the real wall-clock (today 2026-06-24), so the streak is no longer "current." Time-coupled test → the suite is only green inside a narrow date window. **The stay-green baseline is not actually green.** |
| Backend suite minus that test | Green | All other backend tests pass. |
| Backend env | OK | `.venv` present; deps installed by session setup. |
| Frontend deps | OK (noisy) | `npm ci` succeeded; `npm audit` reports 36 advisories (1 critical, 18 high) — see §8. |
| Branch-coverage CI gate | **Non-gating** | `backend-ci.yml:62` runs `pytest … 2>/dev/null || true`; a pytest crash is swallowed and the 80% gate parses a stale/partial `coverage.xml`. |
| Action SHA-pinning | **2 of 5 workflows violate** | `claude.yml` and `claude-code-review.yml` use mutable tags (`actions/checkout@v6`, `anthropics/claude-code-action@v1`) with `write` perms + OIDC. |

**Most urgent baseline fix:** make the streak test time-independent (inject/freeze "now"), because every
Phase-C iteration's pre-push gate inherits this red suite.

---

## 2. Top 10 things that most hurt a real user right now

1. **`HabitsScreen` imports icons from `lucide-react` (web/DOM), not `lucide-react-native`** (`HabitsScreen.tsx:3`). On a real device the top bar / overflow menu renders nothing or crashes — the screen only "demos" on web.
2. **`days_of_week` is silently stripped from every habit refetch** (`api/schemas.ts` `goalSchema`). Zod strip-mode deletes a field that's on the wire and in `ApiGoal`; weekly-cadence ("Mon/Wed") goals lose their schedule on every refresh. Live data-loss bug.
3. **bcrypt runs synchronously on the event loop in every auth handler** (`routers/auth.py`). ~250ms cost-12 hashing pins the worker; a few concurrent logins serialize the whole process. `energy.py`/`email.py` already offload with `to_thread`; auth never did.
4. **All 78 tarot cards resolve to one `_placeholder.png`** (`Practice/data/assetResolver.ts`). The entire visual payoff of Tarot + card-meditation modes is a stub.
5. **Four list endpoints return unbounded collections** (`practice_tags`, `practice_recipes`, `admin/stage-progress/gaps`, `admin/usage-stats`), and UserPractice *detail* responses embed the user's **full** session history on every GET. Payloads grow without limit.
6. **The Practice catalog & stage selector render long lists with `.map()` inside `ScrollView`** (`PracticeCatalogScreen.tsx`, `PracticeSelector.tsx`) — no virtualization, eager mount, jank as the catalog grows.
7. **The "Start from a preset" CTA in the Create-Practice wizard just calls `goBack()`** (`CreatePracticeWizard.tsx:184`). The recommended entry path silently dismisses the wizard.
8. **Course & Map mask real fetch failures as empty/loading states** (`CourseScreen` shows permanent "Loading…"/"No Content Yet" on error; `MapScreen` has no retry when a refresh fails with stages already present). Users can't tell "broken" from "empty," with no retry.
9. **Habits screen chrome has zero accessibility labels** (overflow menu, mode bar, pagination, energy CTA) — screen-reader users can't operate it. Journal, by contrast, labels everything.
10. **Authenticated users can submit arbitrary `energy_cost`/`energy_return`** to the energy planner (`routers/energy.py`, deferred BUG-PRACTICE-010) — the server trusts client values instead of loading them, letting a user steer/poison their plan.

---

## 3. Findings — Backend async correctness & query performance (§5.3)

| file:line | class | severity | impact | fix |
|---|---|---|---|---|
| `routers/auth.py` (hash/verify call sites: 251,256,508,589,920,929,939,952,1310,1396) | event-loop blocking | **Critical** | Synchronous bcrypt cost-12 (~250ms) inside `async def` signup/login/confirm/reset → pins worker, serializes concurrent auth. | Wrap each `bcrypt.hashpw`/`checkpw`/dummy in `asyncio.to_thread`. |
| `models/goal_completion.py:23-34` | missing index / N+1 exposure | **High** | No index on `goal_id`/`user_id`/`timestamp` on the highest-write table; every streak/stats query full-scans + sorts. | Add composite `(goal_id, user_id, timestamp)` index + migration. |
| `models/journal_entry.py:50-62` | missing composite index | **High** | `load_recent_conversation` filters `(user_id, sender, deleted_at)` ORDER BY id DESC; only single-col `deleted_at` index exists → every chat turn scans the user's history. | Add composite index + migration. |
| `routers/stages.py:76-102` | N+1 | **High** | `list_stages` calls `compute_stage_progress` once per stage in a Python loop (N stages × M metric queries); grows to 36 stages on the primary course surface. | Batch the per-stage metrics into grouped queries. |
| `routers/goal_completions.py:303-335` | redundant queries | Medium | `compute_consecutive_streak` runs up to 3× per check-in (idempotent path, old_streak, persist path). | Compute once, thread the value. |
| `routers/goal_groups.py:48-61` | GET that writes | Medium | `list_goal_groups` calls `ensure_seed_templates` (SELECT + conditional INSERT + commit) on every GET — violates HTTP semantics, adds a round-trip; same anti-pattern botmason already fixed for `/user/usage`. | Move seeding out of the read path. |
| `services/energy.py:32-34` | per-process cache | Medium | Energy idempotency is an in-process `TTLCache`; under multiple workers the same key yields different plans. | Persist plans (see §6 de-stub epic). |
| `main.py:398-405` | CORS surface | Medium | `allow_credentials=True` for a Bearer-token API (no cookies) — unnecessary credentials mode widens surface. | Set `allow_credentials=False` unless cookies are used. |
| `routers/practices.py:43`, `practice_share.py:93` | broad except | Medium | `except Exception` in rate-limit key fn masks bugs as anonymous IP fallback; botmason's narrowed version is the correct copy. | Narrow to `HTTPException`. |
| `services/chat_stream.py:106,363` | broad except | Medium | Broad `except Exception` turns programmer bugs into a generic 502. | Narrow + re-raise non-provider errors. |

## 4. Findings — Pagination & response contracts (§5.3)

A real `Page[T]` envelope (`schemas/pagination.py`) exists and is wired into habits/practices/goal_groups/
user_practices/practice_sessions/stages/course via an opt-in `?paginate=true`. The gaps:

| file:line | class | severity | impact | fix |
|---|---|---|---|---|
| `routers/practice_tags.py:64-80` | unbounded list | **High** | Returns all system + user tags, no limit. | Add `PaginationParams`. |
| `routers/practice_recipes.py:186-199` | unbounded list | **High** | Returns all system + user recipes, no limit. | Add `PaginationParams`. |
| `routers/user_practices.py:510-532,561-609`, `practice_recipes.py:381-406` | unbounded embed | **High** | Detail/customize/apply responses embed the **full** `sessions[]` history on every call; bypasses the paginated `list_sessions`. | Cap or paginate embedded sessions. |
| `routers/admin.py:191-193` | unbounded scan | **High** | `list_stage_progress_gaps` materializes the whole `StageProgress` table. | Add limit/offset. |
| `routers/admin.py:89-126` | unbounded | Medium | `get_usage_stats.per_user` returns one row per token-using user. | Paginate. |
| `routers/practice_sessions.py:457-476` | untyped contract | Medium | `week_count` has no `response_model`; returns a raw dict. | Add a Pydantic response model. |
| `routers/user_practices.py:510,561`, `practice_recipes.py:347` | hand-built dicts | Medium | `-> dict[str, Any]` built by hand in 3 places duplicating `UserPracticeDetail` keys → drift risk. | Build from the schema. |
| Many list endpoints (`response_model=None`, `Page[T] | list[T]` union) | dual-shape contract | Medium | One URL returns two shapes based on `?paginate=`; transitional but a live drift footgun. | Plan removal of the legacy bare-list path. |
| `routers/practice_sessions.py:185-218` | in-process idempotency | **High** | `_IDEMPOTENCY_STORE` is a module-level dict: unbounded memory + fails across workers (duplicate sessions in any multi-worker deploy). | Back idempotency with the DB (like `chat_idempotency`). |

## 5. Findings — Frontend render cost, lists & animation (§5.2)

| file:line | class | severity | impact | fix |
|---|---|---|---|---|
| `Habits/HabitsScreen.tsx:3` | wrong import / stub | **Critical** | `lucide-react` (DOM) instead of `lucide-react-native`; native chrome renders nothing/crashes. | Switch the import. |
| `Habits/HabitsScreen.tsx:434-483` | render cost | **High** | `renderHabitTile` is a fresh closure each render (no `useCallback`) → FlatList re-renders every visible tile on any state change. | Stabilize the renderer. |
| `Habits/HabitTile.tsx`, `Journal/MessageBubble.tsx` | render cost | **High** | Neither is `React.memo`'d (zero `React.memo` in the Habits tree); rows re-render with unchanged data. | Memoize + stabilize props. |
| `Practice/screens/PracticeCatalogScreen.tsx:90,323` | list virtualization | **High** | Whole catalog via nested `.map()` in a `ScrollView`, all presets+drafts eager. | Convert to `FlatList`/`SectionList`. |
| `Practice/PracticeSelector.tsx:85` | list virtualization | **High** | Stage practice list `.map()` in a `View` under a `ScrollView`. | Virtualize. |
| `Habits/HabitsScreen.tsx:355-369` | list config | Medium | No `getItemLayout`; `key={cols-${columns}}` forces full remount (loses scroll) on every breakpoint change. | Add `getItemLayout`, stop remounting. |
| `Habits/HabitsScreen.tsx:243` | render cost | Medium | `calculateMissedDays` (loops all completions) runs every render even with the modal closed. | Gate behind modal-open. |
| `Habits/StatsModal.tsx:251-274` + `useHabitStats` | duplicate fetch | **High** | `habitsApi.getStats(id)` fires twice opening the stats modal (hook + modal effect). | Dedup/lift the fetch. |
| `Course/StageSelector.tsx:55-60` | render cost | Lower | O(N²) `stages.find()` per pill per render. | Build a keyed `Map` once. |
| `Practice/FrequencyBanner.tsx:71`, `BottomTabs.tsx:118-139`, `DatePicker.tsx:217` | render cost | Lower | Inline style objects / inline `headerRight` component / per-render `Date` factories. | Memoize / hoist. |
| `Practice` editable forms (`SenseGroundingForm.tsx:41`, `CardMeditationForm.tsx:122`, `IntervalBellView.tsx:35`) | unstable keys | Medium | Rows keyed by array index / module counter → state remaps to wrong row on reorder/delete. | Stable ids. |

## 6. Findings — Aspirational / stub / fake (§5.1)

| file:line | what it fakes | ship? | severity | fix |
|---|---|---|---|---|
| `Practice/data/assetResolver.ts:9-16` | 78 tarot cards → 1 placeholder image | Y | **Critical** | Ship real per-card artwork + resolver. |
| `Practice/screens/CreatePracticeWizard.tsx:184` | "Start from a preset" CTA → `onCancel`/`goBack` | Y | **High** | Wire to the catalog/preset picker. |
| `routers/energy.py:34-45` | planner trusts **client-supplied** energy cost/return (BUG-PRACTICE-010) | Y | **High** (authz) | Load real per-habit values server-side. |
| `services/energy.py:32-76` | energy plans live only in a 1-hr in-memory cache, never persisted | Y | **High** | Add `EnergyPlan` table + migration. |
| `models/journal_entry.py:12-18` | `ENCRYPTION_AT_REST_ENABLED` read but used nowhere; no encrypt/decrypt hooks | Y | **High** | Implement encryption or delete the hollow flag. |
| `services/llm_pricing.py:69-77` vs `botmason.py:119` | 3 allowlisted Anthropic models + `gpt-4-turbo` have no pricing row → cost logged as `None` | Y | **High** | Reconcile allowlist ↔ pricing, or enforce the gate. |
| `domain/stage_progress.py:204-207` | `divisor=2` hardcodes habits+practice and silently drops `course_items_completed` from overall % | Y | Medium | Fold course completion in; adapt the divisor. |
| `routers/botmason.py:160-203` | non-stream path doesn't map provider 401/429/503 → opaque 500 for BYOK users | Y | Medium | Map provider errors like the stream path does. |
| `Practice/CreatePracticeWizard.tsx:354-372` | `tallied_grounding` & `mindful_anchor` have engine+view but no configurator form; shows a "ships soon" notice (wrong name for `mindful_anchor`) | Maybe | Medium | Build the two forms; fix the copy. |
| `Practice/data/pickCardPhoto.ts` | custom-deck photo URIs stored but never uploaded → broken cross-device | Maybe | Medium | Upload + serve, or scope to device + label it. |
| `sentry.py:48-61`, `observability/sentry.ts:49-51`, `errors.py:78` | crash reporting is a documented no-op end-to-end | Maybe | Medium | Wire SDK + DSN before relying on prod observability. |
| `routers/botmason.py:333-365` | `add_balance` only credits the calling admin | N | Lower | Take a target user_id. |

## 7. Findings — Data-layer contracts & schema drift (§5.4)

| file:line | class | severity | impact | fix |
|---|---|---|---|---|
| `api/schemas.ts` `goalSchema` vs `schemas/goal.py:42` | schema drift / data loss | **Critical** | `days_of_week` stripped by Zod on every habit fetch; weekly cadence lost. | Add `days_of_week` to `goalSchema` (+ map in `toLocalHabit`). |
| `api/index.ts:1507` `PromptListResponse.total` vs `schemas/prompt.py:56` | drift | High | Backend `total: int|None`; frontend non-nullable → `NaN`/surprise. | Make nullable, guard consumers. |
| `api/index.ts:1169-1180,1522-1531` | unvalidated lists | High | `journal.list` / `prompts.history` pass no Zod schema → mis-shape surfaces as deep `TypeError`. | Add response schemas. |
| `api/index.ts` `loosePageSchema` casts | drift | Medium | All paginated endpoints except habits validate items as `z.record(z.unknown())` then double-cast; item-level drift invisible. | Write per-item Zod schemas. |
| `api/index.ts:422-426` | token-refresh race | Medium | `/auth/refresh` is a raw `fetch` (no timeout/abort); concurrent 401s fire un-deduped refreshes → storms. | Route through `request()`, share in-flight promise. |
| `api/index.ts:1899-2204` hand-rolled validators | drift | Medium | `practices.list` *silently filters out* rows failing a partial `typeof` guard → a field rename makes practices vanish with no error. | Replace with Zod; surface errors. |
| `api/index.ts:826-827` + `types.ts` | stale codegen | Medium | Generated `types.ts` knows 5 endpoints + a 4-field `Habit`; deprecated exports derive from it. | Regenerate or delete. |
| `store/useHabitStore.ts:118`, `useStageStore.ts:122` | unbounded caches | Lower | Module-level selector caches never cleared on reset/logout. | Evict on reset. |

## 8. Findings — UX states, accessibility & error copy (§5.2)

| file:line | class | severity | impact | fix |
|---|---|---|---|---|
| `Habits/HabitsScreen.tsx:654-700` | a11y | **High** | No `accessibilityLabel`/`Role` on overflow menu, pagination, mode bar, energy CTA. | Label all interactive chrome. |
| `Practice/*` (full-screen surfaces) | safe-area | **High** | Zero `SafeAreaView`/insets across the feature; wizard/catalog/detail collide with notch/home indicator. | Add safe-area handling. |
| `Course/CourseScreen.tsx:53-143` | error masking | Medium | Fetch failure → permanent "Loading…" + "No Content Yet"; no error/retry. | Add error + retry states. |
| `Map/MapScreen.tsx:482,304-320` | error recovery | High | Refresh failure with stages present is swallowed; history fetch error looks identical to "no history"; no retry. | Add retry affordances. |
| `components/FeatureErrorBoundary.tsx:108` | leaks internals | Medium | Renders raw `error.message` in prod (sibling boundary gates behind `__DEV__`). | Gate behind `__DEV__`. |
| `components/ToastProvider.tsx:115-122` | safe-area | Medium | Toast `top:60` magic constant ignores insets. | Use safe-area insets. |
| `Habits/HabitsScreen.tsx:567-590` | empty state | Medium | Zero-habit user sees a blank screen (Journal has a real empty state). | Add an empty state. |
| Auth screens (all 6) | keyboard / duplicated styles | Lower | No `KeyboardAvoidingView`/`SafeAreaView`; container/input/button styles copy-pasted 6×; signup vs login email canonicalization asymmetric. | Shared `auth.styles.ts`, keyboard handling, consistent lowercasing. |

## 9. Findings — CI, infra, docs truth & test quality (§5.4)

| file:line | class | severity | impact | fix |
|---|---|---|---|---|
| `claude.yml:46,52`, `claude-code-review.yml:30,36` | supply-chain | **Critical** | 4 `uses:` on mutable tags with `write` perms + OIDC; violates AGENTS.md §6. | SHA-pin all four. |
| `tests/services/test_streaks.py:222` | time-coupled test | **Critical** | Fails outside a date window → baseline suite is red today. | Freeze/inject "now". |
| `DEPLOYMENT.md:271-326` | docs drift (dangerous) | **High** | Claims Alembic "not yet configured / migrations empty" — false; CI gates on `alembic upgrade head` over 10+ migrations. An operator following it would clobber the real setup. | Rewrite the Alembic section. |
| `iteration-trigger.yml:16` | dead workflow | **High** | Listens for `workflows: ["CI"]`; actual names are `Backend CI`/`Frontend CI` → never fires. | Fix the name match. |
| `backend-ci.yml:62` | non-gating gate | **High** | `pytest … 2>/dev/null || true` swallows crashes; branch gate parses stale coverage. | Remove `|| true`, fail loudly. |
| `tests/test_models.py:35-56` | test that doesn't test | **High** | 3 tests over 23 models assert only "is a class / has name / count>0" — survives almost any model mutation. | Assert fields, constraints, nullability. |
| `services/botmason.py:867,916` | hollow coverage | High | Real LLM streaming paths carry `# pragma: no cover`; ship untested. | Cover with mocked transport. |
| `README.md:39`, `CLAUDE.md` arch block, `scripts/README.md:20`, `AGENTS.md:6` | docs drift | Medium | Node/Python versions stale; "14 models" (really 23); `format.sh` "black+isort" (now ruff); `/scripts/...` absolute path wrong. | Correct each claim. |
| `backend-ci.yml` (all jobs) | no dep cache | Medium | No uv/pip caching; every job reinstalls from scratch (frontend caches npm). | Add caching. |
| `OnboardingModal.step2.test.tsx:50` | hollow snapshot | Medium | `toMatchSnapshot()` on a style object as sole assertion. | Assert behavior. |
| `npm audit` | dependency CVEs | Medium | 36 advisories (1 critical, 18 high) in the frontend tree. | Triage via `cve-remediation`. |
| `RECOVERY-RUNBOOK.md:181-184` | untested runbook | Lower | REPL snippet references `select` without importing it → `NameError`. | Fix the snippet. |

## 10. What is genuinely solid (do not "fix")

- **Backend correctness core:** `services/wallet.py`, `services/chat_idempotency.py` (single-statement atomic SQL with audit rows in-transaction, TTL-evicted tombstones); `dependencies/ownership.py` (consistent 404→403 splits); anti-enumeration masking; parameterized queries with LIKE-escaping; sanitized 500 envelope that never leaks tracebacks; `security/text_sanitize.py` (Trojan-Source-safe).
- **`backend/conftest.py`** — finally-based teardown, dependency-override leak assertion, SQLite mirrors of prod partial/functional indexes so IntegrityError paths are actually exercised.
- **`migration-drift` + `content-drift` CI jobs** — rigorous; round-trip both merge parents, run `alembic check`, and gate content sync.
- **Frontend data-layer core:** `request()` retry/backoff/timeout/AbortController, 401-refresh-then-retry, SSE CRLF parsing, idempotency keys; narrow Zustand selectors; memoized contexts; serialized AsyncStorage writes; logout reset registry.
- **Practice engine:** `useRitualEngine`/`reducer` wall-clock-anchored timing, interval/audio/keep-awake cleanup, native-driver animation, exhaustive mapped-type dispatch.
- **Journal feature** is the frontend gold standard (stable `keyExtractor`, `getItemLayout`, windowing, full loading/empty/error/retry, a11y labels) — most Habits "High" findings are just "do what Journal already does."

---

## 11. How this maps to the backlog (Phase B)

Findings convert to **8 new epics** (see `README.md` → "Audit Remediation Epics, 2026-06-24"):

| Epic slug | Theme | Drives findings from |
|---|---|---|
| `audit-async` | Backend async correctness & query perf | §3 |
| `audit-paginate` | Pagination & response contracts | §4 |
| `audit-render` | Frontend render cost & list virtualization | §5 |
| `audit-destub` | De-stub: make aspirational features real | §6 |
| `audit-contracts` | Data-layer contracts & schema drift | §7 |
| `audit-ux` | UX states, accessibility & error copy | §8 |
| `audit-ci` | CI, infra & docs truth | §9 (CI/docs) |
| `audit-testq` | Test quality & baseline green | §9 (tests) |

Every issue traces back to a row above. Critical/High findings are front-loaded. The first issue to land
is `audit-testq-01` (un-flake the streak test) so the stay-green baseline is real before anything else.
