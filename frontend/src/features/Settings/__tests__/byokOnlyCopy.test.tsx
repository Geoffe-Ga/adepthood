/* global describe, test, expect */
import * as fs from 'fs';
import * as path from 'path';

import { NO_KEY_HINT, REMOVE_KEY_DIALOG_BODY } from '../byokOnlyCopy';

import { INSUFFICIENT_OFFERINGS_COPY, LLM_KEY_REQUIRED_COPY } from '@/api/errorMessages';
import { REPO_ROOT, readBackendSource } from '@/testing/backendSource';

/**
 * ADR 0009 phase (a) (#3067): the server's own key no longer pays for anyone.
 *
 * Settings used to tell a writer without a key that BotMason "will use the
 * shared server key"; that fallback is gone, so the copy has to say what the
 * writer loses instead, in plain words, and must not promise a fallback the
 * server no longer has.
 */
const SETTINGS_DIR = path.join(REPO_ROOT, 'frontend', 'src', 'features', 'Settings');
const SERVER_KEY_FALLBACK = /\b(?:shared|server)(?:'s)?\s+(?:server\s+)?key\b/i;

function settingsSources(): string[] {
  return fs
    .readdirSync(SETTINGS_DIR)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => fs.readFileSync(path.join(SETTINGS_DIR, name), 'utf-8'));
}

describe('without a key of your own, Settings says what you lose', () => {
  test.each([
    ['no-key hint', NO_KEY_HINT],
    ['remove-key dialog', REMOVE_KEY_DIALOG_BODY],
    ['key-required refusal', LLM_KEY_REQUIRED_COPY],
  ])('%s offers no server-key fallback and points at Settings', (_name, copy) => {
    expect(copy).not.toMatch(SERVER_KEY_FALLBACK);
    expect(copy).toMatch(/key of your own|your own key|your own API key|API key of your own/i);
  });

  test('the hint and the dialog name the features that stop', () => {
    for (const copy of [NO_KEY_HINT, REMOVE_KEY_DIALOG_BODY]) {
      expect(copy).toMatch(/resonance notes/i);
      expect(copy).toMatch(/letters/i);
      expect(copy).toMatch(/completion checks/i);
      expect(copy).toMatch(/page reading/i);
    }
  });

  test('the vault exception covers notes and letters, without claiming other cloud features', () => {
    // Contract 0.17 allows vault letters; completion checks and page reading
    // still require the app-provider route and the writer's own key.
    for (const copy of [NO_KEY_HINT, REMOVE_KEY_DIALOG_BODY]) {
      const vaultSentences = copy.split(/(?<=[.;])\s+/).filter((s) => /vault/i.test(s));
      expect(vaultSentences.length).toBeGreaterThan(0);
      for (const sentence of vaultSentences) {
        expect(sentence).toMatch(/resonance notes/i);
        expect(sentence).toMatch(/notes and letters/i);
        expect(sentence).not.toMatch(/completion checks|page reading/i);
      }
      expect(copy).not.toMatch(/private/i);
    }
  });

  test('the out-of-credits copy prices vault readings and letters without pricing page reading', () => {
    expect(INSUFFICIENT_OFFERINGS_COPY).not.toMatch(
      /letters and page reading all draw from the same pool/i,
    );
    expect(INSUFFICIENT_OFFERINGS_COPY).toMatch(/vault/i);
    expect(INSUFFICIENT_OFFERINGS_COPY).toMatch(/readings and letters your vault answers/i);
    expect(INSUFFICIENT_OFFERINGS_COPY).toMatch(/page reading needs your own/i);
    expect(INSUFFICIENT_OFFERINGS_COPY).not.toMatch(/private/i);
  });

  test('credits are said not to pay for cloud AI', () => {
    expect(NO_KEY_HINT).toMatch(/credits don't pay/i);
    expect(LLM_KEY_REQUIRED_COPY).toMatch(/credits don't pay/i);
  });

  test('no Settings source still promises the shared server key', () => {
    for (const source of settingsSources()) {
      expect(source).not.toMatch(SERVER_KEY_FALLBACK);
    }
  });

  test('the copy is pinned to a server with no keyless cloud path', () => {
    const llm = readBackendSource('src', 'services', 'botmason.py');

    expect(llm).not.toContain('_get_llm_api_key');
    expect(llm).toContain('raise NoGenerationSourceError(KEY_REQUIRED_DETAIL)');
  });
});
