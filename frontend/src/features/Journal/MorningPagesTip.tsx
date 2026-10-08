/**
 * ``MorningPagesTip`` — the shelf's daily morning-pages invitation.
 * Self-contained like ``ReflectionInvitationBand``: it loads its own persisted
 * decline state and quietly renders nothing while that state is still loading
 * (so the band never flashes) or while the writer has it declined.
 *
 * "You choose your depth": this is a warm, declinable invitation — never a
 * gate and never gamified. There is deliberately no streak, no count, and no
 * guilt copy. It declines two ways (#3005):
 *
 * - The X in the card's top-right corner (#2860) sets it aside for TODAY, the
 *   writer's own day in their profile time zone (``todayInUserTZ``). It is back
 *   on any later day, without nagging, because a morning practice is daily.
 * - The quiet "Don't show this again" link stops offering it at all, until the
 *   writer chooses "Offer morning pages again" in Settings → Journal.
 *
 * "Today" is compared at render, and the stored state is re-read whenever the
 * host's ``refreshKey`` changes (the shelf bumps it on every focus), so a shelf
 * that stays mounted across midnight — or across a restore in Settings — shows
 * the card again on the next visit without a remount.
 *
 * Beginning a page hands off to the shelf's new-entry flow and leaves the tip
 * exactly where it was: taking up an invitation is not declining it, and
 * someone who writes a morning page today is the last person who should lose
 * the reminder tomorrow. (The tip did once treat the CTA as a dismissal — that
 * was the original spec, reversed deliberately.) The card's text controls —
 * "Begin a page" and the never-again link — share one left edge with its
 * words; the X sits apart in the corner.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  MORNING_PAGES_BODY,
  MORNING_PAGES_CTA,
  MORNING_PAGES_CTA_A11Y,
  MORNING_PAGES_DISMISS_A11Y,
  MORNING_PAGES_LABEL,
  MORNING_PAGES_NEVER_A11Y,
  MORNING_PAGES_NEVER_LINK,
  MORNING_PAGES_TITLE,
  morningPageTitle,
} from './morningPagesCopy';
import ReflectionDismiss, { closeCornerReserve } from './ReflectionDismiss';

import { useAuth } from '@/context/AuthContext';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  editorialType,
  ink,
  spacing,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';
import {
  MORNING_PAGES_TIP_OPEN,
  loadMorningPagesTipState,
  saveMorningPagesTipNeverOffer,
  saveMorningPagesTipSetAside,
  type MorningPagesTipState,
} from '@/storage/morningPagesTipStorage';
import { todayInUserTZ } from '@/utils/dateUtils';

/** The band's identifying warm left rule (matches the shelf's other bands), in dp. */
const ACCENT_BAR_WIDTH = 3;

/** The band's inner padding: the gap every edge of the invitation keeps from the card's rim. */
const BAND_PADDING = SPACING.lg;

/** Right-hand room the begin area keeps so neither its text nor its hit area lies under the X. */
const CLOSE_CORNER_RESERVE = closeCornerReserve(BAND_PADDING);

export interface MorningPagesTipProps {
  /** Opens the shelf's new-entry flow so the person can start a page right away. */
  onBegin: (_prefillTitle: string) => void;
  /**
   * Called once the tip has been declined — set aside for today or for good —
   * after the decline is persisted, so the host can hand focus on: the control
   * that held it unmounts with the card.
   */
  onDismissed?: () => void;
  /**
   * Re-read the stored decline whenever this changes. The shelf passes its
   * focus count, so a decline cleared in Settings shows on the next visit.
   */
  refreshKey?: number;
}

/**
 * Owns the decline state, its (re)load, and the begin / set-aside / never
 * actions. ``state`` starts null while the persisted record loads. A re-read
 * keeps the current state on screen until it lands (no flash), and is thrown
 * away if the writer declined while it was in flight: ``writeSeq`` counts the
 * local writes, so a stale read cannot hand back a card just set down.
 */
