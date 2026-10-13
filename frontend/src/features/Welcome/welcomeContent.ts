// Editorial copy for the program welcome (issue #836). Kept as data so the
// WelcomeScreen stays a thin composition of ShowcaseCard heroes.

export interface WelcomePillar {
  glyph: string;
  name: string;
}

export interface WelcomePanel {
  eyebrow: string;
  title: string;
  body: string;
  pillars?: readonly WelcomePillar[];
  /** Optional privacy reassurance rendered inline beneath the panel body. */
  note?: string;
}

/**
 * Onboarding privacy promise, surfaced inline on the Five-pillars panel so the
 * "you choose your depth" ethos is visible before any entry is written — no
 * extra panel, no gate.
 */
const WELCOME_PRIVACY_NOTE =
  'Your journal is yours — you choose each entry’s privacy, and anything you mark Intimate never leaves for AI.';

/** The five APTITUDE pillars introduced on the second panel. */
export const WELCOME_PILLARS: readonly WelcomePillar[] = [
  { glyph: '🌱', name: 'Habits' },
  { glyph: '🪷', name: 'Practice' },
  { glyph: '📖', name: 'Course' },
  { glyph: '✒️', name: 'Journal' },
  { glyph: '🧭', name: 'Map' },
];

/** The four swipeable editorial panels, in order. */
export const WELCOME_PANELS: readonly WelcomePanel[] = [
  {
    eyebrow: 'Welcome',
    title: 'Begin the 36-week journey',
    body: 'APTITUDE gives you a place to hear your own words again and ten capacities to practice in daily life. The course runs over thirty-six weeks, slowly enough to make room for living. Take the time you need; the course stays here.',
  },
  {
    eyebrow: 'Five pillars',
    title: 'How the work holds together',
    body: 'Your journal keeps words you can return to for counsel. The other pillars give you ways to put that counsel to work. Choose the parts that serve your days.',
    pillars: WELCOME_PILLARS,
    note: WELCOME_PRIVACY_NOTE,
  },
  {
    eyebrow: 'A week, lived',
    title: 'How a week works',
    body: 'A habit can begin with one minute a day, kept for three weeks. The practice grows from one breath to longer sittings, and the readings give each capacity a name and something to try. Your journal keeps what you notice; the Map lays out the ten capacities and their course stages.',
  },
  {
    eyebrow: 'Ready',
    title: 'Let’s begin',
    body: 'Press Begin to land on your Journal, your daily home, and put a first thought on the page. Your journal can be the whole practice. To explore habits, the Habits tab offers one small habit, one minute a day, kept for three weeks. You choose your depth.',
  },
] as const;
