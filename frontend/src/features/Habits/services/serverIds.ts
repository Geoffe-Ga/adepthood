/**
 * Which store rows may address a server row.
 *
 * The habit store holds three families of id, and only one of them names a row
 * the API can answer for:
 *
 * 1. **Demo seed** — the offline placeholder tiles (`FALLBACK_HABITS`) carry
 *    hard-coded habit ids 1..10 and goal ids 1..30 and are marked
 *    `isDemoSeed: true`. Positive, plausible, and entirely fabricated.
 * 2. **Pre-sync added habits** — `buildAddedHabit` mints `-Date.now()` for the
 *    habit and `tempId - tierIndex - 1` for its goals, replaced only once the
 *    create round-trip and reload succeed. Negative and unmarked.
 * 3. **Server-issued** — positive integers the API actually assigned.
 *
 * Every guard in this feature used to be a truthiness test (`if (!x.id)
 * return`), which only ever rejects `0` and `undefined`. A negative placeholder
 * is truthy, and so is a demo tile's `3`, so those guards blocked neither
 * fabricated family: a `DELETE /habits/3` fired from a demo tile lands on the
 * caller's own real habit 3. Positivity alone is not enough either, because the
 * demo ids are positive; the demo marker alone is not enough either, because
 * the added-habit ids are unmarked. Both halves are required, which is why they
 * live together here as one shared predicate rather than being re-derived at
 * each call site.
 *
 * A `Goal` carries no demo marker of its own, so `isServerBackedGoal` takes the
 * parent habit and reads the marker from there.
 */

/**
 * A positive integer — the only shape a server-assigned id ever takes. Rejects
 * `0`, negatives (the pre-sync placeholders), non-integers, `NaN`, `Infinity`,
 * `undefined` and `null`. A type predicate so callers narrow an optional id to
 * `number` before putting it on the wire.
 */
export const isServerIssuedId = (id: number | null | undefined): id is number =>
  typeof id === 'number' && Number.isInteger(id) && id > 0;

/**
 * Demo tiles are in-memory placeholders: their ids and start dates are
 * fabricated, so they must never reach the cache on disk (where the next
 * launch would read them back as real data) nor the server.
 */
export const isNotDemoSeed = (habit: { isDemoSeed?: boolean }): boolean =>
  habit.isDemoSeed !== true;

/**
 * Whether this habit names a row the API can act on: not a demo placeholder,
 * and carrying an id the server issued. Accepts the `undefined` a `.find` can
 * return, and narrows so the caller's `habit.id` typechecks as `number`.
 */
export const isServerBackedHabit = <T extends { id?: number | null; isDemoSeed?: boolean }>(
  habit: T | null | undefined,
): habit is T =>
  habit !== null && habit !== undefined && isNotDemoSeed(habit) && isServerIssuedId(habit.id);

/**
 * Whether this goal names a row the API can act on. The goal supplies the id
 * half; its parent habit supplies the demo half, because a `Goal` has no
 * `isDemoSeed` marker of its own and so cannot tell a demo tile's goal 1 from a
 * real one. A missing parent fails closed.
 */
export const isServerBackedGoal = <G extends { id?: number | null }>(
  goal: G,
  parent: { id?: number | null; isDemoSeed?: boolean } | null | undefined,
): goal is G & { id: number } => isServerBackedHabit(parent) && isServerIssuedId(goal.id);
