// #2935 round 9: the serialized tier-write queue. Writer taps are last-wins
// among themselves; the #2930 retry and the carried-words escalation ("system"
// writes) never replace a queued writer tap and never send a tier looser than
// the writer's latest request.
import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useTierWriteQueue } from '../useTierWriteQueue';

import type { JournalClassification } from '@/api';

type Change = (_tier: JournalClassification) => Promise<JournalClassification | null>;

/** A change double: each call waits until the test settles it. */
function changeDouble() {
  const sent: JournalClassification[] = [];
  const settlers: ((_revertTo: JournalClassification | null) => void)[] = [];
  const change = jest.fn<Change>(
    (tier) =>
      new Promise((resolve) => {
        sent.push(tier);
        settlers.push(resolve);
      }),
  );
  /** Settle the n-th sent write with ``revertTo`` (null = success). */
  const settle = async (n: number, revertTo: JournalClassification | null = null) => {
    await act(async () => {
      settlers[n]?.(revertTo);
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  return { change, sent, settle };
}

function setup() {
  const double = changeDouble();
  const { result } = renderHook(() => useTierWriteQueue(double.change));
  return { ...double, queue: () => result.current };
}

describe('useTierWriteQueue (#2935)', () => {
  it('sends at once when idle and tracks the writer request', async () => {
    const { queue, sent } = setup();
    void queue().enqueue('personal', 'writer');
    expect(sent).toEqual(['personal']);
    expect(queue().requestedTier()).toBe('personal');
  });

  it('queues writer taps behind the write in flight, last tap wins', async () => {
    const { queue, sent, settle } = setup();
    void queue().enqueue('public', 'writer');
    const superseded = queue().enqueue('personal', 'writer');
    void queue().enqueue('intimate', 'writer');
    expect(queue().requestedTier()).toBe('intimate');
    await expect(superseded).resolves.toBeNull();

    await settle(0);
    expect(sent).toEqual(['public', 'intimate']);
  });

  it('drops a system write no stricter than a queued writer tap, restoring the request', async () => {
    const { queue, sent, settle } = setup();
    void queue().enqueue('public', 'writer');
    void queue().enqueue('intimate', 'writer');

    await expect(queue().enqueue('personal', 'system')).resolves.toBe('intimate');
    await expect(queue().enqueue('intimate', 'system')).resolves.toBe('intimate');
    await settle(0);
    await settle(1);

    expect(sent).toEqual(['public', 'intimate']);
  });

  it('never lets a system write replace a queued writer tap', async () => {
    const { queue, sent, settle } = setup();
    void queue().enqueue('intimate', 'writer');
    void queue().enqueue('public', 'writer');
    void queue().enqueue('personal', 'system');

    await settle(0);
    await settle(1);
    await settle(2);

    // The writer's Public is sent; the stricter Personal then raises it.
    expect(sent).toEqual(['intimate', 'public', 'personal']);
  });

  it('never sends a system write looser than the writer request', async () => {
    const { queue, sent, settle } = setup();
    void queue().enqueue('personal', 'writer');

    await expect(queue().enqueue('public', 'system')).resolves.toBe('personal');
    await settle(0);

    expect(sent).toEqual(['personal']);
  });

  it('drops a queued system write that the writer has since out-asked', async () => {
    const { queue, sent, settle } = setup();
    void queue().enqueue('public', 'writer');
    const system = queue().enqueue('personal', 'system');
    void queue().enqueue('intimate', 'writer');

    await settle(0);
    await settle(1);

    expect(sent).toEqual(['public', 'intimate']);
    await expect(system).resolves.toBe('intimate');
  });

  it('follows a failed writer write back to what the control reverts to', async () => {
    const { queue, settle } = setup();
    void queue().enqueue('public', 'writer');

    await settle(0, 'intimate');

    expect(queue().requestedTier()).toBe('intimate');
  });

  it('keeps a newer writer request when an older writer write fails', async () => {
    const { queue, settle } = setup();
    const first = queue().enqueue('public', 'writer');
    void queue().enqueue('personal', 'writer');

    await settle(0, 'intimate');

    expect(queue().requestedTier()).toBe('personal');
    // Never revert the control over the newer queued choice.
    await expect(first).resolves.toBeNull();
  });
});
