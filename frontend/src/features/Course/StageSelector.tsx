import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';

import type { Stage } from '../../api';
import { readableGlyphOn } from '../../design/tokens';

import styles from './Course.styles';
import {
  getStageColor,
  isCompleted,
  isUnlocked,
  stagePillFill,
  totalStageCount,
} from './stageDisplay';

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
}: StagePillProps): React.JSX.Element => {
  // Locked/completed dimming is baked into the fill, so the glyph rides on the
  // dimmed color; pick a foreground that clears WCAG AA against that effective
  // fill rather than the raw stage color or a fixed canvas tint.
  const effectiveFill = stagePillFill(color, { unlocked, completed, isActive });
  const glyphColor = readableGlyphOn(effectiveFill);
  return (
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
        { backgroundColor: effectiveFill },
        isActive && styles.stagePillActive,
      ]}
    >
      {completed ? (
        <Text style={[styles.stagePillCheck, { color: glyphColor }]}>{'✓'}</Text>
      ) : !unlocked ? (
        <Text style={[styles.stagePillLock, { color: glyphColor }]}>{'🔒'}</Text>
      ) : (
        <Text style={[styles.stagePillText, { color: glyphColor }]}>{stageNumber}</Text>
      )}
    </TouchableOpacity>
  );
};

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
