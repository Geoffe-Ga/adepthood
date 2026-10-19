export interface ReplayCalendar {
  zone: string;
}

interface AccountLifecycle {
  currentOwner: () => number | null;
  transitioning: () => boolean;
  subscribe: (_listener: () => void) => void;
}

/**
 * The latest authoritative calendar for each replay owner.
 *
 * A drain keeps the returned object itself, so releasing the registry entry at
 * a session boundary cannot change an in-flight drain or its single-flight
 * coordination. A same-owner refresh deliberately receives the same object:
 * if authentication finishes resolving a provisional timezone while a queue
 * read is pending, the unsent entry must use that newer calendar.
 */
export class ReplayCalendarRegistry {
  private readonly calendars = new Map<number | null, ReplayCalendar>();

  constructor(lifecycle: AccountLifecycle) {
    lifecycle.subscribe(() => {
      this.releaseObsolete(lifecycle.currentOwner(), lifecycle.transitioning());
    });
  }

  get retainedCount(): number {
    return this.calendars.size;
  }

  prepare(
    owner: number | null,
    zone: string,
    replayReady: boolean,
  ): { calendar: ReplayCalendar; replayReady: boolean } {
    if (!replayReady) return { calendar: { zone }, replayReady };
    const calendar = this.calendars.get(owner) ?? { zone };
    calendar.zone = zone;
    this.calendars.set(owner, calendar);
    return { calendar, replayReady };
  }

  /** Keep only the current settled owner's calendar, or none during teardown. */
  private releaseObsolete(currentOwner: number | null, transitioning: boolean): void {
    for (const owner of this.calendars.keys()) {
      if (transitioning || owner !== currentOwner) this.calendars.delete(owner);
    }
  }
}
