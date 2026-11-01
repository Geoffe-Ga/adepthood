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
const AGENT_ADDRESS = 'https://vault.example/mcp';

describe('readConnectionState', () => {
  it('reads an unconnected account as nothing attached', () => {
    const connection: VaultConnection = { connected: false, vault_url: null, mcp_address: null };

    expect(readConnectionState(connection)).toEqual({ kind: 'none' });
  });

  it('reads a connected account as its address, and the address it gives agents', () => {
    const connection: VaultConnection = {
      connected: true,
      vault_url: VAULT_URL,
      mcp_address: AGENT_ADDRESS,
    };

    expect(readConnectionState(connection)).toEqual({
      kind: 'connected',
      address: VAULT_URL,
      agentAddress: AGENT_ADDRESS,
    });
  });

  it('keeps a connected vault connected when the server names no agent address', () => {
    const connection: VaultConnection = {
      connected: true,
      vault_url: VAULT_URL,
      mcp_address: null,
    };

    expect(readConnectionState(connection)).toEqual({
      kind: 'connected',
      address: VAULT_URL,
      agentAddress: null,
    });
  });

  it('recognizes a managed connection without disclosing an address', () => {
    const connection: VaultConnection = { connected: true, vault_url: null, mcp_address: null };

    expect(readConnectionState(connection)).toEqual({ kind: 'managed', agentAddress: null });
  });

  it('keeps a managed vault public agent address separate from its private binding', () => {
    expect(
      readConnectionState({ connected: true, vault_url: null, mcp_address: AGENT_ADDRESS }),
    ).toEqual({ kind: 'managed', agentAddress: AGENT_ADDRESS });
  });

  it("carries the server's sort sentence on a vault it is about (#3577)", () => {
    const message = 'Some of your writing has only had a rough sort so far.';

    expect(
      readConnectionState({
        connected: true,
        vault_url: VAULT_URL,
        mcp_address: null,
        classification_state: 'incomplete',
        classification_message: message,
      }),
    ).toEqual({
      kind: 'connected',
      address: VAULT_URL,
      agentAddress: null,
      classificationMessage: message,
    });
    expect(
      readConnectionState({
        connected: true,
        vault_url: null,
        mcp_address: null,
        classification_state: 'incomplete',
        classification_message: message,
      }),
    ).toEqual({ kind: 'managed', agentAddress: null, classificationMessage: message });
  });

  it('carries no sort sentence when the server gives none', () => {
    const state = readConnectionState({
      connected: true,
      vault_url: VAULT_URL,
      mcp_address: null,
      classification_state: 'complete',
      classification_message: null,
    });

    expect(state).not.toHaveProperty('classificationMessage');
  });

  it('reads the deployment-wide vault as its own kind, with no address of any sort (#3608)', () => {
    const connection: VaultConnection = {
      connected: true,
      vault_url: null,
      mcp_address: null,
      source: 'deployment',
    };

    expect(readConnectionState(connection)).toEqual({ kind: 'deployment' });
  });

  it('never carries an address for the deployment vault, even one sent by mistake', () => {
    // The operator's vault is not the account's to show: an address on this
    // answer would be a server fault, and the state still has nowhere to put it.
    const state = readConnectionState({
      connected: true,
      vault_url: VAULT_URL,
      mcp_address: AGENT_ADDRESS,
      source: 'deployment',
    });

    expect(state).toEqual({ kind: 'deployment' });
  });

  it("carries the server's sort sentence on the deployment vault too", () => {
    const message = 'Some of your writing has only had a rough sort so far.';

    expect(
      readConnectionState({
        connected: true,
        vault_url: null,
        mcp_address: null,
        source: 'deployment',
        classification_state: 'incomplete',
        classification_message: message,
      }),
    ).toEqual({ kind: 'deployment', classificationMessage: message });
  });

  it('reads the named managed and connected sources as before', () => {
    expect(
      readConnectionState({
        connected: true,
        vault_url: null,
        mcp_address: null,
        source: 'managed',
      }),
    ).toEqual({ kind: 'managed', agentAddress: null });
    expect(
      readConnectionState({
        connected: true,
        vault_url: VAULT_URL,
        mcp_address: null,
        source: 'connected',
      }),
    ).toEqual({ kind: 'connected', address: VAULT_URL, agentAddress: null });
  });

  it('lets the connected flag decide, even when an address rides along with it', () => {
    // ``connected: false`` is answered before the address is looked at, so a
    // stale address on a disconnected answer reads as none rather than
    // reviving the vault it names.
    const connection: VaultConnection = {
      connected: false,
      vault_url: VAULT_URL,
      mcp_address: null,
    };

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
    const connected = readConnectionState({
      connected: true,
      vault_url: VAULT_URL,
      mcp_address: null,
    });

    expect(vaultComesFirst(connected)).toBe(false);
  });

  it('does not hold for a managed vault, which is answered with no address', () => {
    const managed = readConnectionState({ connected: true, vault_url: null, mcp_address: null });

    expect(vaultComesFirst(managed)).toBe(false);
  });

  it("does not hold for the deployment-wide vault's owner, whose writing lands there (#3608)", () => {
    const deployment = readConnectionState({
      connected: true,
      vault_url: null,
      mcp_address: null,
      source: 'deployment',
    });

    expect(vaultComesFirst(deployment)).toBe(false);
  });
});
