import { describe, expect, it } from '@jest/globals';

import { WELCOME_PANELS, WELCOME_PILLARS } from '../welcomeContent';

import { BANNED_PHRASES } from '@/testing/bannedInvitationPhrases';

const EXPECTED_BODIES = [
  'APTITUDE gives you a place to hear your own words again and ten capacities to practice in daily life. The course runs over thirty-six weeks, slowly enough to make room for living. Take the time you need; the course stays here.',
  'Your journal keeps words you can return to for counsel. The other pillars give you ways to put that counsel to work. Choose the parts that serve your days.',
  'Habits lets you name a habit and record your check-ins. Practice offers grounding exercises and timed sessions. The readings give each capacity a name and something to try. Your journal keeps what you notice; the Map lays out the ten capacities and their course stages.',
  'Press Begin to land on your Journal, your daily home, and put a first thought on the page. Your journal can be the whole practice. To explore habits, open the Habits tab to name a habit and record your check-ins. You choose your depth.',
] as const;

describe('Welcome copy — the honest case for the program (#3103)', () => {
  it('names a concrete gain on every panel without changing the four-panel structure', () => {
    expect(WELCOME_PANELS.map((panel) => panel.body)).toEqual(EXPECTED_BODIES);
    expect(WELCOME_PANELS[1]?.pillars).toBe(WELCOME_PILLARS);
    expect(WELCOME_PANELS[1]?.note).toBe(
      'Your journal is yours — you choose each entry’s privacy, and anything you mark Intimate never leaves for AI.',
    );
  });

  it('keeps the pace and names the floor and the available habit setup', () => {
    expect(WELCOME_PANELS[0]?.body).toContain('your own words');
    expect(WELCOME_PANELS[0]?.body).toContain('Take the time you need; the course stays here.');
    expect(WELCOME_PANELS[2]?.body).toContain('name a habit and record your check-ins');
    expect(WELCOME_PANELS[3]?.body).toContain('land on your Journal, your daily home');
  });

  it('offers habits as an independent choice and describes the visible Map', () => {
    expect(WELCOME_PANELS[2]?.body).toContain('Habits lets you name a habit');
    expect(WELCOME_PANELS[2]?.body).toContain('ten capacities and their course stages');
    expect(WELCOME_PANELS[2]?.body).not.toMatch(/\b(full|thin)\b/);
    expect(WELCOME_PANELS[3]?.body).toContain('Your journal can be the whole practice.');
    expect(WELCOME_PANELS[3]?.body).toContain('To explore habits');
    expect(WELCOME_PANELS[3]?.body).toContain('You choose your depth.');
  });

  it('describes the current catalog without promising unavailable starting presets', () => {
    expect(WELCOME_PANELS[2]?.body).toContain('grounding exercises and timed sessions');
    expect(WELCOME_PANELS[3]?.body).toContain('open the Habits tab to name a habit');
    const copy = WELCOME_PANELS.map((panel) => panel.body).join(' ');
    expect(copy).not.toMatch(/\bone minute\b|\bthree weeks\b|\bone breath\b/i);
  });

  it('never pressures the reader, hedges the offer away, or promises an unmeasured outcome', () => {
    const hedgesAndPromises = [
      'whenever you’re ready',
      "whenever you're ready",
      'if you like',
      'if it feels right',
      'no pressure',
      'transform',
      'healing',
      'enlightenment',
      'cure',
      'works for everyone',
    ];
    for (const panel of WELCOME_PANELS) {
      const body = panel.body.toLowerCase();
      for (const phrase of [...BANNED_PHRASES, ...hedgesAndPromises]) {
        expect(body).not.toContain(phrase);
      }
    }
  });
});
