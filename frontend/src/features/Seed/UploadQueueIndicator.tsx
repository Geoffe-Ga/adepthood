/**
 * "Uploading · 37 remaining" -- the upload queue, visible from anywhere in the
 * app (#3772), with "· 3 failed" once any has (#3771).
 *
 * The queue outlives the Seed screen, so something outside that screen has to
 * say it is still going: otherwise a person who moved on to their journal
 * would have documents arriving in their vault that nothing on screen
 * mentions, the very divergence #2426 stopped runs on unmount to avoid. Pressing
 * it opens the run on the seeding screen, where each row says where it got to.
 *
 * Mounted once, beside the offline banner, so it is also where the page warns
 * before a tab close takes the queue with it.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity } from 'react-native';

import { uploadQueueIndicatorLine } from './seedCopy';
import { useUnloadWarning } from './useUnloadWarning';

import { accent, SPACING, surface, ink, touchTarget } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';
import {
  selectUploadQueueFailed,
  selectUploadQueueRemaining,
  useUploadQueueStore,
} from '@/store/useUploadQueueStore';

/** What the indicator says to a screen reader it does when pressed. */
const OPEN_RUN_HINT = "Opens Bring in what you've written, where each document's progress is.";

/** The app-wide indicator of a running upload queue; nothing while idle. */
export function UploadQueueIndicator(): React.JSX.Element | null {
  const isSending = useUploadQueueStore((state) => state.isSending);
  const remaining = useUploadQueueStore(selectUploadQueueRemaining);
  const failed = useUploadQueueStore(selectUploadQueueFailed);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  useUnloadWarning(isSending);
  if (!isSending || remaining === 0) return null;
  const line = uploadQueueIndicatorLine(remaining, failed);
  return (
    <TouchableOpacity
      style={styles.indicator}
      onPress={() => navigation.navigate('SeedCorpus')}
      accessibilityRole="button"
      accessibilityLabel={line}
      accessibilityHint={OPEN_RUN_HINT}
      accessibilityLiveRegion="polite"
      testID="upload-queue-indicator"
    >
      <ActivityIndicator color={accent.primary} size="small" />
      <Text style={styles.text} testID="upload-queue-indicator-line">
        {line}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  indicator: {
    alignItems: 'center',
    backgroundColor: surface.sunken,
    borderBottomColor: surface.hairline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: SPACING.sm,
    justifyContent: 'center',
    minHeight: touchTarget.minimum,
    paddingHorizontal: SPACING.lg,
  },
  text: {
    color: ink.primary,
    fontWeight: '600',
  },
});
