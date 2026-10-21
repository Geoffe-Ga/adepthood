/**
 * How the Notification Center (#3142) learns which of its self-contained
 * sections have something to show, so it can head only those and say "Nothing
 * waiting." when no item waits.
 *
 * The sections (stat tiles, Return, invitations, the voice band) each own their
 * data and render nothing when empty, which is right on the Journal home and
 * stays right here. Rather than fetch everything a second time to decide its
 * headings, the screen provides a reporter and each section tells it, from the
 * state it already holds, whether it is showing and how many items it shows.
 * Outside a provider (on the home) reporting is a no-op, so the sections behave
 * exactly as before.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react';

/** The sections that report themselves. Stage prompts are read by the screen directly. */
export type NotificationSlot = 'today' | 'return' | 'invitations' | 'voice' | 'writing';

/** Whether a section is on screen, and how many waiting items it holds. */
export interface SlotPresence {
  visible: boolean;
  count: number;
}

/** Record a section's presence; ``null`` when it unmounts. */
export type ReportPresence = (_slot: NotificationSlot, _presence: SlotPresence | null) => void;

const PresenceContext = createContext<ReportPresence | null>(null);

/** Supplies the reporter the sections below call. */
export const NotificationPresenceProvider = PresenceContext.Provider;

/**
 * Report this section's presence to an enclosing Notification Center.
 *
 * A layout effect, so a heading over a section that just appeared lands in the
 * same paint as the section rather than one frame behind it. The slot is
 * cleared on unmount — a ring declined mid-visit unmounts its section, and its
 * heading must go with it.
 */
export function useReportNotificationPresence(
  slot: NotificationSlot,
  visible: boolean,
  count: number,
): void {
  const report = useContext(PresenceContext);
  useLayoutEffect(() => {
    report?.(slot, { visible, count });
  }, [report, slot, visible, count]);
  useLayoutEffect(() => () => report?.(slot, null), [report, slot]);
}

/** The screen's view of what its sections reported. */
export interface PresenceTally {
  report: ReportPresence;
  /** True while ``slot`` reports itself on screen. */
  isVisible: (_slot: NotificationSlot) => boolean;
  /** Waiting items across every reporting section. */
  count: number;
}

type Slots = Partial<Record<NotificationSlot, SlotPresence>>;

/** Same presence as before, so an unchanged report does not re-render the screen. */
function samePresence(a: SlotPresence | undefined, b: SlotPresence | null): boolean {
  if (a === undefined || b === null) return a === undefined && b === null;
  return a.visible === b.visible && a.count === b.count;
}

/** Collects the reports of the sections beneath a ``NotificationPresenceProvider``. */
export function usePresenceTally(): PresenceTally {
  const [slots, setSlots] = useState<Slots>({});
  const report = useCallback<ReportPresence>((slot, presence) => {
    setSlots((prev) => {
      if (samePresence(prev[slot], presence)) return prev;
      const next = { ...prev };
      if (presence === null) delete next[slot];
      else next[slot] = presence;
      return next;
    });
  }, []);
  return useMemo(() => {
    const present = Object.values(slots).filter((p) => p.visible);
    return {
      report,
      isVisible: (slot: NotificationSlot) => slots[slot]?.visible === true,
      count: present.reduce((sum, p) => sum + p.count, 0),
    };
  }, [slots, report]);
}
