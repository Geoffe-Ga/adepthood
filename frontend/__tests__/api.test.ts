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

  it('logs practice session with POST /practice_sessions', async () => {
    const session = { practiceId: 1, duration: 10 };
    await api.practice.log(session);
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/practice_sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session),
    });
  });

  it('logs in via POST /auth/login', async () => {
    const creds = { username: 'u', password: 'p' }; // pragma: allowlist secret
    await api.auth.login(creds);
    expect(fetch).toHaveBeenCalledWith(`${mockBaseUrl}/auth/login`, {
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

  it('throws on non-ok response', async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(api.habits.list()).rejects.toThrow('Request failed with status 500');
  });

  it('propagates network errors', async () => {
    (fetch as jest.Mock).mockRejectedValueOnce(new Error('network'));
    await expect(api.habits.list()).rejects.toThrow('network');
  });
});
