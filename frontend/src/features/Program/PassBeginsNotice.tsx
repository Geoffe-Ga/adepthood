import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { accent, BORDER_RADIUS, ink, SPACING, surface } from '../../design/tokens';
import { useProgramStore } from '../../store/useProgramStore';
import { MS_PER_DAY } from '../../utils/dateUtils';
import { useDayKey } from '../../utils/dayRollover';

import { nextPassNotice, programBeginsNotice } from './passCopy';

/** Whole days from ``from`` to ``to``, both ``YYYY-MM-DD`` calendar days. */
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);

/**
 * The one line, if any, about a pass that has not begun (#3728).
 *
 * A pass held for the future comes first: while it waits the current pass
 * keeps running, and the line says only when the next one begins. Otherwise a
 * first pass placed in the future -- the "not yet begun" state the server
 * reports as a positive ``days_until_start`` -- is named with its countdown.
 * Both are counted against today in the account zone rather than the read, so
 * a line left on screen across midnight never overstates, and it retracts on
 * the day itself, before the next read settles the pass.
 */
function useNoticeCopy(tz: string): string | null {
  const today = useDayKey(tz);
  const pending = useProgramStore((s) => s.pendingPassStartsOn);
  const daysUntilStart = useProgramStore((s) => s.daysUntilStart);
  const anchorDay = useProgramStore((s) => s.programStartDay);
  return useMemo(() => {
    if (pending !== null && pending > today) return nextPassNotice(pending);
    if (daysUntilStart <= 0 || anchorDay === null) return null;
    const left = daysBetween(today, anchorDay);
    return left > 0 ? programBeginsNotice(anchorDay, left) : null;
  }, [today, pending, daysUntilStart, anchorDay]);
}

interface PassBeginsNoticeProps {
  /** The account zone "today" is read in. */
  tz: string;
  /**
   * How far in from the content edge the surface beneath it starts, so the
   * notice hangs from the same edge as the grid it sits above (DESIGN.md, "One
   * edge"). Zero when it sits on the content edge itself.
   */
  inset?: number;
}

/**
 * Quiet, informational line above the Habits grid while a pass waits to
 * begin. No call to action, no badge, no urgency (``NORTH-STAR.md``): it is
 * there to answer "when does it start?", and asks nothing back. Renders
 * nothing at all otherwise.
 */
export function PassBeginsNotice({
  tz,
  inset = 0,
}: PassBeginsNoticeProps): React.JSX.Element | null {
  const copy = useNoticeCopy(tz);
  if (copy === null) return null;
  return (
    <View
      accessibilityRole="text"
      style={[styles.notice, { marginHorizontal: inset }]}
      testID="pass-begins-notice"
    >
      <Text style={styles.message}>{copy}</Text>
    </View>
  );
}

/** The terracotta rule down the notice's leading edge, in logical pixels. */
const ACCENT_RULE_WIDTH = 4;

// The recessed Candle-and-Ink well the dropped-check-in notice uses, with the
// terracotta accent as its rule: a note about the program, not a warning. The
// static (light) tokens, like that notice's, because the Habits ground it sits
// on is the light canvas in either mode -- a themed well would read as a dark
// band on a light page.
const styles = StyleSheet.create({
  notice: {
    backgroundColor: surface.sunken,
    borderLeftColor: accent.primary,
    borderLeftWidth: ACCENT_RULE_WIDTH,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
  },
  message: {
    flexShrink: 1,
    color: ink.primary,
  },
});
