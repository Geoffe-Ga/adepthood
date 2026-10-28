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

const INACTIVE_ACTIVATION = {
  active: false,
  state: 'inactive' as const,
  new_activation_available: true,
  recovery_available: false,
  retryable: false,
  failure_reason: null,
  credential_received: false,
  attested_confidential: null,
  custody_mode: null,
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
    mockFetch.mockReturnValueOnce(
      jsonResponse({ connected: true, vault_url: VAULT_URL, mcp_address: null }),
    );

    const state = await vault.connection('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(CONNECTION_URL);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(state).toEqual({ connected: true, vault_url: VAULT_URL, mcp_address: null });
  });

  test('accepts a null address as the state it is, not a malformed response', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ connected: false, vault_url: null, mcp_address: null }),
    );

    const state = await vault.connection('tok');

    expect(state.connected).toBe(false);
    expect(state.vault_url).toBeNull();
  });

  test('reads a refused writer key, and tolerates a server that does not say (#3595)', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        connected: true,
        vault_url: null,
        mcp_address: null,
        classification_key_rejected: true,
      }),
    );
    expect((await vault.connection('tok')).classification_key_rejected).toBe(true);

    mockFetch.mockReturnValueOnce(
      jsonResponse({ connected: true, vault_url: null, mcp_address: null }),
    );
    expect((await vault.connection('tok')).classification_key_rejected).toBeUndefined();
  });

  test('raises ApiValidationError when the refused-key flag is not a boolean', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        connected: true,
        vault_url: null,
        mcp_address: null,
        classification_key_rejected: 'yes',
      }),
    );

    const err = await vault.connection('tok').catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiValidationError);
  });

  test('raises ApiValidationError when connected arrives as something other than a boolean', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ connected: 'yes', vault_url: null, mcp_address: null }),
    );

    const err = await vault.connection('tok').catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiValidationError);
  });
});

describe('vault.connect', () => {
  test('PUTs exactly the address and the key, and nothing else', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ connected: true, vault_url: VAULT_URL, mcp_address: null }),
    );

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
    expect(state).toEqual({ connected: true, vault_url: VAULT_URL, mcp_address: null });
  });

  test('keeps the credential out of the URL entirely', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ connected: true, vault_url: VAULT_URL, mcp_address: null }),
    );

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

const AGENTS_URL = 'http://test/vault/agents';

const AGENT_ROW = {
  id: 3,
  name: 'OpenClaw on my Mac mini',
  grants: ['vault:read', 'vault:desk'],
  created_at: '2026-10-24T16:00:00Z',
  last_used_at: '2026-10-24T18:02:11Z',
  redirect_host: '127.0.0.1',
};

describe('vault.agents', () => {
  test('GETs /vault/agents with no body and hands back every row as sent', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([AGENT_ROW]));

    const agents = await vault.agents('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(AGENTS_URL);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(agents).toEqual([AGENT_ROW]);
  });

  test('reads an agent that gave no name and has not signed in yet', async () => {
    const unnamed = { ...AGENT_ROW, name: null, last_used_at: null, redirect_host: null };
    mockFetch.mockReturnValueOnce(jsonResponse([unnamed]));

    await expect(vault.agents('tok')).resolves.toEqual([unnamed]);
  });

  test('refuses a row whose timestamp is not a dated instant', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([{ ...AGENT_ROW, created_at: 'yesterday' }]));

    await expect(vault.agents('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });
});

describe('vault.agentActivity', () => {
  const ROW = {
    agent: 'OpenClaw on my Mac mini',
    tool_label: 'Drafted an essay',
    at: '2026-10-24T18:02:11Z',
    outcome: 'admitted',
  };
  const ACTIVITY_LIMIT = 20;

  test('GETs /vault/agents/activity with the limit and hands back the rows as sent', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ status: 'ok', rows: [ROW] }));

    const activity = await vault.agentActivity(ACTIVITY_LIMIT, 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${AGENTS_URL}/activity?limit=${ACTIVITY_LIMIT}`);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(activity).toEqual({ status: 'ok', rows: [ROW] });
  });

  test('reads an unavailable vault as an answer, not an error', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ status: 'unavailable', rows: [] }));

    await expect(vault.agentActivity(ACTIVITY_LIMIT, 'tok')).resolves.toEqual({
      status: 'unavailable',
      rows: [],
    });
  });

  test('refuses a row carrying anything beyond its four fields', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ status: 'ok', rows: [{ ...ROW, args: 'draft me an essay' }] }),
    );

    await expect(vault.agentActivity(ACTIVITY_LIMIT, 'tok')).rejects.toBeInstanceOf(
      ApiValidationError,
    );
  });

  test('refuses an outcome outside admitted and refused', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ status: 'ok', rows: [{ ...ROW, outcome: true }] }),
    );

    await expect(vault.agentActivity(ACTIVITY_LIMIT, 'tok')).rejects.toBeInstanceOf(
      ApiValidationError,
    );
  });
});

describe('vault.revokeAgent', () => {
  test('DELETEs the one agent by id, with no body, and resolves on the 204', async () => {
    mockFetch.mockReturnValueOnce(noContentResponse());

    await expect(vault.revokeAgent(AGENT_ROW.id, 'tok')).resolves.toBeUndefined();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${AGENTS_URL}/${AGENT_ROW.id}`);
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  test("surfaces a 404 for an agent that is not this account's", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'agent_not_found' }, 404));

    const err = await vault.revokeAgent(AGENT_ROW.id, 'tok').catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).detail).toBe('agent_not_found');
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

  test('starts, retries, and recovers only on explicit POST actions', async () => {
    mockFetch
      .mockReturnValueOnce(
        jsonResponse({ ...INACTIVE_ACTIVATION, active: true, state: 'pending' }, 202),
      )
      .mockReturnValueOnce(
        jsonResponse({ ...INACTIVE_ACTIVATION, active: true, state: 'pending' }, 202),
      )
      .mockReturnValueOnce(
        jsonResponse({ ...INACTIVE_ACTIVATION, active: true, state: 'deleting' }, 202),
      );

    await vaultActivation.activate('tok');
    await vaultActivation.retry('tok');
    await vaultActivation.recover('tok');

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toBe(ACTIVATION_URL);
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
    expect(mockFetch.mock.calls[1][0]).toBe(`${ACTIVATION_URL}/retry`);
    expect(mockFetch.mock.calls[1][1].method).toBe('POST');
    expect(mockFetch.mock.calls[2][0]).toBe(`${ACTIVATION_URL}/recover`);
    expect(mockFetch.mock.calls[2][1].method).toBe('POST');
  });

  test('accepts only the closed custody vocabulary', async () => {
    const ready = {
      ...INACTIVE_ACTIVATION,
      active: true,
      state: 'ready',
      credential_received: true,
      attested_confidential: false,
      custody_mode: 'provider_managed',
    };
    mockFetch.mockReturnValueOnce(jsonResponse(ready));

    await expect(vaultActivation.status('tok')).resolves.toEqual(ready);

    mockFetch.mockReturnValueOnce(jsonResponse({ ...ready, custody_mode: 'user_held' }));
    await expect(vaultActivation.status('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects drifted activation progress at the client edge', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...INACTIVE_ACTIVATION, state: 'almost_ready' }));

    await expect(vaultActivation.status('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });
});
