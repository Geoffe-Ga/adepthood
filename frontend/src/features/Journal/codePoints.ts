/**
 * Bridge between the two ways JavaScript counts string positions and the one the
 * anchor API uses.
 *
 * A React Native ``TextInput`` reports its selection in UTF-16 code units, but
 * the promoted-quote / marginalia anchor contract is defined in Unicode CODE
 * POINTS (matching the code-point-native backend). Those two agree for BMP text
 * yet drift by one unit per astral character (emoji, rare CJK): a single leading
 * emoji shifts every later UTF-16 offset by +1 versus its code-point index. This
 * helper is the single place that reconciles them.
 *
 * There are exactly TWO coordinate spaces in the journal, not three. The
 * code-point offset counted here IS the canonical Markdown source position used
 * by ``journalMarkdown.ts`` (which indexes off ``Array.from(body)``) and IS the
 * unit of the marginalia / promoted-quote anchor API (``highlightSegments.ts``
 * slices the same ``Array.from(body)``, and the backend slices a Python ``str``).
 * ``journalMarkdown.ts`` re-exports this pair as ``utf16ToSource`` /
 * ``sourceToUtf16`` so the editor model speaks one vocabulary without a second
 * implementation.
 *
 * The two directions are NOT mutual inverses, deliberately:
 *
 * - ``utf16ToCodePoint(t, codePointToUtf16(t, cp)) === cp`` exactly, for every
 *   code-point index — the pair is an exact RIGHT INVERSE.
 * - ``codePointToUtf16(t, utf16ToCodePoint(t, i))`` is an idempotent SNAP
 *   FORWARD: the identity on every index that is not inside a surrogate pair,
 *   and the end of the pair for one that is. It cannot be the identity because
 *   ``utf16ToCodePoint`` is non-injective at a mid-surrogate index by design
 *   (it counts the lone surrogate as one element, per ``slice(0, i)``), so a
 *   mid-pair index and the index just after the pair share one code-point
 *   answer. Relying on a mutual bijection here would be wrong.
 */

/**
 * Count the Unicode code points in ``text.slice(0, utf16Index)``.
 *
 * The result is the code-point offset that corresponds to a UTF-16 selection
 * boundary. A negative index clamps to 0; an index at or past the end clamps to
 * the string's code-point length; a mid-surrogate index counts the lone
 * surrogate as one element (exactly per the ``slice(0, i)`` definition). Never
 * throws.
 */
export function utf16ToCodePoint(text: string, utf16Index: number): number {
  const bounded = Math.max(0, Math.min(utf16Index, text.length));
  return Array.from(text.slice(0, bounded)).length;
}

/**
 * Length in UTF-16 code units of the first ``codePointIndex`` code points.
 *
 * The inverse direction of {@link utf16ToCodePoint}: it turns a canonical source
 * position (or an anchor offset, the same number) back into the UTF-16 index a
 * ``TextInput`` selection speaks. A negative index clamps to 0; an index at or
 * past the end clamps to ``text.length``. Never throws.
 */
export function codePointToUtf16(text: string, codePointIndex: number): number {
  const points = Array.from(text);
  const bounded = Math.max(0, Math.min(codePointIndex, points.length));
  return points.slice(0, bounded).join('').length;
}
