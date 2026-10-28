/**
 * A funded, explicitly vault-bound account for post-reading Journal tests.
 * Payer-specific specs supply their own usage mocks. A failed/missing route is
 * never a substitute for this server-reported authorization snapshot.
 */
export const botmasonUsage = {
  get: async () => ({
    resonance_route: 'vault_bound' as const,
    monthly_messages_used: 0,
    monthly_messages_remaining: 20,
    monthly_cap: 20,
    monthly_reset_date: '2026-11-01T00:00:00Z',
    offering_balance: 0,
  }),
};
