/**
 * Single source of truth for the collapsed-row / entry-tile excerpt: a pure,
 * whitespace-flattening truncator shared by the journal shelf and the reflection
 * sources feed so both surfaces cut a body identically.
 *
 * Truncation counts Unicode CODE POINTS rather than UTF-16 units so an emoji or
 * other astral character straddling the cut is kept whole or dropped whole,
 * never sheared into a lone surrogate.
 */

/**
 * Flatten a body's whitespace, then truncate to ``maxLength`` code points with a
 * trailing ellipsis when it overflows.
 *
 * The fast path returns the flattened body untouched when its UTF-16 length is
 * within ``maxLength`` (a code-unit count that small guarantees an equal-or-lower
 * code-point count, so no astral char can push it over) — sparing the common
 * short body the ``Array.from`` allocation. Otherwise the body is materialised
 * into code points and a second guard returns it untouched when the CODE-POINT
 * count fits, so an astral-dense body that overflows in UTF-16 units yet fits in
 * code points is never given a misleading ellipsis. Only a genuine code-point
 * overflow is sliced — by CODE POINT: a fixed UTF-16 slice can split a surrogate
 * pair at the boundary and render the broken half as U+FFFD, whereas iterating
 * whole code points keeps the boundary character intact or excludes it entirely.
 * No ``Intl.Segmenter`` — its Hermes/React Native availability is unreliable,
 * which would make its branch an untestable dead path.
 */
export function excerpt(body: string, maxLength: number): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;
  const points = Array.from(flat);
  if (points.length <= maxLength) return flat;
  return `${points.slice(0, maxLength).join('').trimEnd()}…`;
}
