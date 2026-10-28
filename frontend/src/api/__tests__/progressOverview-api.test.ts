/* global test, expect, jest */
import { progress, setTokenGetter } from '../index';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

test('the private overview uses the dispatch credential rather than a later token getter', async () => {
  setTokenGetter(() => 'renewed-session-token');
  const body: unknown = { arc: { program_started_at: null } };
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });

  await expect(progress.overview('dispatch-session-token')).resolves.toEqual(body);

  expect(mockFetch).toHaveBeenCalledWith(
    'http://test/progress/overview',
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer dispatch-session-token' }),
    }),
  );
});
