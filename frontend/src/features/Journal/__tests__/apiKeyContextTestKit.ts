import { jest } from '@jest/globals';

/**
 * Hydrated, keyless API-key context for Journal screen tests that render the
 * route component without the App provider. Payer-specific specs override
 * this seam with their own mutable context state.
 */
export const useApiKey = () => ({
  apiKey: null,
  isLoading: false,
  loadError: null,
  saveApiKey: jest.fn(),
  clearApiKey: jest.fn(),
});
