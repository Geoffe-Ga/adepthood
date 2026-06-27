# journal-resonance-20: Resonance economy & essay pricing (deferred)

**Labels:** `blocked`, `enhancement`, `full-stack`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-05](journal-resonance-05-resonance-endpoints.md), [journal-resonance-06](journal-resonance-06-essay-endpoint.md)
**Estimated LoC:** ~150

> **Status: blocked — awaiting an operator pricing decision.** This issue is
> intentionally **not** Ralph-eligible (the `blocked` label keeps it out of the
> picker). It captures the deferred economy decision so it isn't lost. Remove the
> `blocked` label once the pricing model below is chosen.

## Role

You are a full-stack engineer finalizing how AI resonance maps onto the existing
wallet (monthly free messages + paid "offerings").

## Goal

Decide and implement the pricing for resonance passes and essay expansions. The
epic shipped with a sensible default (**one pass = one wallet unit; essays free**)
behind clearly-marked seams; this issue replaces that default with the chosen model.

## Open decision (needs operator input)

Pick one:
1. **One pass = one charge; essays free** (current default — possibly just keep it
   and close this issue).
2. **Pass cheap/free; each essay (or first essay per pass) charges** — meter the
   `POST .../essay` seam left in issue 06.
3. **Tiered**: N free passes/month, then offerings; essays bundled with their pass.

Surface the trade-offs (cost exposure vs. exploration friction) and confirm with
the operator before building.

## Tasks (once decided)

1. Implement the charge at the seams left by issues 05 (pass) and 06 (essay).
2. Reflect remaining balances in `ResonanceResponse` / essay responses and the
   frontend's gentle "resting" messaging.
3. Add a config knob (env or settings) for free-pass allotment if the tiered model
   is chosen.
4. Tests for: charge applied/skipped per the chosen model; `402` when exhausted;
   no double-charge; balances surfaced to the client.

## Acceptance Criteria

- [ ] The chosen pricing model is implemented at the existing seams (no new
      billing system).
- [ ] Wallet exhaustion degrades gracefully (gentle messaging, no crash).
- [ ] `./scripts/backend/check-all.sh` + `./scripts/frontend/check-all.sh` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/routers/journal.py` (or `routers/resonance.py`) | Modify |
| `backend/src/domain/resonance.py` | Possibly modify |
| `frontend/src/features/Journal/useResonance.ts` | Possibly modify |
| relevant tests | Modify |

## Constraints

- Reuse the existing wallet; do not introduce a parallel billing path.
- Keep changes localized to the seams the epic deliberately left open.
- Do not start until the pricing decision is made (remove `blocked` first).
