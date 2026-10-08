/* global describe, expect, it */
import { corpusDestinationForReadiness } from '../corpusDestination';

import {
  CONNECTION_UNKNOWN,
  NOTHING_CONNECTED,
  readConnectionState,
  type VaultConnectionState,
} from '@/features/Settings/vaultConnectionState';

/**
 * One routing rule for every way into the corpus (#3017).
 *
 * A corpus lives in a vault (#3015), so bringing in writing is offered only to
 * an account that has somewhere to keep it. The consent decision still comes
 * first while it is unmade; after that, an account the server says has no vault
 * is shown where its corpus would live, and every other account -- including one
 * whose vault state nobody could establish -- gets the picker, with the server's
 * `vault_required` as the backstop.
 */

const CONNECTED = readConnectionState({ connected: true, vault_url: 'https://v.example' });
const MANAGED = readConnectionState({ connected: true, vault_url: null });

const EVERY_VAULT: readonly [string, VaultConnectionState][] = [
  ['unknown', CONNECTION_UNKNOWN],
  ['none', NOTHING_CONNECTED],
  ['connected', CONNECTED],
  ['managed', MANAGED],
];

describe('corpusDestinationForReadiness', () => {
  it('sends a gathering account with no vault to Where your writing lives', () => {
    expect(corpusDestinationForReadiness({ state: 'gathering' }, NOTHING_CONNECTED)).toBe(
      'VaultSettings',
    );
  });

  it('sends a ready account with no vault to Where your writing lives', () => {
    expect(corpusDestinationForReadiness({ state: 'ready' }, NOTHING_CONNECTED)).toBe(
      'VaultSettings',
    );
  });

  it.each(EVERY_VAULT)('asks an undecided account the decision first (vault %s)', (_, vault) => {
    expect(corpusDestinationForReadiness({ state: 'not_consented' }, vault)).toBe('CorpusConsent');
  });

  it.each([
    ['gathering', 'unknown', CONNECTION_UNKNOWN],
    ['gathering', 'connected', CONNECTED],
    ['gathering', 'managed', MANAGED],
    ['ready', 'unknown', CONNECTION_UNKNOWN],
    ['ready', 'connected', CONNECTED],
    ['ready', 'managed', MANAGED],
  ] as const)('offers the picker to a %s account whose vault is %s', (state, _, vault) => {
    expect(corpusDestinationForReadiness({ state }, vault)).toBe('SeedCorpus');
  });
});
