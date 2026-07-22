/**
 * ``MorningPagesTip`` — a one-time morning-pages suggestion on the Journal
 * shelf. Self-contained like ``ReflectionInvitationBand``: it loads its own
 * persisted dismissal flag and quietly renders nothing while that flag is
 * still loading (so the band never flashes) or once the tip was set aside.
 *
 * "You choose your depth": this is a warm, one-tap-declinable suggestion —
 * never a gate and never gamified. There is deliberately no streak, no count,
 * and no guilt copy. Either affordance retires the tip for good; beginning a
 * page simply also hands off to the shelf's new-entry flow.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  MORNING_PAGES_BODY,
  MORNING_PAGES_CTA,
  MORNING_PAGES_CTA_A11Y,
  MORNING_PAGES_DISMISS,
  MORNING_PAGES_DISMISS_A11Y,
  MORNING_PAGES_LABEL,
  MORNING_PAGES_TITLE,
} from './morningPagesCopy';
import ReflectionDismiss from './ReflectionDismiss';

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
  loadMorningPagesTipDismissed,
  saveMorningPagesTipDismissed,
} from '@/storage/morningPagesTipStorage';

/** The band's identifying warm left rule (matches the shelf's other bands), in dp. */
const ACCENT_BAR_WIDTH = 3;

export interface MorningPagesTipProps {
  /** Opens the shelf's new-entry flow so the person can start a page right away. */
  onBegin: () => void;
}

/**
 * Owns the dismissal state, the load-on-mount, and the begin/dismiss actions.
 * ``dismissed`` starts null while the persisted flag loads; both actions
 * persist the flag and retire the band, and only ``onBeginPress`` hands off
 * to ``onBegin``.
 */
function useMorningPagesTip(onBegin: () => void) {
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void loadMorningPagesTipDismissed().then((stored) => {
      if (active) setDismissed(stored);
    });
    return () => {
      active = false;
    };
  }, []);

  const onBeginPress = useCallback(() => {
    void saveMorningPagesTipDismissed(true);
    setDismissed(true);
    onBegin();
  }, [onBegin]);

  const onDismiss = useCallback(() => {
    void saveMorningPagesTipDismissed(true);
    setDismissed(true);
  }, []);

  return { dismissed, onBeginPress, onDismiss };
}

function MorningPagesTip({ onBegin }: MorningPagesTipProps): React.JSX.Element | null {
  const { dismissed, onBeginPress, onDismiss } = useMorningPagesTip(onBegin);
  // Null while loading (no flash) and true once set aside both stay quiet.
  if (dismissed !== false) return null;

  // A plain container, not a pressable, so the inner "begin" and "decline"
  // buttons stay independently reachable by assistive tech (a pressable
  // wrapper would collapse the subtree and hide the one-tap decline).
  return (
    <View style={styles.band}>
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
      <ReflectionDismiss
        label={MORNING_PAGES_DISMISS}
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
    padding: SPACING.lg,
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
  },
  label: {
    ...editorialType.caption,
    color: ink.muted,
    textTransform: 'uppercase',
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
});

export default MorningPagesTip;
