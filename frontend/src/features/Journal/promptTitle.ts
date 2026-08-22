import { STAGE_DURATIONS_DAYS } from '@/constants/program';
import { STAGE_ORDER } from '@/design/tokens';

// A prompt band *is* an APTITUDE stage, so the labels come from the one list
// of stages the app already keeps rather than a second copy typed here — a
// copy is what let three colours the ontology has never had, and a missing
// Clear Light, reach users' entry titles. The schedule comes from the program
// calendar for the same reason: there is no single weeks-per-band number,
// since eight stages run three weeks and the two integration stages run six.
const DAYS_PER_WEEK = 7;

// Exactly one prompt is offered per week, so the client's default names the
// first. Which of a stage's prompts a given week actually draws is decided
// server-side, from curriculum text the client never sees.
const PROMPTS_PER_WEEK = 1;

const FIRST_WEEK = 1;

// The default title of every program week, in order, week 1 at index 0. A
// stage with no scheduled duration contributes no weeks rather than a guessed
// length, so a truncated schedule shortens the program instead of inventing
// weeks for it.
const WEEK_TITLES: readonly string[] = STAGE_ORDER.flatMap((band, stage) => {
  const days = STAGE_DURATIONS_DAYS[stage];
  return days === undefined
    ? []
    : Array.from(
        { length: days / DAYS_PER_WEEK },
        (_, offset) => `${band} week ${offset + 1} Prompt #${PROMPTS_PER_WEEK}`,
      );
});

const TOTAL_WEEKS = WEEK_TITLES.length;

/**
 * The default journal title for a prompt week: the week's stage label plus its
 * position within that stage, e.g. week 23 -> "Teal week 2 Prompt #1".
 * Callers pass valid route weeks; out-of-range input is clamped to
 * [1, TOTAL_WEEKS] so this is total and never throws.
 */
export function promptTitleForWeek(week: number): string {
  const clamped = Math.min(Math.max(Math.trunc(week), FIRST_WEEK), TOTAL_WEEKS);
  return WEEK_TITLES[clamped - 1] ?? '';
}
