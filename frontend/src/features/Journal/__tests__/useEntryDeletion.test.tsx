/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useEntryDeletion } from '../useEntryDeletion';

import type { JournalMessage } from '@/api';

const mockDelete = jest.fn() as jest.MockedFunction<(_id: number) => Promise<void>>;

jest.mock('@/api', () => ({
  journal: {
    delete: (...a: unknown[]) => (mockDelete as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

function entry(id: number, timestamp: string): JournalMessage {
  return {
    id,
    message: `Body ${id}`,
    sender: 'user',
    timestamp,
    tag: 'reflection' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: `Entry ${id}`,
    status: 'finished',
    updated_at: timestamp,
  };
}

const NEWEST = entry(3, '2026-06-03T00:00:00Z');
const MIDDLE = entry(2, '2026-06-02T00:00:00Z');
const OLDEST = entry(1, '2026-06-01T00:00:00Z');

/** Drive the hook over a list held outside it, as the shelf holds its own. */
function harness(initial: JournalMessage[]) {
  const state = { items: initial, total: initial.length };
  const setItems = jest.fn((update: unknown) => {
    state.items =
      typeof update === 'function'
        ? (update as (_prev: JournalMessage[]) => JournalMessage[])(state.items)
        : (update as JournalMessage[]);
  });
  const adjustTotal = jest.fn((delta: number) => {
    state.total = Math.max(0, state.total + delta);
  });
  const rendered = renderHook(() =>
    useEntryDeletion({ items: state.items, setItems, adjustTotal }),
  );
  return { state, setItems, adjustTotal, ...rendered };
}

beforeEach(() => {
  mockDelete.mockReset();
  mockDelete.mockResolvedValue(undefined);
});

describe('useEntryDeletion', () => {
  it('drops the row and pulls the reported total down with it', async () => {
    const h = harness([NEWEST, MIDDLE, OLDEST]);

    act(() => h.result.current.request(MIDDLE));
    await act(async () => {
      h.result.current.confirm();
    });

    expect(mockDelete).toHaveBeenCalledWith(2);
    expect(h.state.items.map((row) => row.id)).toEqual([3, 1]);
    expect(h.state.total).toBe(2);
  });

  it('puts a refused oldest row back at the end, not at the top of the shelf', async () => {
    mockDelete.mockRejectedValue(new Error('offline'));
    const h = harness([NEWEST, MIDDLE, OLDEST]);

    act(() => h.result.current.request(OLDEST));
    await act(async () => {
      h.result.current.confirm();
    });

    await waitFor(() => expect(h.result.current.error).not.toBeNull());
    // Newest-first order survives the round trip: the row returns where it was.
    expect(h.state.items.map((row) => row.id)).toEqual([3, 2, 1]);
    expect(h.state.total).toBe(3);
  });

  it('refuses a second delete for a row already in flight', async () => {
    let settle = (): void => {};
    mockDelete.mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const h = harness([NEWEST, MIDDLE]);

    act(() => h.result.current.request(MIDDLE));
    act(() => h.result.current.confirm());
    act(() => h.result.current.request(MIDDLE));
    act(() => h.result.current.confirm());

    expect(mockDelete).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle();
    });
  });

  it('does nothing when a confirmation arrives with no page pending', async () => {
    const h = harness([NEWEST]);

    await act(async () => {
      h.result.current.confirm();
    });

    expect(mockDelete).not.toHaveBeenCalled();
    expect(h.state.items.map((row) => row.id)).toEqual([3]);
  });
});
