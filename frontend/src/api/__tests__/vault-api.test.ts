/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiError, ApiValidationError, vault } from '../index';

/**
 * The client half of the vault-connection wire.
 *
 * Three things here are contracts rather than types. The credential travels on
 * the body of one verb and on nothing else, so a wrapper that widened the body
 * or moved a value into the URL would be sending a secret somewhere the server
 * never promised to keep it out of a log. ``connected: false`` with a null
 * address is the answer for an account that has connected nothing, not a
 * malformed response, so a schema that refused the null would turn "you have no
 * vault yet" into an error screen. And the 422 detail is a four-word vocabulary
 * the screen maps to four different sentences, so a wrapper that flattened it
 * would leave every refusal reading the same.
 */

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const CONNECTION_URL = 'http://test/vault/connection';
const VAULT_URL = 'https://vault.example';
const API_KEY = 'vault-key-do-not-echo'; // pragma: allowlist secret
const HTTP_UNPROCESSABLE = 422;

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

/** A 204: no body at all, and `json()` would throw if anything called it. */
function noContentResponse() {
  return Promise.resolve({
    ok: true,
    status: 204,
    json: () => Promise.reject(new Error('a 204 carries no JSON body')),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('vault.connection', () => {
  test('GETs /vault/connection with no body and reports where the vault points', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ connected: true, vault_url: VAULT_URL }));

    const state = await vault.connection('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(CONNECTION_URL);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(state).toEqual({ connected: true, vault_url: VAULT_URL });
  });

  test('accepts a null address as the state it is, not a malformed response', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ connected: false, vault_url: null }));

    const state = await vault.connection('tok');

    expect(state.connected).toBe(false);
    expect(state.vault_url).toBeNull();
  });

  test('raises ApiValidationError when connected arrives as something other than a boolean', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ connected: 'yes', vault_url: null }));

    const err = await vault.connection('tok').catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiValidationError);
  });
});

describe('vault.connect', () => {
  test('PUTs exactly the address and the key, and nothing else', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ connected: true, vault_url: VAULT_URL }));

    const state = await vault.connect({ vault_url: VAULT_URL, api_key: API_KEY }, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(CONNECTION_URL);
    expect(init.method).toBe('PUT');
    // A third field would be something the user did not type travelling under
    // their credential, so the key set is pinned rather than a subset checked.
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual(['api_key', 'vault_url']);
    expect(JSON.parse(init.body as string)).toEqual({
      vault_url: VAULT_URL,
      api_key: API_KEY,
    });
    expect(state).toEqual({ connected: true, vault_url: VAULT_URL });
  });

  test('keeps the credential out of the URL entirely', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ connected: true, vault_url: VAULT_URL }));

    await vault.connect({ vault_url: VAULT_URL, api_key: API_KEY }, 'tok');

    const [url] = mockFetch.mock.calls[0];
    expect(url).not.toContain(API_KEY);
    expect(url).not.toContain('?');
  });

  test('surfaces a 422 with its refusal code intact', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ detail: 'vault_url_insecure_transport' }, HTTP_UNPROCESSABLE),
    );

    const err = await vault
      .connect({ vault_url: 'http://vault.example', api_key: API_KEY }, 'tok')
      .catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(HTTP_UNPROCESSABLE);
    // The screen maps this code to its own sentence; a swallowed detail would
    // collapse seven different refusals into one piece of copy.
    expect((err as ApiError).detail).toBe('vault_url_insecure_transport');
  });
});

describe('vault.disconnect', () => {
  test('DELETEs with no body and resolves on a 204 that carries none either', async () => {
    mockFetch.mockReturnValueOnce(noContentResponse());

    await expect(vault.disconnect('tok')).resolves.toBeUndefined();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(CONNECTION_URL);
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  test('surfaces a rejected disconnect rather than reporting a silent success', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));

    const err = await vault.disconnect('bad-tok').catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });
});
