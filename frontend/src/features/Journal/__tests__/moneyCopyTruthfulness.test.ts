import { describe, expect, it } from '@jest/globals';

import { essayExplainerCost, resonanceExplainerCost } from '../resonanceExplainerCopy';

import {
  AI_ACCESS_REVOKED_COPY,
  INSUFFICIENT_OFFERINGS_COPY,
  LLM_KEY_REQUIRED_COPY,
} from '@/api/errorMessages';
import { NO_KEY_HINT, REMOVE_KEY_DIALOG_BODY } from '@/features/Settings/byokOnlyCopy';

describe('owner-approved money copy (#3262)', () => {
  it('updates only the three vault-letter clauses and keeps the other approved strings', () => {
    expect(INSUFFICIENT_OFFERINGS_COPY).toBe(
      "You're out of BotMason credits, so nothing was charged. Credits pay for readings and letters your vault answers; page reading needs your own OpenAI or Anthropic API key, which you can add in Settings.",
    );
    expect(LLM_KEY_REQUIRED_COPY).toBe(
      "BotMason's cloud AI needs an API key of your own — credits don't pay for it — so nothing was charged. Add your OpenAI or Anthropic key in Settings to continue.",
    );
    expect(AI_ACCESS_REVOKED_COPY).toBe(
      "BotMason can't do this on the app's allowance any more, because this account's APTITUDE membership is no longer active. Nothing was charged. Your journal, the course, your habits and your practice are all still here, and you can export or delete your data whenever you like.",
    );
    expect(NO_KEY_HINT).toBe(
      "No key saved yet. BotMason's cloud AI features — resonance notes, letters, completion checks and page reading — need a key of your own, and credits don't pay for them. Resonance notes and letters can still come from your vault if you have one.",
    );
    expect(REMOVE_KEY_DIALOG_BODY).toBe(
      "Without your own key, BotMason's cloud AI features — resonance notes, letters, completion checks and page reading — stop until you add one again. Resonance notes and letters can still come from your vault if you have one. Your journal itself is unaffected.",
    );
  });

  it('leads a keyless non-vault reading with the key requirement and no credit price', () => {
    const copy = resonanceExplainerCost(false, 20, 12, 3);
    expect(copy).toMatch(/^This needs your own API key/u);
    expect(copy).not.toMatch(/BotMason|spends|offering/u);
  });

  it.each([
    [20, 12, 3],
    [20, 0, 0],
    [null, null, null],
  ])('never prices a keyless letter from credits (%s/%s/%s)', (cap, remaining, offerings) => {
    const copy = essayExplainerCost(false, cap, remaining, offerings);
    expect(copy).toMatch(/^This needs your own API key/u);
    expect(copy).not.toMatch(/BotMason|spends|offering/u);
  });

  it.each([false, true])(
    'prices a vault-bound reading from credits even with own key=%s (#3281)',
    (hasKey) => {
      const copy = resonanceExplainerCost(hasKey, 20, 12, 3, 'reading', true);
      expect(copy).toBe('This reading spends one of your 20 BotMason messages for the month.');
      expect(copy).not.toMatch(/key pays|pays instead/u);
    },
  );

  it('preserves the own-key reading and letter prices', () => {
    expect(resonanceExplainerCost(true, null)).toBe(
      'Your own API key pays for this reading. Nothing is drawn from your BotMason messages.',
    );
    expect(essayExplainerCost(true, null)).toBe(
      'Your own API key pays for this letter. Nothing is drawn from your BotMason messages.',
    );
  });
});
