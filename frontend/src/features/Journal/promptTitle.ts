// Mirrors backend/src/domain/weekly_prompts.py — keep the band table in sync.

// Archetypal Wavelength band labels in developmental order; each band spans
// WEEKS_PER_BAND consecutive weeks, tiling the 36-week program exactly.
const PROMPT_BANDS: readonly string[] = [
  'Beige',
  'Purple',
  'Red',
  'Blue',
  'Orange',
  'Green',
  'Yellow',
  'Turquoise',
  'Coral',
  'Teal',
  'Indigo',
  'Ultraviolet',
];

// Weeks per Wavelength band; three weeks each tile the 36-week program.
const WEEKS_PER_BAND = 3;

// Exactly one prompt per week, so the default title always reads "... Prompt #1".
const PROMPTS_PER_WEEK = 1;

const FIRST_WEEK = 1;
const TOTAL_WEEKS = PROMPT_BANDS.length * WEEKS_PER_BAND;

/**
 * The default journal title for a prompt week: the week's Wavelength band
 * label plus its position within that band, e.g. week 8 -> "Red week 2
 * Prompt #1". Callers pass valid route weeks; out-of-range input is clamped
 * to [1, TOTAL_WEEKS] so this is total and never throws.
 */
export function promptTitleForWeek(week: number): string {
  const clamped = Math.min(Math.max(Math.trunc(week), FIRST_WEEK), TOTAL_WEEKS);
  const band = PROMPT_BANDS[Math.trunc((clamped - 1) / WEEKS_PER_BAND)];
  const weekInBand = ((clamped - 1) % WEEKS_PER_BAND) + 1;
  return `${band} week ${weekInBand} Prompt #${PROMPTS_PER_WEEK}`;
}
