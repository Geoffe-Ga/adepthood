import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';

import type { Stage } from '../../api';

import styles from './Course.styles';
import { getStageColor, isCompleted, isUnlocked, totalStageCount } from './stageDisplay';

interface StageSelectorProps {
  stages: Stage[];
  selectedStage: number;
  onSelectStage: (_stageNumber: number) => void;
}

interface StagePillProps {
  stageNumber: number;
  unlocked: boolean;
  completed: boolean;
  isActive: boolean;
  color: string;
  onSelectStage: (_stageNumber: number) => void;
}

/** A single stage pill — extracted so the selector's render stays shallow. */
const StagePill = ({
  stageNumber,
  unlocked,
  completed,
  isActive,
  color,
  onSelectStage,
}: StagePillProps): React.JSX.Element => (
  <TouchableOpacity
    testID={`stage-pill-${stageNumber}`}
    accessible
    accessibilityRole="button"
    accessibilityLabel={`Stage ${stageNumber}${!unlocked ? ', locked' : ''}${completed ? ', completed' : ''}`}
    accessibilityState={{ selected: isActive, disabled: !unlocked }}
    disabled={!unlocked}
    onPress={() => onSelectStage(stageNumber)}
    style={[
      styles.stagePill,
      { backgroundColor: color },
      isActive && styles.stagePillActive,
      !unlocked && styles.stagePillLocked,
      completed && !isActive && styles.stagePillCompleted,
    ]}
  >
    {completed ? (
      <Text style={styles.stagePillCheck}>{'✓'}</Text>
    ) : !unlocked ? (
      <Text style={styles.stagePillLock}>{'🔒'}</Text>
    ) : (
      <Text style={styles.stagePillText}>{stageNumber}</Text>
    )}
  </TouchableOpacity>
);

const StageSelector = ({
  stages: stagesList,
  selectedStage,
  onSelectStage,
}: StageSelectorProps): React.JSX.Element => {
  // Index the stages once so each pill's lookup is O(1); the previous
  // per-pill `stages.find()` made the render O(N²) in stage count.
  const stageById = React.useMemo(
    () => new Map(stagesList.map((s) => [s.stage_number, s])),
    [stagesList],
  );
  return (
    <View style={styles.stageSelectorContainer} testID="stage-selector">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.stageSelectorContent}
      >
        {Array.from({ length: totalStageCount(stagesList) }, (_, i) => {
          const stageNumber = i + 1;
          return (
            <StagePill
              key={stageNumber}
              stageNumber={stageNumber}
              unlocked={isUnlocked(stageNumber, stageById)}
              completed={isCompleted(stageNumber, stageById)}
              isActive={stageNumber === selectedStage}
              color={getStageColor(stageNumber, stageById)}
              onSelectStage={onSelectStage}
            />
          );
        })}
      </ScrollView>
    </View>
  );
};

export default StageSelector;
