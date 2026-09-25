/**
 * ``JournalPrimaryInvitation`` — the shelf's ONE call to write (issue #2867).
 *
 * On a review day an undismissed review is the invitation: "Write your Weekly
 * Review" (or Stage, Section, Course), opening that review — or continuing it
 * if already begun. On every other day, or once that review is set aside, the
 * daily page is: the morning-pages tip's "Begin a page", subject to its own
 * dismissal. The review shows whatever the tip's dismissal says, because the
 * two are separate offers declined separately.
 *
 * Beneath either — and beneath neither, when both have been set aside — sits a
 * quiet "Start a review early" link that opens the ``ReviewScopePicker`` for
 * every layer still in progress. Nothing is gated: any review can be begun on
 * any day.
 *
 * No card renders until the due lookup first settles. Showing the daily page
 * meanwhile and swapping it for the review would put a mis-tap one network
 * round-trip wide on the first screenful.
 */
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import MorningPagesTip from './MorningPagesTip';
import ReflectionInvitationBand from './ReflectionInvitationBand';
import {
  REVIEW_EARLY_A11Y,
  REVIEW_EARLY_CLOSE,
  REVIEW_EARLY_CLOSE_A11Y,
  REVIEW_EARLY_LINK,
} from './reviewInvitationCopy';
import ReviewScopePicker from './ReviewScopePicker';
import { reviewEntryParams, type ReviewEntryParams } from './reviewScopes';
import { useDueReview } from './useDueReview';

import { Button } from '@/components/Button';
import { SPACING } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';

type InvitationNavigation = NativeStackNavigationProp<RootStackParamList>;

export interface JournalPrimaryInvitationProps {
  /** Opens a fresh daily page carrying its dated title. */
  onBeginPage: (_prefillTitle: string) => void;
}

/** The card in the primary slot: the due review, the daily page, or — while loading — nothing. */
function PrimaryCard({
  onBeginPage,
  onOpenReview,
  due,
}: {
  onBeginPage: (_prefillTitle: string) => void;
  onOpenReview: () => void;
  due: ReturnType<typeof useDueReview>;
}): React.JSX.Element | null {
  if (due.status === 'loading') return null;
  if (due.review == null) return <MorningPagesTip onBegin={onBeginPage} />;
  return (
    <ReflectionInvitationBand review={due.review} onOpen={onOpenReview} onDismiss={due.dismiss} />
  );
}

function JournalPrimaryInvitation({
  onBeginPage,
}: JournalPrimaryInvitationProps): React.JSX.Element {
  const navigation = useNavigation<InvitationNavigation>();
  const due = useDueReview();
  const { review } = due;
  const [pickerOpen, setPickerOpen] = useState(false);
  // Bumped on every focus so an open picker re-reads /reflections/current: a
  // scope claimed while the writer was away must be offered to continue.
  const [focusCount, setFocusCount] = useState(0);
  useFocusEffect(
    useCallback(() => {
      setFocusCount((count) => count + 1);
    }, []),
  );

  const openReview = useCallback(() => {
    if (review == null) return;
    navigation.navigate('JournalEntry', reviewEntryParams(review.scope, review.stageTitle));
  }, [navigation, review]);

  const togglePicker = useCallback(() => setPickerOpen((open) => !open), []);

  const chooseEarly = useCallback(
    (params: ReviewEntryParams) => {
      setPickerOpen(false);
      navigation.navigate('JournalEntry', params);
    },
    [navigation],
  );

  return (
    <View>
      <PrimaryCard onBeginPage={onBeginPage} onOpenReview={openReview} due={due} />
      <Button
        variant="tertiary"
        label={pickerOpen ? REVIEW_EARLY_CLOSE : REVIEW_EARLY_LINK}
        accessibilityLabel={pickerOpen ? REVIEW_EARLY_CLOSE_A11Y : REVIEW_EARLY_A11Y}
        testID="journal-review-early"
        onPress={togglePicker}
        style={styles.earlyLink}
      />
      <ReviewScopePicker enabled={pickerOpen} refreshKey={focusCount} onChoose={chooseEarly} />
    </View>
  );
}

const styles = StyleSheet.create({
  earlyLink: {
    alignSelf: 'flex-start',
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
});

export default JournalPrimaryInvitation;
