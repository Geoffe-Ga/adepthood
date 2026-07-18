/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import { saveFinishedEntry } from '../saveFinishedEntry';

import type { JournalMessage } from '@/api';

const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;

jest.mock('@/api', () => ({
  journal: {
    create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
    update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 42,
    message: 'A page.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    status: 'draft',
    ...overrides,
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  mockUpdate.mockReset();
});

describe('saveFinishedEntry — new entry (no existingId)', () => {
  it('creates the entry with just the message body', async () => {
    mockCreate.mockResolvedValueOnce(entry({ id: 7 }));
    mockUpdate.mockResolvedValueOnce(entry({ id: 7, status: 'finished' }));
    await saveFinishedEntry('A fresh page.');
    expect(mockCreate).toHaveBeenCalledWith({ message: 'A fresh page.' });
  });

  it('never sends entry_date on create', async () => {
    mockCreate.mockResolvedValueOnce(entry({ id: 7 }));
    mockUpdate.mockResolvedValueOnce(entry({ id: 7, status: 'finished' }));
    await saveFinishedEntry('A fresh page.');
    expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty('entry_date');
  });

  it('never overrides classification on create (backend defaults personal)', async () => {
    mockCreate.mockResolvedValueOnce(entry({ id: 7 }));
    mockUpdate.mockResolvedValueOnce(entry({ id: 7, status: 'finished' }));
    await saveFinishedEntry('A fresh page.');
    expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty('classification');
  });

  it('flips the newly-created entry to finished via update', async () => {
    mockCreate.mockResolvedValueOnce(entry({ id: 7 }));
    mockUpdate.mockResolvedValueOnce(entry({ id: 7, status: 'finished' }));
    await saveFinishedEntry('A fresh page.');
    expect(mockUpdate).toHaveBeenCalledWith(7, { status: 'finished' });
  });

  it('resolves the newly-created entry id', async () => {
    mockCreate.mockResolvedValueOnce(entry({ id: 7 }));
    mockUpdate.mockResolvedValueOnce(entry({ id: 7, status: 'finished' }));
    await expect(saveFinishedEntry('A fresh page.')).resolves.toBe(7);
  });

  it('treats a null existingId the same as no id at all (still creates)', async () => {
    mockCreate.mockResolvedValueOnce(entry({ id: 8 }));
    mockUpdate.mockResolvedValueOnce(entry({ id: 8, status: 'finished' }));
    await saveFinishedEntry('Fresh again.', null);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(8, { status: 'finished' });
  });
});

describe('saveFinishedEntry — retry with an existing id (create already succeeded)', () => {
  it('skips create and PATCHes the existing entry with the body and finished status', async () => {
    mockUpdate.mockResolvedValueOnce(entry({ id: 55, status: 'finished' }));
    await saveFinishedEntry('Retried text.', 55);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(55, { message: 'Retried text.', status: 'finished' });
  });

  it('persists a body edited after the failed first attempt, not the original', async () => {
    mockCreate.mockResolvedValueOnce(entry({ id: 55 }));
    mockUpdate.mockRejectedValueOnce(new Error('PATCH failed'));
    await expect(saveFinishedEntry('First draft.')).rejects.toThrow('PATCH failed');

    mockUpdate.mockResolvedValueOnce(entry({ id: 55, status: 'finished' }));
    await saveFinishedEntry('First draft, edited after the failure.', 55);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenLastCalledWith(55, {
      message: 'First draft, edited after the failure.',
      status: 'finished',
    });
  });

  it('resolves the given existing id, not a freshly-created one', async () => {
    mockUpdate.mockResolvedValueOnce(entry({ id: 55, status: 'finished' }));
    await expect(saveFinishedEntry('Retried text.', 55)).resolves.toBe(55);
  });
});

describe('saveFinishedEntry — entry date', () => {
  it('sends the chosen entry_date on create', async () => {
    mockCreate.mockResolvedValueOnce(entry({ id: 7 }));
    mockUpdate.mockResolvedValueOnce(entry({ id: 7, status: 'finished' }));
    await saveFinishedEntry('A page.', undefined, undefined, '2026-07-05');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'A page.', entry_date: '2026-07-05' }),
    );
  });

  it('never sends entry_date on a retry PATCH, even when one is passed', async () => {
    mockUpdate.mockResolvedValueOnce(entry({ id: 55, status: 'finished' }));
    await saveFinishedEntry('Retried text.', 55, undefined, '2026-07-05');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(55, { message: 'Retried text.', status: 'finished' });
  });
});

describe('saveFinishedEntry — failure propagation', () => {
  it('rejects rather than swallowing when the finishing update fails on a fresh create', async () => {
    mockCreate.mockResolvedValueOnce(entry({ id: 9 }));
    mockUpdate.mockRejectedValueOnce(new Error('PATCH failed'));
    await expect(saveFinishedEntry('Doomed page.')).rejects.toThrow('PATCH failed');
  });

  it('rejects rather than swallowing when the retry PATCH on an existing id fails', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('PATCH failed again'));
    await expect(saveFinishedEntry('Doomed retry.', 55)).rejects.toThrow('PATCH failed again');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
