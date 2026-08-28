/**
 * Which store rows may address a server row.
 *
 * The store cannot infer provenance from an id's *shape*, because a
 * client-minted id is byte-identical to a server-issued one: onboarding's
 * scaffold rows mint habit ids `1..n` and goal ids `1..3n` — positive integers
 * squarely inside the range the server itself issues — and hold them for the
 * whole window between the optimistic write and the trailing reload. So
 * provenance is carried explicitly, as `hasClientMintedIds`, rather than
 * guessed from the number.
 *
 * That marker is a THIRD concept, distinct from `isDemoSeed`, because the two
 * gate different things. A demo tile is fabricated content that must never
 * reach the on-disk cache, where the next launch would read it back as real
 * data. A client-minted row is the user's own habit — only its ids are
 * provisional — so it must reach the cache, and `persistHabits` therefore
 * filters on the demo marker alone. What the client-minted marker gates is the
 * wire: an id this device invented names nobody's row, or worse, somebody
 * else's.
 *
 * A `Goal` carries no marker of its own, so `isServerBackedGoal` takes the
 * parent habit and reads both markers from there.
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
 * Whether this id names a row the store can find, whoever minted it. Local,
 * id-keyed actions -- a backfill, a start-date reset -- are offered on
 * client-minted rows too, so they ask this rather than `isServerIssuedId`: a
 * pre-sync row's negative placeholder still matches its own row. Only `0` and a
 * missing id name nothing at all, and acting on those would dismiss a modal
 * having done nothing.
 */
export const namesStoreRow = (id: number | null | undefined): id is number =>
  typeof id === 'number' && Number.isInteger(id) && id !== 0;

/**
 * Demo tiles are in-memory placeholders: their ids and start dates are
 * fabricated, so they must never reach the cache on disk (where the next
 * launch would read them back as real data) nor the server.
 */
export const isNotDemoSeed = (habit: { isDemoSeed?: boolean }): boolean =>
  habit.isDemoSeed !== true;

/**
 * Whether this row's ids came from the server rather than this device. Absent
 * defaults to "server-issued", so a row cached by a build predating the marker
 * is not retroactively condemned: the id-shape half still rejects the negative
 * placeholders, and the 404 `goal_not_found` recovery still catches the rest.
 */
export const hasServerIssuedIds = (habit: { hasClientMintedIds?: boolean }): boolean =>
  habit.hasClientMintedIds !== true;

/**
 * Whether this habit names a row the API can act on: not a demo placeholder,
 * not minted on this device, and carrying an id of the shape the server issues.
 * Accepts the `undefined` a `.find` can return, and narrows so the caller's
 * `habit.id` typechecks as `number`.
 */
export const isServerBackedHabit = <
  T extends { id?: number | null; isDemoSeed?: boolean; hasClientMintedIds?: boolean },
>(
  habit: T | null | undefined,
): habit is T =>
  habit !== null &&
  habit !== undefined &&
  isNotDemoSeed(habit) &&
  hasServerIssuedIds(habit) &&
  isServerIssuedId(habit.id);

/**
 * Whether this goal names a row the API can act on. The goal supplies the id
 * half; its parent habit supplies the provenance half, because a `Goal` has
 * neither marker of its own and so cannot tell a demo tile's goal 1, or an
 * onboarding scaffold's goal 7, from a real one. A missing parent fails closed.
 */
export const isServerBackedGoal = <G extends { id?: number | null }>(
  goal: G,
  parent:
    { id?: number | null; isDemoSeed?: boolean; hasClientMintedIds?: boolean } | null | undefined,
): goal is G & { id: number } => isServerBackedHabit(parent) && isServerIssuedId(goal.id);

/**
 * This row's id was minted on this device, so there is nothing on the server to
 * post against and the store must resync. A *local* signal that replaces the
 * server round-trip the 404 `goal_not_found` used to supply.
 */
export class ClientMintedIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientMintedIdError';
  }
}
