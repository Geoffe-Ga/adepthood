import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { loadCostState } from '../resonanceCost';
const mockUsage = jest.fn<() => Promise<unknown>>();
const mockConnection = jest.fn();
jest.mock('@/api', () => ({
  botmasonUsage: { get: () => mockUsage() },
  vault: { connection: () => mockConnection() },
}));
function usage(route: string) {
  return {
    resonance_route: route,
    monthly_messages_remaining: 7,
    monthly_cap: 7,
    offering_balance: 0,
    monthly_reset_date: '2026-11-01T00:00:00Z',
  };
}
beforeEach(() => {
  mockUsage.mockReset();
  mockConnection.mockReset();
});
describe('the authenticated server route determines the payer', () => {
  it.each([false, true])('app-provider reading with own key %s', async (key) => {
    mockUsage.mockResolvedValue(usage('app_provider'));
    const state = await loadCostState(key);
    expect(state.keyNeeded).toBe(!key);
    expect(state.canContinue).toBe(key);
    expect(state.copy).toBe(
      key
        ? 'Your own API key pays for this reading. Nothing is drawn from your BotMason messages.'
        : 'This needs your own API key. Add one in Settings to ask for this reading.',
    );
    expect(mockConnection).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'a deployment-bound vault reading spends credits with key %s',
    async (key) => {
      mockUsage.mockResolvedValue(usage('vault_bound'));
      const state = await loadCostState(key);
      expect(state.copy).toBe('This reading spends one of your 7 BotMason messages for the month.');
      expect(state.canContinue).toBe(true);
      expect(state.keyNeeded).toBe(false);
      expect(mockConnection).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    'a first vault-bound letter uses wallet credits with key %s',
    async (key) => {
      mockUsage.mockResolvedValue(usage('vault_bound'));
      const state = await loadCostState(key, 'letter');
      expect(state.copy).toBe('This letter spends one of your 7 BotMason messages for the month.');
      expect(state.canContinue).toBe(true);
      expect(state.fundingRequired).toBeNull();
    },
  );
  it.each([false, true])('a first app-provider letter requires the caller key %s', async (key) => {
    mockUsage.mockResolvedValue(usage('app_provider'));
    const state = await loadCostState(key, 'letter');
    expect(state.canContinue).toBe(key);
    expect(state.keyNeeded).toBe(!key);
    expect(state.copy).not.toMatch(/spends|offering/u);
  });
  it.each([false, true])('an unknown route never authorizes a charge with key %s', async (key) => {
    mockUsage.mockResolvedValue(usage('future-route'));
    const state = await loadCostState(key);
    expect(state.canContinue).toBe(false);
    expect(state.fundingRequired).toBeNull();
  });
  it('a failed route read never guesses the allowance or a key remedy', async () => {
    mockUsage.mockRejectedValue(new Error('offline'));
    const state = await loadCostState(false);
    expect(state.canContinue).toBe(false);
    expect(state.keyNeeded).toBe(false);
    expect(state.copy).toMatch(/couldn't check/u);
    expect(state.copy).not.toMatch(/spends|Add.*key/u);
  });
});
