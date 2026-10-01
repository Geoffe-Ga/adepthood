/**
 * ``LinkHabitNudge`` — the finished-session note for a timer with no habit
 * linked (#3006).
 *
 * A finished writing timer checks off the habit linked to it, and a writer who
 * has never linked one — because they declined the end-of-session offer, or
 * because they launched a saved practice, whose page never makes that offer —
 * otherwise has nothing on the page saying the choice exists. This note says
 * where it lives and leaves it there: "Go to Settings" opens Settings on the
 * writing-habit picker, and "Don't show again" retires the note on this device
 * until Settings → Journal brings it back.
 *
 * Lives in the ``children`` slot ``WritingSessionBanner`` reserves for the
 * finished session, under the slot's lifetime contract: its state is keyed to
 * the session (the slot is re-keyed per session, so each one gets a fresh
 * mount) and its flags are read once, at mount.
 *
 * **When it appears.** Only when the server has said no habit is linked
 * (``selectKnownUnlinked``: an unhydrated store is unknown, not unlinked), the
 * writer has not declined the note, and — on a page that also carries the
 * end-of-session offer — that offer has already been answered. That last read
 * is what keeps one invitation per note: the offer shows while its flag is
 * unanswered, this note only once it is answered, so the two never share a
 * banner. It is read at mount and not again, so an offer declined in this note
 * is not replaced by this one in the same note; it waits for the next session.
 *
 * Nothing renders while those reads are in flight, so the note never flashes
 * up and then vanishes. And the gate holds no navigation: only the visible note
 * reaches for the navigator, so a note that renders nothing never needs one.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import OfferAction from './OfferAction';
import {
  LINK_HABIT_NUDGE_DECLINE,
  LINK_HABIT_NUDGE_DECLINE_A11Y,
  LINK_HABIT_NUDGE_PROMPT,
  LINK_HABIT_NUDGE_SETTINGS,
  LINK_HABIT_NUDGE_SETTINGS_A11Y,
} from './saveAsHabitCopy';
import { useFocusBannerClose } from './WritingSessionBanner';

import { SPACING, colors, editorialType } from '@/design/tokens';
import { useRootNavigation } from '@/navigation/hooks';
import {
  loadLinkHabitNudgeDeclined,
  saveLinkHabitNudgeDeclined,
} from '@/storage/linkHabitNudgeStorage';
import { loadWritingOfferAnswered } from '@/storage/writingOfferStorage';
import { selectKnownUnlinked, useWritingHabitLinkStore } from '@/store/useWritingHabitLinkStore';

export interface LinkHabitNudgeProps {
  /**
   * The page also carries the end-of-session offer: wait until it has been
   * answered, so the note never shares a banner with it.
   */
  waitForAnsweredOffer?: boolean;
}

/** On a page with no offer, there is nothing to wait for. */
const NO_OFFER_TO_WAIT_FOR = Promise.resolve(true);

/**
 * Whether this note may open, read once at mount: ``null`` while reading, so
 * nothing renders until both flags have landed.
 */
function useNudgeGate(waitForAnsweredOffer: boolean): boolean | null {
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    const offerAnswered = waitForAnsweredOffer ? loadWritingOfferAnswered() : NO_OFFER_TO_WAIT_FOR;
    void Promise.all([loadLinkHabitNudgeDeclined(), offerAnswered]).then(([declined, answered]) => {
      if (mounted) setOpen(!declined && answered);
    });
    return () => {
      mounted = false;
    };
    // Each page passes a fixed ``waitForAnsweredOffer``, so this reads once, at
    // mount: the arbitration with the offer is committed then.
  }, [waitForAnsweredOffer]);
  return open;
}

function LinkHabitNudge({
  waitForAnsweredOffer = false,
}: LinkHabitNudgeProps): React.JSX.Element | null {
  const unlinked = useWritingHabitLinkStore(selectKnownUnlinked);
  const open = useNudgeGate(waitForAnsweredOffer);
  const [dismissed, setDismissed] = useState(false);
  // The decline unmounts the button the writer is on, so focus is handed to
  // the note's Close (still mounted) rather than dropped with it.
  const focusClose = useFocusBannerClose();
  const dismiss = useCallback(() => {
    setDismissed(true);
    void saveLinkHabitNudgeDeclined();
    focusClose();
  }, [focusClose]);

  if (open !== true || !unlinked || dismissed) return null;
  return <LinkHabitNudgeNote onDismiss={dismiss} />;
}

/** The visible note, the only part of it that needs the navigator. */
function LinkHabitNudgeNote({ onDismiss }: { onDismiss: () => void }): React.JSX.Element {
  const navigation = useRootNavigation();
  const openSettings = useCallback(() => {
    navigation.navigate('Settings', { focus: 'writing-habit' });
  }, [navigation]);
  return (
    <View style={styles.note} testID="link-habit-nudge">
      <Text style={styles.prompt}>{LINK_HABIT_NUDGE_PROMPT}</Text>
      <View style={styles.actions}>
        <OfferAction
          label={LINK_HABIT_NUDGE_SETTINGS}
          a11yLabel={LINK_HABIT_NUDGE_SETTINGS_A11Y}
          onPress={openSettings}
          emphasis
          testID="link-habit-nudge-settings"
        />
        <OfferAction
          label={LINK_HABIT_NUDGE_DECLINE}
          a11yLabel={LINK_HABIT_NUDGE_DECLINE_A11Y}
          onPress={onDismiss}
          testID="link-habit-nudge-decline"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    marginTop: SPACING.sm,
    gap: SPACING.xs,
  },
  prompt: {
    ...editorialType.note,
    color: colors.paper.ink,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    flexWrap: 'wrap',
  },
});

export default LinkHabitNudge;
