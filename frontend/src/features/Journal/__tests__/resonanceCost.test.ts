/* eslint-env jest */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { knownCostState, loadCostState } from '../resonanceCost';

/**
 * Which keyless price line a writer sees (#3262).
 *
 * Since ADR 0009 phase (a) (#3067) credits pay only for a reading the writer's
 * own vault answers. So in a production build a letter, and a reading for a
 * writer with no vault, lead with "This needs your own API key" and name no
 * BotMason price; a reading a vault may answer keeps its price, word for word.
 */
const mockUsage = jest.fn<() => Promise<unknown>>();
const mockConnection = jest.fn<() => Promise<{ connected: boolean; vault_url: string | null }>>();
let mockKeylessReachesServer = false;

jest.mock('@/api', () => ({
  botmasonUsage: { get: () => mockUsage() },
  vault: { connection: () => mockConnection() },
}));

jest.mock('@/config', () =>
  Object.defineProperty({}, 'KEYLESS_GENERATION_REACHES_SERVER', {
    enumerable: true,
    get: (): boolean => mockKeylessReachesServer,
  }),
);

const KEY_NEEDED_READING =
  'This needs your own API key. Add one in Settings to ask for this reading.';
const KEY_NEEDED_LETTER =
  'This needs your own API key. Add one in Settings to ask for this letter.';
const ADD_KEY = 'Add your own API key in Settings and it pays instead.';

function usage() {
  return {
    monthly_messages_used: 0,
    monthly_messages_remaining: 7,
    monthly_cap: 7,
    monthly_reset_date: '2026-11-01T00:00:00Z',
    offering_balance: 0,
  };
}

beforeEach(() => {
  mockKeylessReachesServer = false;
  mockUsage.mockReset();
  mockUsage.mockResolvedValue(usage());
  mockConnection.mockReset();
  mockConnection.mockResolvedValue({ connected: false, vault_url: null });
});

describe('a keyless letter needs the writer’s own key', () => {
  it('leads with the key, offers Settings, and reads neither wallet nor vault', async () => {
    const state = await loadCostState(false, 'letter');

    expect(state.copy).toBe(KEY_NEEDED_LETTER);
    expect(state.keyNeeded).toBe(true);
    expect(state.canContinue).toBe(false);
    expect(state.copy).not.toMatch(/BotMason/u);
    expect(mockUsage).not.toHaveBeenCalled();
    expect(mockConnection).not.toHaveBeenCalled();
  });

  it('is known before any read, so the offer never flashes a price', () => {
    expect(knownCostState(false, 'letter')?.copy).toBe(KEY_NEEDED_LETTER);
  });

  it('even when a vault is connected, since letters never go to a vault', async () => {
    mockConnection.mockResolvedValue({ connected: true, vault_url: 'https://vault.example' });

    expect((await loadCostState(false, 'letter')).copy).toBe(KEY_NEEDED_LETTER);
  });
});

describe('a keyless reading with no vault needs the writer’s own key', () => {
  it('leads with the key and names no price when nothing is attached', async () => {
    const state = await loadCostState(false);

    expect(state.copy).toBe(KEY_NEEDED_READING);
    expect(state.keyNeeded).toBe(true);
    expect(state.canContinue).toBe(false);
    expect(mockUsage).not.toHaveBeenCalled();
  });

  it('cannot be known before the vault is read', () => {
    expect(knownCostState(false)).toBeNull();
  });
});

describe('a keyless reading a vault may answer keeps its price', () => {
  it.each([
    ['a connected vault', { connected: true, vault_url: 'https://vault.example' }],
    ['a managed vault', { connected: true, vault_url: null }],
  ])('for %s', async (_case, connection) => {
    mockConnection.mockResolvedValue(connection);

    const state = await loadCostState(false);

    expect(state.copy).toBe(
      `This reading spends one of your 7 BotMason messages for the month. ${ADD_KEY}`,
    );
    expect(state.keyNeeded).toBe(false);
    expect(state.canContinue).toBe(true);
  });

  it('for an unread connection, which is never read as "no vault"', async () => {
    mockConnection.mockRejectedValue(new Error('offline'));

    const state = await loadCostState(false);

    expect(state.keyNeeded).toBe(false);
    expect(state.copy).toMatch(/BotMason messages for the month/u);
  });
});

describe('a saved key pays, unchanged', () => {
  it.each([
    [
      'reading',
      'Your own API key pays for this reading. Nothing is drawn from your BotMason messages.',
    ],
    [
      'letter',
      'Your own API key pays for this letter. Nothing is drawn from your BotMason messages.',
    ],
  ])('for a %s', async (noun, expected) => {
    const state = await loadCostState(true, noun);

    expect(state.copy).toBe(expected);
    expect(state.keyNeeded).toBe(false);
    expect(mockConnection).not.toHaveBeenCalled();
  });
});

describe('a development build, whose stub seam answers keyless requests', () => {
  it('keeps pricing a keyless letter and a vaultless reading', async () => {
    mockKeylessReachesServer = true;

    expect((await loadCostState(false, 'letter')).copy).toBe(
      `This letter spends one of your 7 BotMason messages for the month. ${ADD_KEY}`,
    );
    expect((await loadCostState(false)).keyNeeded).toBe(false);
    expect(mockConnection).not.toHaveBeenCalled();
  });
});
