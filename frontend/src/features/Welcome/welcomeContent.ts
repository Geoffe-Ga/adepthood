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
export const WELCOME_PRIVACY_NOTE =
  'Your journal is yours — you choose each entry’s privacy, and anything you mark Intimate never leaves for AI.';

/** The five APTITUDE pillars introduced on the second panel. */
export const WELCOME_PILLARS: readonly WelcomePillar[] = [
  { glyph: '🌱', name: 'Habits' },
  { glyph: '🪷', name: 'Practice' },
  { glyph: '📖', name: 'Course' },
  { glyph: '✒️', name: 'Journal' },
  { glyph: '🧭', name: 'Map' },
];

/** The 3–4 swipeable editorial panels, in order. */
export const WELCOME_PANELS: readonly WelcomePanel[] = [
  {
    eyebrow: 'Welcome',
    title: 'Begin the 36-week journey',
    body: 'APTITUDE is a slow, deliberate path of becoming. Take a breath — there is no rushing this work, and nothing here expires.',
  },
  {
    eyebrow: 'Five pillars',
    title: 'How the work holds together',
    body: 'Each week weaves the same five threads. Lean on whichever the day asks for.',
    pillars: WELCOME_PILLARS,
    note: WELCOME_PRIVACY_NOTE,
  },
  {
    eyebrow: 'A week, lived',
    title: 'How a week works',
    body: 'Plant a small habit, sit with a practice, read the week’s course, and reflect in your journal. The map shows how far you have come.',
  },
  {
    eyebrow: 'Ready',
    title: 'Let’s begin',
    body: 'Press Begin to land on Today, your daily home. From the Habits tab you can plant your first habits whenever you’re ready.',
  },
] as const;