function useMorningPagesTip(
  onBegin: (_prefillTitle: string) => void,
  onDismissed: (() => void) | undefined,
  refreshKey: number | undefined,
) {
  const { userTimezone } = useAuth();
  const [state, setState] = useState<MorningPagesTipState | null>(null);
  const writeSeq = useRef(0);

  useEffect(() => {
    let active = true;
    const seqAtStart = writeSeq.current;
    void loadMorningPagesTipState().then((stored) => {
      if (active && writeSeq.current === seqAtStart) setState(stored);
    });
    return () => {
      active = false;
    };
  }, [refreshKey]);

  const onBeginPress = useCallback(() => {
    onBegin(morningPageTitle(todayInUserTZ(userTimezone)));
  }, [onBegin, userTimezone]);

  const decline = useCallback(
    (change: Partial<MorningPagesTipState>, persist: () => Promise<unknown>) => {
      writeSeq.current += 1;
      void persist();
      setState((prev) => ({ ...(prev ?? MORNING_PAGES_TIP_OPEN), ...change }));
      onDismissed?.();
    },
    [onDismissed],
  );

  const onDismiss = useCallback(() => {
    const today = todayInUserTZ(userTimezone);
    decline({ setAsideOn: today }, () => saveMorningPagesTipSetAside(today));
  }, [decline, userTimezone]);

  const onNeverOffer = useCallback(() => {
    decline({ neverOffer: true }, () => saveMorningPagesTipNeverOffer(true));
  }, [decline]);

  const shown =
    state !== null && !state.neverOffer && state.setAsideOn !== todayInUserTZ(userTimezone);
  return { shown, onBeginPress, onDismiss, onNeverOffer };
}

function MorningPagesTip({
  onBegin,
  onDismissed,
  refreshKey,
}: MorningPagesTipProps): React.JSX.Element | null {
  const { shown, onBeginPress, onDismiss, onNeverOffer } = useMorningPagesTip(
    onBegin,
    onDismissed,
    refreshKey,
  );
  // Quiet while loading (no flash), set aside for today, or declined for good.
  if (!shown) return null;

  // A plain container, not a pressable, so the inner "begin" and "decline"
  // buttons stay independently reachable by assistive tech (a pressable
  // wrapper would collapse the subtree and hide the one-tap decline). The X is
  // last in the tree so a screen reader meets the invitation before the way to
  // set it aside; absolute placement draws it in the top-right corner.
  return (
    <View style={styles.band} testID="journal-morning-pages-band">
      <TouchableOpacity
        style={styles.openArea}
        onPress={onBeginPress}
        accessibilityRole="button"
        accessibilityLabel={MORNING_PAGES_CTA_A11Y}
        testID="journal-morning-pages-tip"
      >
        <Text style={styles.label}>{MORNING_PAGES_LABEL}</Text>
        <Text style={styles.title}>{MORNING_PAGES_TITLE}</Text>
        <Text style={styles.body}>{MORNING_PAGES_BODY}</Text>
        <Text style={styles.cta}>{MORNING_PAGES_CTA}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.neverArea}
        onPress={onNeverOffer}
        accessibilityRole="button"
        accessibilityLabel={MORNING_PAGES_NEVER_A11Y}
        testID="journal-morning-pages-never"
      >
        <Text style={styles.never}>{MORNING_PAGES_NEVER_LINK}</Text>
      </TouchableOpacity>
      <ReflectionDismiss
        variant="close"
        accessibilityLabel={MORNING_PAGES_DISMISS_A11Y}
        testID="journal-morning-pages-dismiss"
        onPress={onDismiss}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    marginTop: SPACING.lg,
    padding: BAND_PADDING,
    borderRadius: BORDER_RADIUS.md,
    // A raised sheet with the same warm accent rule as the shelf's invitation
    // bands, so the tip reads as part of a matched set.
    backgroundColor: surface.raised,
    borderLeftWidth: ACCENT_BAR_WIDTH,
    borderLeftColor: accent.primary,
    ...surfaceShadow.card,
  },
  openArea: {
    minHeight: touchTarget.minimum,
    marginRight: CLOSE_CORNER_RESERVE,
  },
  label: {
    ...editorialType.caption,
    color: ink.muted,
  },
  title: {
    ...editorialType.heading,
    color: ink.primary,
    paddingTop: spacing(0.5),
  },
  body: {
    ...editorialType.note,
    color: ink.soft,
    paddingTop: spacing(0.5),
  },
  cta: {
    // editorialType.action sits at the INTERACTIVE_TEXT_MIN floor, keeping
    // this tappable label legible without a bespoke size.
    ...editorialType.action,
    color: accent.primary,
    paddingTop: spacing(1),
  },
  neverArea: {
    // A full touch target, hugging its words on the card's text edge and kept
    // out of the X's corner like the begin area above it.
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    marginRight: CLOSE_CORNER_RESERVE,
  },
  never: {
    // Tappable, so the action face at the interactive floor -- but at the body
    // weight and in soft ink, so it reads as a quiet aside beneath the CTA.
    ...editorialType.action,
    fontWeight: editorialType.body.fontWeight,
    color: ink.soft,
  },
});

export default MorningPagesTip;
