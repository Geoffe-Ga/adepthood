import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  AI_ACCESS_REVOKED_COPY,
  INSUFFICIENT_OFFERINGS_COPY,
  LLM_KEY_REQUIRED_COPY,
} from '../errorMessages';

import { NO_KEY_HINT, REMOVE_KEY_DIALOG_BODY } from '@/features/Settings/byokOnlyCopy';

/**
 * The five money strings the owner approved as written (#3262).
 *
 * Each is pinned by its exact text, written out here by hand, so a later edit
 * to any of them is a visible decision rather than a silent drift.
 */
describe('owner-approved money copy (#3262)', () => {
  it.each<[string, string, string]>([
    [
      'INSUFFICIENT_OFFERINGS_COPY',
      INSUFFICIENT_OFFERINGS_COPY,
      "You're out of BotMason credits, so nothing was charged. Credits pay for readings and letters your vault answers; page reading needs your own OpenAI or Anthropic API key, which you can add in Settings.",
    ],
    [
      'LLM_KEY_REQUIRED_COPY',
      LLM_KEY_REQUIRED_COPY,
      "BotMason's cloud AI needs an API key of your own — credits don't pay for it — so nothing was charged. Add your OpenAI or Anthropic key in Settings to continue.",
    ],
    [
      'AI_ACCESS_REVOKED_COPY',
      AI_ACCESS_REVOKED_COPY,
      "BotMason can't do this on the app's allowance any more, because this account's APTITUDE membership is no longer active. Nothing was charged. Your journal, the course, your habits and your practice are all still here, and you can export or delete your data whenever you like.",
    ],
    [
      'NO_KEY_HINT',
      NO_KEY_HINT,
      "No key saved yet. BotMason's cloud AI features — resonance notes, letters, completion checks and page reading — need a key of your own, and credits don't pay for them. Resonance notes and letters can still come from your vault if you have one.",
    ],
    [
      'REMOVE_KEY_DIALOG_BODY',
      REMOVE_KEY_DIALOG_BODY,
      "Without your own key, BotMason's cloud AI features — resonance notes, letters, completion checks and page reading — stop until you add one again. Resonance notes and letters can still come from your vault if you have one. Your journal itself is unaffected.",
    ],
  ])('%s reads exactly as approved', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

/** Where each approved string lives, relative to ``src``. */
const SOURCES: ReadonlyArray<[string, string]> = [
  ['api/errorMessages.ts', 'INSUFFICIENT_OFFERINGS_COPY'],
  ['api/errorMessages.ts', 'LLM_KEY_REQUIRED_COPY'],
  ['api/errorMessages.ts', 'AI_ACCESS_REVOKED_COPY'],
  ['features/Settings/byokOnlyCopy.ts', 'NO_KEY_HINT'],
  ['features/Settings/byokOnlyCopy.ts', 'REMOVE_KEY_DIALOG_BODY'],
];

const DRAFT_MARKER = /DRAFT|owner review/u;

/** The source between the previous export (or the file's start) and this one's. */
function leadingComment(relativePath: string, name: string): string {
  const source = readFileSync(join(__dirname, '..', '..', relativePath), 'utf8');
  const at = source.indexOf(`export const ${name} `);
  expect(at).toBeGreaterThan(-1);
  const previous = source.lastIndexOf('export ', at - 1);
  return source.slice(Math.max(previous, 0), at);
}

describe('the approved strings no longer carry a draft marker (#3262)', () => {
  it.each(SOURCES)('%s %s', (relativePath, name) => {
    expect(leadingComment(relativePath, name)).not.toMatch(DRAFT_MARKER);
  });
});
