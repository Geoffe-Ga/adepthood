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
