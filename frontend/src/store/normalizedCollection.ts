/**
 * Normalized-collection helper — the canonical `byId` + `order` + derived-list
 * pattern shared by the habit and stage stores.
 *
 * Each store keeps an ID-keyed map (`byId`) as its source of truth for O(1)
 * lookups, an `order` array of keys that preserves the caller-supplied array
 * order, and a derived `list` cache so consumers can iterate without rebuilding
 * on every render. This factory centralizes the two operations both stores
 * hand-rolled: `normalize` turns a caller array into that triple, and `rebuild`
 * projects `order` back through `byId` into a fresh list.
 *
 * Ordering always follows the caller-supplied array — ascending, descending, or
 * arbitrary — because `order` is populated by iterating `items` as given. The
 * callers adapt the generic field names (`byId`/`order`/`list`) onto their own
 * domain field names.
 */

/** The normalized triple: ID-keyed map, key order, and derived list view. */
export interface NormalizedById<T> {
  /** ID-keyed map — the canonical source of truth for per-item lookups. */
  byId: Record<number, T>;
  /** Keys in caller-supplied order; duplicates are preserved. */
  order: number[];
  /** Derived array view of the items in `order`. */
  list: T[];
}

/** Operations bound to a single `keyOf` extractor. */
export interface NormalizedByIdFactory<T> {
  normalize: (_items: T[]) => NormalizedById<T>;
  rebuild: (_byId: Record<number, T>, _order: number[]) => T[];
}

/**
 * Build normalize/rebuild bound to a key extractor. `normalize` iterates items
 * in order (last-item-wins on duplicate keys, duplicate keys kept in `order`);
 * `rebuild` projects `order` through `byId`, dropping keys absent from the map.
 */
export const createNormalizedById = <T>(keyOf: (_item: T) => number): NormalizedByIdFactory<T> => {
  const normalize = (items: T[]): NormalizedById<T> => {
    const byId: Record<number, T> = {};
    const order: number[] = [];
    for (const item of items) {
      const key = keyOf(item);
      byId[key] = item;
      order.push(key);
    }
    return { byId, order, list: [...items] };
  };

  const rebuild = (byId: Record<number, T>, order: number[]): T[] =>
    order.map((key) => byId[key]).filter((item): item is T => item !== undefined);

  return { normalize, rebuild };
};
