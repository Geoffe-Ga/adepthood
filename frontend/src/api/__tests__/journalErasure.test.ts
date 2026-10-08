/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiValidationError, journal } from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('journal.eraseLocally (#3094)', () => {
  test('POSTs the "delete here only" request and returns the receipt', async () => {
    const receipt = { entry_id: 7, remote_copy: 'unconfirmed', copy_location: 'previous_vault' };
    mockFetch.mockReturnValueOnce(jsonResponse(receipt));

    await expect(journal.eraseLocally(7, 'token')).resolves.toEqual(receipt);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test/journal/7/erase-locally');
    expect(init.method).toBe('POST');
  });

  test('refuses a receipt that claims a state the server never sends', async () => {
    mockFetch.mockReturnValue(
      jsonResponse({ entry_id: 7, remote_copy: 'withdrawn', copy_location: null }),
    );

    await expect(journal.eraseLocally(7, 'token')).rejects.toBeInstanceOf(ApiValidationError);
  });
});
