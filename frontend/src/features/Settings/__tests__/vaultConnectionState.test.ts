/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { readConnectionState } from '../vaultConnectionState';

import type { VaultConnection } from '@/api';

/**
 * Reading a server answer as one of three states.
 *
 * The screen renders three different things from this function, and two of the
 * three are only one field apart, so the mapping is pinned here directly rather
 * than inferred from whichever fixture a screen test happened to render.
 */

const VAULT_URL = 'https://vault.example';

describe('readConnectionState', () => {
  it('reads an unconnected account as nothing attached', () => {
    const connection: VaultConnection = { connected: false, vault_url: null };

    expect(readConnectionState(connection)).toEqual({ kind: 'none' });
  });

  it('reads a connected account as its address', () => {
    const connection: VaultConnection = { connected: true, vault_url: VAULT_URL };

    expect(readConnectionState(connection)).toEqual({ kind: 'connected', address: VAULT_URL });
  });

  it('reads a connection with no address as unknown rather than as none', () => {
    // The security-relevant branch. The server cannot produce this pair, but
    // the type can, and reading it as "nothing attached" would render the empty
    // state and let one press replace a binding without asking -- the exact
    // defect the third state exists to remove.
    const connection: VaultConnection = { connected: true, vault_url: null };

    expect(readConnectionState(connection)).toEqual({ kind: 'unknown' });
  });

  it('lets the connected flag decide, even when an address rides along with it', () => {
    // ``connected: false`` is answered before the address is looked at, so a
    // stale address on a disconnected answer reads as none rather than
    // reviving the vault it names.
    const connection: VaultConnection = { connected: false, vault_url: VAULT_URL };

    expect(readConnectionState(connection)).toEqual({ kind: 'none' });
  });
});
