/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import {
  CONNECTION_UNKNOWN,
  NOTHING_CONNECTED,
  readConnectionState,
  vaultComesFirst,
} from '../vaultConnectionState';

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

  it('recognizes a managed connection without disclosing an address', () => {
    const connection: VaultConnection = { connected: true, vault_url: null };

    expect(readConnectionState(connection)).toEqual({ kind: 'managed' });
  });

  it('lets the connected flag decide, even when an address rides along with it', () => {
    // ``connected: false`` is answered before the address is looked at, so a
    // stale address on a disconnected answer reads as none rather than
    // reviving the vault it names.
    const connection: VaultConnection = { connected: false, vault_url: VAULT_URL };

    expect(readConnectionState(connection)).toEqual({ kind: 'none' });
  });
});

describe('vaultComesFirst', () => {
  it('holds for an account the server says has nothing attached', () => {
    expect(vaultComesFirst(NOTHING_CONNECTED)).toBe(true);
  });

  it('does not hold while nobody has established what is attached', () => {
    // Unknown is never read as none: a failed or pending read must not send a
    // person with a vault off to set one up.
    expect(vaultComesFirst(CONNECTION_UNKNOWN)).toBe(false);
  });

  it('does not hold for a vault at an address', () => {
    const connected = readConnectionState({ connected: true, vault_url: VAULT_URL });

    expect(vaultComesFirst(connected)).toBe(false);
  });

  it('does not hold for a managed vault, which is answered with no address', () => {
    const managed = readConnectionState({ connected: true, vault_url: null });

    expect(vaultComesFirst(managed)).toBe(false);
  });
});
