/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */

const mockBaseUrl = 'http://example.com';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let api: any;

describe('API client request composition', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.mock('@/config', () => ({ API_BASE_URL: mockBaseUrl }));
    api = require('@/api');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any;
  });

  it('requests habit list with GET /habits', async () => {
    await api.habits.list();
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/habits`);
  });

  it('creates journal entry with POST /journal', async () => {
    const entry = { content: 'hi' };
    await api.journal.create(entry);
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
  });

  it('requests stage list with GET /stages', async () => {
    await api.stages.list();
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/stages`);
  });

  it('creates practice session with POST /practice-sessions/', async () => {
    const session = { user_practice_id: 1, duration_minutes: 10 };
    await api.practiceSessions.create(session);
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/practice-sessions/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session),
    });
  });

  it('logs in via POST /auth/login', async () => {
    const creds = { email: 'u@example.com', password: 'p' }; // pragma: allowlist secret
    await api.auth.login(creds);
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
  });

  it('signs up via POST /auth/signup', async () => {
    const creds = { email: 'u@example.com', password: 'p' }; // pragma: allowlist secret
    await api.auth.signup(creds);
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
  });

  it('adds auth header when token provided', async () => {
    await api.habits.list('token');
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/habits`, {
      headers: { Authorization: 'Bearer token' },
    });
  });

  it('uses token getter when set and no explicit token given', async () => {
    api.setTokenGetter(() => 'auto-token');
    await api.habits.list();
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/habits`, {
      headers: { Authorization: 'Bearer auto-token' },
    });
  });

  it('explicit token overrides token getter', async () => {
    api.setTokenGetter(() => 'auto-token');
    await api.habits.list('explicit-token');
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/habits`, {
      headers: { Authorization: 'Bearer explicit-token' },
    });
  });

  it('token getter returning null sends no auth header', async () => {
    api.setTokenGetter(() => null);
    await api.habits.list();
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/habits`);
  });
});

describe('ApiError', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.mock('@/config', () => ({ API_BASE_URL: mockBaseUrl }));
    api = require('@/api');
  });

  it('throws ApiError with status and detail on non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ detail: 'Validation failed' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    try {
      await api.habits.list();
      throw new Error('should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(api.ApiError);
      const apiErr = err as InstanceType<typeof api.ApiError>;
      expect(apiErr.status).toBe(422);
      expect(apiErr.detail).toBe('Validation failed');
      expect(apiErr.message).toBe('Request failed with status 422: Validation failed');
    }
  });

  it('falls back to status text when response body is not JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    try {
      await api.habits.list();
      throw new Error('should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(api.ApiError);
      const apiErr = err as InstanceType<typeof api.ApiError>;
      expect(apiErr.status).toBe(500);
      expect(apiErr.detail).toBe('Request failed');
    }
  });

  it('propagates network errors as-is', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = jest.fn().mockRejectedValue(new Error('network')) as any;
    await expect(api.habits.list()).rejects.toThrow('network');
  });
});

describe('401 unauthorized callback', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.mock('@/config', () => ({ API_BASE_URL: mockBaseUrl }));
    api = require('@/api');
  });

  it('calls onUnauthorized callback when a 401 response is received', async () => {
    const onUnauthorized = jest.fn();
    api.setOnUnauthorized(onUnauthorized);

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ detail: 'Token expired' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    try {
      await api.habits.list();
    } catch {
      // expected
    }

    expect(onUnauthorized).toHaveBeenCalled();
  });

  it('does not call onUnauthorized for non-401 errors', async () => {
    const onUnauthorized = jest.fn();
    api.setOnUnauthorized(onUnauthorized);

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'Server error' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    try {
      await api.habits.list();
    } catch {
      // expected
    }

    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('energy plan', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.mock('@/config', () => ({ API_BASE_URL: mockBaseUrl }));
    api = require('@/api');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any;
  });

  it('creates energy plan with POST /v1/energy/plan', async () => {
    const body = { habits: [], start_date: '2025-01-01' };
    await api.energy.createPlan(body);
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/v1/energy/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  });

  it('includes idempotency key header when provided', async () => {
    const body = { habits: [], start_date: '2025-01-01' };
    await api.energy.createPlan(body, 'abc-123');
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/v1/energy/plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': 'abc-123',
      },
      body: JSON.stringify(body),
    });
  });

  it('includes auth token when token getter is set', async () => {
    api.setTokenGetter(() => 'my-token');
    const body = { habits: [], start_date: '2025-01-01' };
    await api.energy.createPlan(body);
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/v1/energy/plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer my-token',
      },
      body: JSON.stringify(body),
    });
  });
});
