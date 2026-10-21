/**
 * ``JournalPrimaryInvitation`` — the shelf's ONE call to write (issue #2867).
 *
 * On a review day an undismissed review is the invitation: "Write your Weekly
 * Review" (or Stage, Section, Course), opening that review — or continuing it
 * if already begun. On every other day, or once that review is set aside, the
 * daily page is: the morning-pages tip's "Begin a page", subject to its own
 * declines — set aside for today, or not offered again (#3005). The review
 * shows whatever the tip's state says, because the two are separate offers
 * declined separately.
 *
 * Beneath either — and beneath neither, when both have been set aside — sits a
 * "Start a review early" card that explains reviews and opens the
 * ``ReviewScopePicker`` for every layer still in progress. Nothing is gated:
 * any review can be begun on any day. Declining the tip — its corner X or its
 * "Don't show this again" link — hands focus to that card's action, so a
 * keyboard or screen-reader user is not dropped to the top of the page when
 * the card goes (#2860).
 *
 * The shelf stays mounted across tab switches, so each focus bumps a count the
 * tip re-reads its stored state on: a tip set aside yesterday, or offered again
 * from Settings, is back on the next visit without a remount.
 *
 * No card renders until the due lookup first settles. Showing the daily page
 * meanwhile and swapping it for the review would put a mis-tap one network
 * round-trip wide on the first screenful.
 */
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';

import EarlyReviewCard from './EarlyReviewCard';
import MorningPagesTip from './MorningPagesTip';
import ReflectionInvitationBand from './ReflectionInvitationBand';
import { reviewEntryParams, type ReviewEntryParams } from './reviewScopes';
import SetAsideWritingPrompts from './SetAsideWritingPrompts';
import { useDueReview } from './useDueReview';

import type { RootStackParamList } from '@/navigation/RootStack';
import { moveAccessibilityFocus } from '@/utils/accessibilityFocus';

type InvitationNavigation = NativeStackNavigationProp<RootStackParamList>;

export interface JournalPrimaryInvitationProps {
  /** Opens a fresh daily page carrying its dated title. */
  onBeginPage: (_prefillTitle: string) => void;
}

/** The card in the primary slot: the due review, the daily page, or — while loading — nothing. */
function PrimaryCard({
  onBeginPage,
  onOpenReview,
  onTipDismissed,
  focusCount,
  due,
}: {
  onBeginPage: (_prefillTitle: string) => void;
  onOpenReview: () => void;
  onTipDismissed: () => void;
  focusCount: number;
  due: ReturnType<typeof useDueReview>;
}): React.JSX.Element | null {
  if (due.status === 'loading') return null;
  if (due.review == null) {
    return (
      <MorningPagesTip onBegin={onBeginPage} onDismissed={onTipDismissed} refreshKey={focusCount} />
    );
  }
  return (
    <ReflectionInvitationBand
      review={due.review}
      onOpen={onOpenReview}
      onDismiss={() => {
        due.dismiss();
        onTipDismissed();
      }}
    />
  );
}

function useEarlyReview(navigation: InvitationNavigation) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const togglePicker = useCallback(() => setPickerOpen((open) => !open), []);
  const chooseEarly = useCallback(
    (params: ReviewEntryParams) => {
      setPickerOpen(false);
      navigation.navigate('JournalEntry', params);
    },
    [navigation],
  );
  return { pickerOpen, togglePicker, chooseEarly };
}

function JournalPrimaryInvitation({
  onBeginPage,
}: JournalPrimaryInvitationProps): React.JSX.Element {
  const navigation = useNavigation<InvitationNavigation>();
  const due = useDueReview();
  const { pickerOpen, togglePicker, chooseEarly } = useEarlyReview(navigation);
  // Always mounted, so the tip's X can hand focus here synchronously as it goes.
  const earlyLinkRef = useRef<View>(null);
  const focusEarlyLink = useCallback(() => {
    moveAccessibilityFocus(earlyLinkRef.current);
    setFocusCount((count) => count + 1);
  }, []);
  // Bumped on every focus so an open picker re-reads /reflections/current (a
  // scope claimed while the writer was away must be offered to continue) and
  // the tip re-reads its stored decline (a new day, or a Settings restore).
  const [focusCount, setFocusCount] = useState(0);
  useFocusEffect(
    useCallback(() => {
      setFocusCount((count) => count + 1);
    }, []),
  );

  const refreshTip = useCallback(() => setFocusCount((count) => count + 1), []);

  const openReview = useCallback(() => {
    if (due.review == null) return;
    navigation.navigate('JournalEntry', reviewEntryParams(due.review.scope, due.review.stageTitle));
  }, [navigation, due.review]);

  return (
    <View>
      <PrimaryCard
        onBeginPage={onBeginPage}
        onOpenReview={openReview}
        onTipDismissed={focusEarlyLink}
        focusCount={focusCount}
        due={due}
      />
      <EarlyReviewCard
        actionRef={earlyLinkRef}
        enabled={pickerOpen}
        onToggle={togglePicker}
        refreshKey={focusCount}
        onChoose={chooseEarly}
      />
      <SetAsideWritingPrompts
        review={due.setAsideReview}
        onRestoreReview={due.restore}
        refreshKey={focusCount}
        onRestored={refreshTip}
      />
    </View>
  );
}

export default JournalPrimaryInvitation;
