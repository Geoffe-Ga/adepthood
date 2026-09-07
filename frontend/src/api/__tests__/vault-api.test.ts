/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiError, ApiValidationError, vault, vaultActivation } from '../index';

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
const ACTIVATION_URL = 'http://test/vault/activation';
const CEREMONY_URL = `${ACTIVATION_URL}/key-ceremony`;

const INACTIVE_ACTIVATION = {
  active: false,
  state: 'inactive' as const,
  retryable: false,
  failure_reason: null,
  credential_received: false,
  attested_confidential: null,
};

const CHALLENGE = {
  protocol_version: '1.0.0' as const,
  job_id: 'job-1',
  activation_id: 'activation-1',
  ceremony_id: 'ceremony-1',
  server_nonce: 'A'.repeat(43),
  expires_at: '2026-09-08T12:00:00Z',
};

const WRAPPED_ARTIFACT = {
  version: 2 as const,
  kdf: {
    algorithm: 'argon2id' as const,
    salt: 'a'.repeat(32),
    time_cost: 3 as const,
    lanes: 4 as const,
    memory_kib: 65_536 as const,
  },
  passphrase_wrapped: { nonce: 'b'.repeat(24), ciphertext: 'c'.repeat(96) },
  recovery_wrapped: { nonce: 'd'.repeat(24), ciphertext: 'e'.repeat(96) },
  binding: {
    protocol_version: '1.0.0' as const,
    activation_id: CHALLENGE.activation_id,
    ceremony_id: CHALLENGE.ceremony_id,
    server_nonce: CHALLENGE.server_nonce,
    client_nonce: 'F'.repeat(43),
  },
};

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

describe('vaultActivation', () => {
  test('reads durable progress without creating an allocation', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(INACTIVE_ACTIVATION));

    await expect(vaultActivation.status('tok')).resolves.toEqual(INACTIVE_ACTIVATION);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(ACTIVATION_URL);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  test('starts and retries only on explicit POST actions', async () => {
    mockFetch
      .mockReturnValueOnce(
        jsonResponse({ ...INACTIVE_ACTIVATION, active: true, state: 'pending' }, 202),
      )
      .mockReturnValueOnce(
        jsonResponse({ ...INACTIVE_ACTIVATION, active: true, state: 'pending' }, 202),
      );

    await vaultActivation.activate('tok');
    await vaultActivation.retry('tok');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe(ACTIVATION_URL);
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
    expect(mockFetch.mock.calls[1][0]).toBe(`${ACTIVATION_URL}/retry`);
    expect(mockFetch.mock.calls[1][1].method).toBe('POST');
  });

  test('validates the short-lived public ceremony challenge', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(CHALLENGE));

    await expect(vaultActivation.keyCeremony('tok')).resolves.toEqual(CHALLENGE);

    expect(mockFetch.mock.calls[0][0]).toBe(CEREMONY_URL);
    expect(mockFetch.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
  });

  test('rejects a challenge whose nonce is not protocol-shaped', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...CHALLENGE, server_nonce: 'too-short' }));

    await expect(vaultActivation.keyCeremony('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('submits exactly the wrapped artifact and explicit recovery acknowledgement', async () => {
    const submission = {
      protocol_version: '1.0.0' as const,
      ceremony_id: CHALLENGE.ceremony_id,
      server_nonce: CHALLENGE.server_nonce,
      recovery_saved: true as const,
      wrapped_artifact: WRAPPED_ARTIFACT,
      attestation: null,
      key_release: null,
    };
    mockFetch.mockReturnValueOnce(
      jsonResponse({ ...INACTIVE_ACTIVATION, active: true, state: 'awaiting_handoff' }),
    );

    await vaultActivation.completeCeremony(submission, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(CEREMONY_URL);
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual(submission);
    expect(body).not.toHaveProperty('passphrase');
    expect(body).not.toHaveProperty('recoveryCode');
    expect(body).not.toHaveProperty('recovery_code');
  });

  test('rejects drifted activation progress at the client edge', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...INACTIVE_ACTIVATION, state: 'almost_ready' }));

    await expect(vaultActivation.status('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });
});
