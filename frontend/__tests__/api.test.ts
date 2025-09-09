/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */

import { auth, habits, journal, practice, stages } from '@/api';

describe('API client request composition', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({}) }) as any;
  });

  it('requests habit list with GET /habits', async () => {
    await habits.list();
    expect(fetch).toHaveBeenCalledWith('http://localhost:8000/habits');
  });

  it('creates journal entry with POST /journal', async () => {
    const entry = { content: 'hi' };
    await journal.create(entry);
    expect(fetch).toHaveBeenCalledWith('http://localhost:8000/journal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
  });

  it('requests stage list with GET /stages', async () => {
    await stages.list();
    expect(fetch).toHaveBeenCalledWith('http://localhost:8000/stages');
  });

  it('logs practice session with POST /practice_sessions', async () => {
    const session = { practiceId: 1, duration: 10 };
    await practice.log(session);
    expect(fetch).toHaveBeenCalledWith('http://localhost:8000/practice_sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session),
    });
  });

  it('logs in via POST /auth/login', async () => {
    const creds = { username: 'u', password: 'p' }; // pragma: allowlist secret
    await auth.login(creds);
    expect(fetch).toHaveBeenCalledWith('http://localhost:8000/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
  });
});
