import { describe, expect, it } from '@jest/globals';

import {
  ESSAY_ASK_WHAT,
  RESONANCE_EXPLAINER_WHAT,
  essayExplainerCost,
  resonanceExplainerCost,
} from '../resonanceExplainerCopy';

/**
 * The price line for both charged journal depths (#623).
 *
 * One function words both prices, so the reading's copy must come out
 * byte-identical to what shipped before letters were priced, and the letter's
 * must differ from it only in the noun. The expected strings are hand-written,
 * never built from the module's own constants: a test that read the same
 * constant the screen renders would prove only that a string equals itself.
 */
const ADD_KEY = 'Add your own API key in Settings and it pays instead.';

/** A price line's arguments: payer, cap, then the optional wallet snapshot. */
type CostArgs = [boolean, number | null, (number | null)?, (number | null)?];
type CostCase = [string, CostArgs, string];

describe('resonanceExplainerCost keeps the reading’s shipped wording', () => {
  it.each<CostCase>([
    [
      'the caller’s own key',
      [true, null],
      'Your own API key pays for this reading. Nothing is drawn from your BotMason messages.',
    ],
    [
      'an empty wallet',
      [false, 20, 0, 0],
      `You have no BotMason monthly messages or offerings available for this reading. ${ADD_KEY}`,
    ],
    [
      'a spent month with offerings left',
      [false, 20, 0, 3],
      `This reading spends one BotMason offering. ${ADD_KEY}`,
    ],
    [
      'the monthly allowance',
      [false, 20, 12, 0],
      `This reading spends one of your 20 BotMason messages for the month. ${ADD_KEY}`,
    ],
    [
      'an unknown allowance',
      [false, null],
      `This reading spends one BotMason message from your account. ${ADD_KEY}`,
    ],
  ])('for %s', (_case, args, expected) => {
    expect(resonanceExplainerCost(...args)).toBe(expected);
  });
});

describe('essayExplainerCost prices a letter from the same wallet', () => {
  it.each<CostCase>([
    [
      'the caller’s own key',
      [true, null],
      'Your own API key pays for this letter. Nothing is drawn from your BotMason messages.',
    ],
    [
      'an empty wallet',
      [false, 20, 0, 0],
      `You have no BotMason monthly messages or offerings available for this letter. ${ADD_KEY}`,
    ],
    [
      'a spent month with offerings left',
      [false, 20, 0, 3],
      `This letter spends one BotMason offering. ${ADD_KEY}`,
    ],
    [
      'the monthly allowance',
      [false, 20, 12, 0],
      `This letter spends one of your 20 BotMason messages for the month. ${ADD_KEY}`,
    ],
    [
      'an unknown allowance',
      [false, null],
      `This letter spends one BotMason message from your account. ${ADD_KEY}`,
    ],
  ])('for %s', (_case, args, expected) => {
    expect(essayExplainerCost(...args)).toBe(expected);
  });
});

describe('ESSAY_ASK_WHAT names everything a letter sends to the model', () => {
  // The letter's prompt carries the entry body, the margin note itself, and
  // truncated excerpts of the writer's earlier letters as anti-repetition
  // context (`_prior_letter_essays`). The offer must not undersell that.
  it('discloses the entry, the margin note, and excerpts of earlier letters', () => {
    expect(ESSAY_ASK_WHAT).toBe(
      'A letter expands this margin note into a longer reflection. To write it, the text of this entry, this margin note, and short excerpts of your earlier letters are sent to an AI model.',
    );
  });
});

describe('RESONANCE_EXPLAINER_WHAT names everything a reading sends to the model', () => {
  // A pass sends the most to the app's AI model provider when no vault is
  // connected (since #3061 a vault-bound pass never falls back to it), so the
  // copy states that maximum (#2998). The reflection prompt (`build_prompt`)
  // carries the entry in <entry>, up to GROUNDING_LIMIT (3, the privacy
  // policy's "up to three") pieces of the writer's own writing in <prior> --
  // corpus fragments from `gather_grounding`, which may be uploaded or
  // imported documents, else recent entries -- and excerpts of earlier
  // letters in <prior_letters> (`_prior_letter_essays`). Completion detection
  // (`build_detection_prompt`) sends the entry again with the names and units
  // of the writer's habits and practices.
  it('discloses the entry, other writing, letter excerpts, and habit and practice names', () => {
    expect(RESONANCE_EXPLAINER_WHAT).toBe(
      'Resonance reads this entry and leaves margin notes beside the passages it responds to. To do that, the text of this entry, up to three other pieces of your own writing, short excerpts of your earlier letters, and the names and units of your habits and practices are sent to an AI model.',
    );
  });
});
