# Ritual Practice Screen — Epic Plan

> A "build-your-own ritual" practice surface: meditation timer, rep counter,
> metronome-with-timer, and configurable interval-bell clock — with 10 stage-aligned
> presets, per-user customization, post-session insight capture, and a BotMason
> journaling deep-link.

This epic supersedes the original `phase-3-09-practice-screen.md` once delivered.
Each sub-issue is atomized to **≤ 700 LoC of net change** (code + tests + docs)
so the stay-green workflow remains tractable.

## Vision

The Practice screen is currently a single-mode countdown timer with a fixed
catalog. The product spec calls for a **ritual workshop**: users craft their
own practice from primitives (timer, metronome, interval bells, rep counter,
sense-grounding prompts, card meditations) while the app ships 10 opinionated
**presets** that activate as the user advances through the 36-week course
(roughly one new preset every three weeks, aligned to the 10 APTITUDE stages).

Only one practice is displayed at any time. A frequency banner contextualises
the current stage, e.g.

> "You are in the **Orange** frequency of APTITUDE. That means you are working
> on **Mind**. Your practice is **Concentration practice** but you are
> encouraged to replace it if another tradition has a practice that deals
> with **Mind** that calls to you more."

After every session the user can capture insights and tap through to BotMason
to journal — sessions and insights flow back into analytics rollups.

## Stage → Preset Map

| Stage | Color        | Aspect  | Default Preset                 | Mode                       | Default Duration |
|-------|--------------|---------|--------------------------------|----------------------------|------------------|
| 1     | Beige        | Body    | 5-4-3-2-1 grounding            | `sense_grounding`          | n/a (5 prompts)  |
| 2     | Purple       | Body    | Tarot meditation (Major Arcana)| `tarot`                    | 5 min            |
| 3     | Red          | Emotion | Belly breathing                | `meditation_timer`         | 10 min           |
| 4     | Blue         | Emotion | Metta (loving-kindness)        | `meditation_timer`         | 15 min           |
| 5     | Orange       | Mind    | Wim Hof method                 | `meditation_timer`         | 20 min           |
| 6     | Green        | Mind    | Shadow work                    | `meditation_timer + metronome` | 30 min       |
| 7     | Yellow       | Spirit  | Blissy meditation              | `meditation_timer`         | 45 min           |
| 8     | Turquoise    | Spirit  | Dog Walkin' Shamanism          | `count_up`                 | open (no target) |
| 9     | Ultraviolet  | Nondual | Concentration practice         | `meditation_timer`         | 45 min           |
| 10    | Clear Light  | Nondual | Insight practice               | `meditation_timer`         | 45 min           |

Every preset is **replaceable**: users can swap in any approved practice for
the current stage, or submit their own (existing flow, `POST /practices/`).

## Issue Index

### Backend (data + API)
| #  | File | Scope | Est. LoC |
|----|------|-------|----------|
| 01 | [Practice modes + mode_config schema](ritual-01-practice-modes-schema.md)        | Backend | ~400 |
| 02 | [Seed 10 preset practices](ritual-02-seed-preset-practices.md)                   | Backend | ~300 |
| 03 | [User-practice customization (overrides)](ritual-03-user-practice-customization.md) | Backend | ~400 |
| 04 | [Session analytics + insights](ritual-04-session-analytics-insights.md)          | Backend | ~500 |
| 05 | [Frequency / aspect copy endpoint](ritual-05-frequency-copy-endpoint.md)         | Backend | ~250 |

### Frontend (engine + UI)
| #  | File | Scope | Est. LoC |
|----|------|-------|----------|
| 06 | [useRitualEngine hook (state machine)](ritual-06-ritual-engine-hook.md)          | Frontend | ~600 |
| 07 | [Mode view primitives](ritual-07-mode-views.md)                                  | Frontend | ~600 |
| 08 | [Preset views: 5-4-3-2-1 + Tarot](ritual-08-preset-views.md)                     | Frontend | ~500 |
| 09 | [Ritual configurator UI](ritual-09-ritual-configurator.md)                       | Frontend | ~600 |
| 10 | [Frequency banner + practice switcher](ritual-10-frequency-banner-switcher.md)   | Frontend | ~400 |
| 11 | [PracticeScreen integration](ritual-11-screen-integration.md)                    | Frontend | ~500 |
| 12 | [Post-session insight + BotMason CTA](ritual-12-post-session-insight-botmason.md) | Frontend | ~300 |

## Dependency Graph

```
ritual-01 (modes schema)
  ├── ritual-02 (seed presets)
  ├── ritual-03 (user customization)
  └── ritual-04 (session analytics)
        └── ritual-12 (insight capture + BotMason)

ritual-05 (frequency copy)  ── ritual-10 (banner)

ritual-06 (engine hook)
  ├── ritual-07 (mode views)
  ├── ritual-08 (preset views)
  └── ritual-09 (configurator)

ritual-07, ritual-08, ritual-09, ritual-10 ── ritual-11 (screen integration)
                                                    └── ritual-12
```

The two halves can land in parallel. Backend lands first if a single agent
picks up the epic; frontend can be developed against in-memory mocks of the
new endpoints once the schemas are agreed in `ritual-01`.

## Cross-Cutting Quality Gates

Every issue must:

1. **Stay green** — `pre-commit run --all-files` clean before commit, full test
   suite + coverage gates green before push.
2. **Hit coverage thresholds** — backend 90% line / 80% branch, frontend Jest
   coverage at the project default. New modules ship with their own tests in
   the same PR.
3. **Stay under 700 net LoC** — if a sub-issue grows past the budget, split
   along the seam noted in its "If you blow the budget" section before
   committing.
4. **Avoid suppressions** — no new `# noqa`, `# type: ignore`, `// @ts-ignore`,
   `// eslint-disable`, or `any` types. Refactor instead.
5. **TDD** — failing test first, watch it red, implement, watch it green.
6. **Conventional commits** — `feat(backend): …`, `feat(frontend): …`,
   `test(frontend): …` etc.

## Out of Scope (this epic)

- Audio asset bundling / licensing for bell + metronome sounds. The engine
  exposes injectable audio adapters; ritual-07 ships a stub adapter and an
  expo-av implementation that loads existing assets if present, otherwise
  no-ops with a logged warning. A separate "audio production" task can fill
  in licensed cues.
- Background-mode timers (lock-screen continuation). The current
  `expo-keep-awake` keeps the screen on; true background scheduling is
  deferred.
- Push notifications for "time to practice" reminders — handled by the
  existing notifications backlog (phase-4-04).
- Social / sharing of insights. Captured insights are private to the user
  and the BotMason context.
