import { describe, expect, it } from '@jest/globals';

import { ReplayCalendarRegistry } from '../replayCalendarRegistry';

function accountLifecycle(initialOwner: number | null) {
  let owner = initialOwner;
  let transitioning = false;
  let notify = (): void => {};
  return {
    lifecycle: {
      currentOwner: () => owner,
      transitioning: () => transitioning,
      subscribe: (listener: () => void) => {
        notify = listener;
      },
    },
    moveTo(nextOwner: number | null) {
      transitioning = true;
      notify();
      owner = nextOwner;
      transitioning = false;
      notify();
    },
  };
}

describe('ReplayCalendarRegistry', () => {
  it('bounds retained calendars while accounts cycle and logout', () => {
    const account = accountLifecycle(1);
    const calendars = new ReplayCalendarRegistry(account.lifecycle);

    for (let owner = 1; owner <= 12; owner += 1) {
      if (owner > 1) account.moveTo(owner);
      calendars.prepare(owner, `Etc/GMT+${owner}`, true);
      expect(calendars.retainedCount).toBe(1);
    }

    account.moveTo(null);
    expect(calendars.retainedCount).toBe(0);
  });

  it('keeps the same-owner calendar live for an in-flight drain', () => {
    const calendars = new ReplayCalendarRegistry(accountLifecycle(7).lifecycle);
    const first = calendars.prepare(7, 'UTC', true).calendar;
    const second = calendars.prepare(7, 'America/Los_Angeles', true).calendar;

    expect(second).toBe(first);
    expect(first.zone).toBe('America/Los_Angeles');
  });

  it('does not retain provisional calendars that are not ready to replay', () => {
    const calendars = new ReplayCalendarRegistry(accountLifecycle(3).lifecycle);

    calendars.prepare(3, 'UTC', false);

    expect(calendars.retainedCount).toBe(0);
  });
});
