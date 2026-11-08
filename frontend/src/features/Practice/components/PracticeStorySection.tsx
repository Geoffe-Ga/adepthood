import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PracticeStory } from './PracticeStory';

import { ink, rhythm, touchTarget, uiType } from '@/design/tokens';
import { usePracticeStory } from '@/features/Practice/hooks/usePracticeStory';
import { useStageColorName } from '@/store/stageColorName';

export function PracticeStorySection({
  practiceId,
  stageNumber,
}: {
  practiceId: number;
  stageNumber: number;
}) {
  const result = usePracticeStory(practiceId, stageNumber);
  const stageName = useStageColorName(stageNumber);
  if (result.error !== null)
    return (
      <View style={styles.error} testID="practice-story-error">
        <Text style={styles.message}>Your practice record could not load.</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void result.refresh();
          }}
          style={styles.retry}
        >
          <Text style={styles.message}>Retry</Text>
        </Pressable>
      </View>
    );
  return (
    <PracticeStory
      story={result.story}
      stageName={stageName ?? `Stage ${stageNumber}`}
      timezone={result.timezone}
    />
  );
}
const styles = StyleSheet.create({
  error: {
    marginVertical: rhythm.blockGap,
    flexDirection: 'row',
    alignItems: 'center',
    gap: rhythm.blockGap,
  },
  message: { ...uiType.button, color: ink.soft, flexShrink: 1 },
  retry: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    justifyContent: 'center',
  },
});
