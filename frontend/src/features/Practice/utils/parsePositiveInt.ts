/**
 * Shared numeric-input parsing for practice forms (share-link limits, custom
 * durations). Number-pad fields still receive stray characters from paste and
 * autocorrect, so the parser is deliberately forgiving about non-digits.
 */

/** Strip every non-digit character, keeping the digits in order. */
function digitsOnly(raw: string): string {
  return raw.replaceAll(/\D/g, '');
}

/**
 * Parse the digits of ``raw`` as a positive base-10 integer, or ``null`` when
 * nothing usable remains. Non-digits are stripped first (so ``'10 min'`` and
 * ``'-5'`` yield ``10`` and ``5``); an empty result, or a value of zero,
 * returns ``null``.
 */
export function parsePositiveInt(raw: string): number | null {
  const digits = digitsOnly(raw);
  if (!digits) return null;
  const value = Number.parseInt(digits, 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}
