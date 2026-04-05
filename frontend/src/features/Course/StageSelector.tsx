import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';

import type { Stage } from '../../api';
import { STAGE_COLORS, STAGE_ORDER } from '../../design/tokens';

import styles from './Course.styles';

const TOTAL_STAGES = 10;

interface StageSelectorProps {
  stages: Stage[];
  selectedStage: number;
  onSelectStage: (_stageNumber: number) => void;
}

/** Get the spiral dynamics color for a stage number (1-indexed). */
function getStageColor(stageNumber: number, stages: Stage[]): string {
  const stage = stages.find((s) => s.stage_number === stageNumber);
  if (stage) {
    return STAGE_COLORS[stage.spiral_dynamics_color] ?? '#888';
  }
  const name = STAGE_ORDER[stageNumber - 1];
  return name ? STAGE_COLORS[name] ?? '#888' : '#888';
}

/** Determine if a stage is unlocked based on API data. */
function isUnlocked(stageNumber: number, stagesList: Stage[]): boolean {
  const stage = stagesList.find((s) => s.stage_number === stageNumber);
  return stage?.is_unlocked ?? false;
}

/** Determine if a stage has been completed (progress === 1.0). */
function isCompleted(stageNumber: number, stagesList: Stage[]): boolean {
  const stage = stagesList.find((s) => s.stage_number === stageNumber);
  return stage != null && stage.progress >= 1.0;
}

const StageSelector = ({
  stages: stagesList,
  selectedStage,
  onSelectStage,
}: StageSelectorProps): React.JSX.Element => {
  return (
    <View style={styles.stageSelectorContainer} testID="stage-selector">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.stageSelectorContent}
      >
        {Array.from({ length: TOTAL_STAGES }, (_, i) => {
          const stageNumber = i + 1;
          const unlocked = isUnlocked(stageNumber, stagesList);
          const completed = isCompleted(stageNumber, stagesList);
          const isActive = stageNumber === selectedStage;
          const color = getStageColor(stageNumber, stagesList);

          return (
            <TouchableOpacity
              key={stageNumber}
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
        })}
      </ScrollView>
    </View>
  );
};

export default StageSelector;
