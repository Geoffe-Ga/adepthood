/* global test, expect, jest */
import { progress, setTokenGetter } from '../index';

import { progressOverviewFixture } from '@/features/Map/testSupport/progressOverviewFixture';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

test('the private overview uses the dispatch credential rather than a later token getter', async () => {
  setTokenGetter(() => 'renewed-session-token');
  const body = progressOverviewFixture();
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });

  await expect(progress.overview('dispatch-session-token')).resolves.toEqual(body);

  expect(mockFetch).toHaveBeenCalledWith(
    'http://test/progress/overview',
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer dispatch-session-token' }),
    }),
  );
});

test('an overview without observations parses, and a malformed one is refused', async () => {
  const withoutObservations: Partial<ReturnType<typeof progressOverviewFixture>> =
    progressOverviewFixture();
  delete withoutObservations.observations;
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => withoutObservations });
  await expect(progress.overview('t')).resolves.toEqual(withoutObservations);

  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ arc: {} }) });
  await expect(progress.overview('t')).rejects.toThrow();
});
