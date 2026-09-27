/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import type { CreateKeyRef } from '../createKey';
import type { SentPage } from '../replayReconcile';
import { saveFinishedEntry } from '../saveFinishedEntry';

import type { JournalMessage } from '@/api';

const mockCreate = jest.fn() as jest.MockedFunction<
  (_e: unknown, _options?: unknown) => Promise<JournalMessage>
>;
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
    // No key held: the create goes out unkeyed, with empty options (#2936).
    expect(mockCreate).toHaveBeenCalledWith({ message: 'A fresh page.' }, {});
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

  it('never sends classification on a retry PATCH, even when one is passed', async () => {
    mockUpdate.mockResolvedValueOnce(entry({ id: 55, status: 'finished' }));
    await saveFinishedEntry('Retried text.', 55, undefined, undefined, 'intimate');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(55, { message: 'Retried text.', status: 'finished' });
  });
});

describe('saveFinishedEntry — entry date', () => {
  it('sends the chosen entry_date on create', async () => {
    mockCreate.mockResolvedValueOnce(entry({ id: 7 }));
    mockUpdate.mockResolvedValueOnce(entry({ id: 7, status: 'finished' }));
    await saveFinishedEntry('A page.', undefined, undefined, '2026-07-05');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'A page.', entry_date: '2026-07-05' }),
      {},
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

// #2936: a capture whose create answer was lost must not become two entries.
describe('saveFinishedEntry — one captured page, one entry', () => {
  function keysSent(): unknown[] {
    return mockCreate.mock.calls.map(
      (call) => (call[1] as { idempotencyKey?: string } | undefined)?.idempotencyKey,
    );
  }

  it('sends every create attempt of one capture under one key', async () => {
    const key: CreateKeyRef<SentPage> = { current: null };
    mockCreate.mockRejectedValueOnce(new Error('network'));
    await expect(
      saveFinishedEntry('A page.', null, undefined, undefined, undefined, key),
    ).rejects.toThrow('network');
    mockCreate.mockResolvedValueOnce(entry({ id: 9 }));
    mockUpdate.mockResolvedValueOnce(entry({ id: 9, status: 'finished' }));

    await expect(
      saveFinishedEntry('A page.', null, undefined, undefined, undefined, key),
    ).resolves.toBe(9);

    const [first, second] = keysSent();
    expect(typeof first).toBe('string');
    expect(second).toBe(first);
  });

  it('a first-try create finishes with the status alone', async () => {
    mockCreate.mockResolvedValueOnce(entry({ id: 9 }));
    mockUpdate.mockResolvedValueOnce(entry({ id: 9, status: 'finished' }));

    await saveFinishedEntry('A page.', null, undefined, undefined, 'intimate', { current: null });

    expect(mockUpdate).toHaveBeenCalledWith(9, { status: 'finished' });
  });

  it('a resent create finishes with the current body and tier, which a replay may not hold', async () => {
    const key: CreateKeyRef<SentPage> = { current: null };
    mockCreate.mockRejectedValueOnce(new Error('network'));
    await saveFinishedEntry('A page.', null, undefined, undefined, 'personal', key).catch(
      () => undefined,
    );
    mockCreate.mockResolvedValueOnce(
      entry({ id: 9, message: 'A page.', classification: 'personal' }),
    );
    mockUpdate.mockResolvedValueOnce(entry({ id: 9, status: 'finished' }));

    await saveFinishedEntry('A page, corrected.', null, undefined, undefined, 'intimate', key);

    expect(mockUpdate).toHaveBeenCalledWith(9, {
      message: 'A page, corrected.',
      classification: 'intimate',
      status: 'finished',
    });
  });

  it('a resent create never loosens, or rewrites, what the replayed row holds', async () => {
    // The capture's first create landed and the entry was since made Intimate
    // elsewhere; this retry sends the same words at the same Personal tier.
    const key: CreateKeyRef<SentPage> = { current: null };
    mockCreate.mockRejectedValueOnce(new Error('network'));
    await saveFinishedEntry('A page.', null, undefined, undefined, 'personal', key).catch(
      () => undefined,
    );
    mockCreate.mockResolvedValueOnce(
      entry({ id: 9, message: 'A page.', classification: 'intimate' }),
    );
    mockUpdate.mockResolvedValueOnce(entry({ id: 9, status: 'finished' }));

    await saveFinishedEntry('A page.', null, undefined, undefined, 'personal', key);

    expect(mockUpdate.mock.calls).toEqual([[9, { status: 'finished' }]]);
  });
});
