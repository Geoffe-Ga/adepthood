/**
 * The quiet per-seam notice on a page whose first lines repeat the page before it:
 * how many lines the merge will emit once, and a declinable "Keep them" that puts
 * them back. The merge never drops a repeated line without saying so here, and the
 * writer can always undo it.
 *
 * PRIVACY: the copy, testIDs, and accessibility labels carry only counts and page
 * positions — never a word of the transcript.
 */
import React from 'react';
import { Text, View } from 'react-native';

import styles from './JournalPhotograph.styles';
import type { BlockOverlapNotice } from './useTranscriptionRun';

import { Button } from '@/components/Button';

/** The Keep action's visible label. */
export const KEEP_OVERLAP_LABEL = 'Keep them';

/** The notice copy: counts and positions only. */
export function overlapNoticeCopy(lineCount: number, earlierPosition: number): string {
  if (lineCount === 1) {
    return `The first line repeats page ${earlierPosition}, so it'll appear once when these pages merge.`;
  }
  return `The first ${lineCount} lines repeat page ${earlierPosition}, so they'll appear once when these pages merge.`;
}

/** The Keep action's accessible name: its visible label first (so a voice-control
 *  user can say what they see, WCAG 2.5.3), then the page it belongs to. */
export function keepOverlapA11y(position: number): string {
  return `${KEEP_OVERLAP_LABEL}: the repeated lines on page ${position}`;
}

interface SeamOverlapNoticeProps {
  /** The 1-based position of the later page this notice sits on. */
  position: number;
  overlap: BlockOverlapNotice;
  onKeep: () => void;
}

/** The notice and its Keep them undo, shown on the later page of an overlapping seam. */
export function SeamOverlapNotice({
  position,
  overlap,
  onKeep,
}: SeamOverlapNoticeProps): React.JSX.Element {
  return (
    <View style={styles.overlapNotice}>
      <Text testID={`photograph-block-${position}-overlap`} style={styles.notice} accessible>
        {overlapNoticeCopy(overlap.lineCount, overlap.earlierPosition)}
      </Text>
      <Button
        testID={`photograph-block-${position}-overlap-keep`}
        variant="tertiary"
        label={KEEP_OVERLAP_LABEL}
        accessibilityLabel={keepOverlapA11y(position)}
        onPress={onKeep}
      />
    </View>
  );
}

export default SeamOverlapNotice;
