import React, { useState, useRef, useEffect } from 'react';
import {
  Alert,
  Modal,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  PanResponder,
  StyleSheet,
} from 'react-native';
import type {
  DimensionValue,
  GestureResponderHandlers,
  LayoutChangeEvent,
  ViewStyle,
  TextStyle,
} from 'react-native';
import EmojiSelector from 'react-native-emoji-selector';

import { goalGroups as goalGroupsApi, type ApiGoalGroup } from '../../../api';
import { STAGE_COLORS } from '../../../design/tokens';
import styles from '../Habits.styles';
import type { GoalModalProps, Goal } from '../Habits.types';
import {
  getMarkerPositions,
  getProgressBarColor,
  clampPercentage,
  getTierColor,
  getGoalTarget,
  calculateHabitProgress,
} from '../HabitUtils';

const markerContainerStyle = (leftPct: number, z: number): ViewStyle => ({
  position: 'absolute',
  left: `${clampPercentage(leftPct)}%` as DimensionValue,
  top: -6,
  transform: [
    {
      translateX: clampPercentage(leftPct) === 0 ? 0 : clampPercentage(leftPct) === 100 ? -12 : -6,
    },
  ],
  zIndex: z,
  alignItems: 'center',
});

const circleStyle = (color: string): ViewStyle => ({
  width: 12,
  height: 12,
  borderRadius: 6,
  backgroundColor: '#fffdf7',
  borderWidth: 2,
  borderColor: color,
});

const labelContainerStyle = (leftPct: number, z: number): ViewStyle => ({
  position: 'absolute',
  left: `${clampPercentage(leftPct)}%` as DimensionValue,
  transform: [
    {
      translateX: clampPercentage(leftPct) === 0 ? 0 : clampPercentage(leftPct) === 100 ? -12 : -6,
    },
  ],
  zIndex: z,
  backgroundColor: '#fffdf7',
  paddingHorizontal: 2,
  borderRadius: 2,
});

const labelTextStyle = (color: string): TextStyle => ({ fontSize: 10, color });

const tooltipStyle = (color: string): ViewStyle => ({
  position: 'absolute',
  bottom: 16,
  backgroundColor: '#fffdf7',
  borderWidth: 1,
  borderColor: color,
  borderRadius: 4,
  paddingHorizontal: 4,
  paddingVertical: 2,
});

const tooltipTextStyle: TextStyle = {
  fontSize: 10,
  color: '#333',
  fontFamily: 'serif',
  fontStyle: 'italic',
  letterSpacing: 0.5,
};

const TIER_LABELS: Record<string, string> = {
  low: 'Low Grit',
  clear: 'Clear Goal',
  stretch: 'Stretch Goal',
};

const TIER_ABBREVS: Record<string, string> = { low: 'LG', clear: 'CG', stretch: 'SG' };

const formatGoalTooltip = (g: Goal | undefined): string => {
  if (!g) return '';
  const label = TIER_LABELS[g.tier] ?? g.tier;
  return `${label}: ${g.target} ${g.target_unit} per ${g.frequency_unit.replace('_', ' ')}`;
};

const computeProgressPct = (
  totalProgress: number,
  lowGoal: Goal | undefined,
  stretchGoal: Goal | undefined,
): number => {
  if (!stretchGoal) return 0;
  if (lowGoal?.is_additive) {
    return clampPercentage((totalProgress / getGoalTarget(stretchGoal)) * 100);
  }
  const stretchTarget = getGoalTarget(stretchGoal);
  const lowTarget = getGoalTarget(lowGoal!);
  return clampPercentage(
    100 - ((totalProgress - stretchTarget) / (lowTarget - stretchTarget)) * 100,
  );
};

const GOAL_LABEL_TIERS = [
  { tier: 'low' as const, zIndex: 1 },
  { tier: 'clear' as const, zIndex: 2 },
  { tier: 'stretch' as const, zIndex: 3 },
] as const;

interface GoalMarkerItemProps {
  goal: Goal;
  tier: 'low' | 'clear' | 'stretch';
  position: number;
  zIndex: number;
  tooltip: 'low' | 'clear' | 'stretch' | null;
  setTooltip: (_v: 'low' | 'clear' | 'stretch' | null) => void;
  panHandlers?: GestureResponderHandlers;
}

const GoalMarkerItem = ({
  goal,
  tier,
  position,
  zIndex,
  tooltip,
  setTooltip,
  panHandlers,
}: GoalMarkerItemProps) => {
  const Wrapper = tier === 'stretch' ? TouchableOpacity : View;
  const interactionProps =
    tier === 'stretch'
      ? { onPressIn: () => setTooltip(tier), onPressOut: () => setTooltip(null) }
      : panHandlers ?? {};

  return (
    <Wrapper
      testID={`modal-marker-${tier}`}
      {...interactionProps}
      onMouseEnter={() => setTooltip(tier)}
      onMouseLeave={() => setTooltip(null)}
      style={markerContainerStyle(position, zIndex)}
    >
      {tooltip === tier && (
        <View testID={`modal-tooltip-${tier}`} style={tooltipStyle(getTierColor(tier))}>
          <Text style={tooltipTextStyle}>{formatGoalTooltip(goal)}</Text>
        </View>
      )}
      <View style={circleStyle(getTierColor(tier))} />
    </Wrapper>
  );
};

interface GoalProgressBarProps {
  progressPercentage: number;
  progressBarColor: string;
  lowGoal: Goal | undefined;
  clearGoal: Goal | undefined;
  stretchGoal: Goal | undefined;
  lowMarker: number;
  clearMarker: number;
  stretchMarker: number;
  tooltip: 'low' | 'clear' | 'stretch' | null;
  setTooltip: (_v: 'low' | 'clear' | 'stretch' | null) => void;
  lowPanHandlers: GestureResponderHandlers;
  clearPanHandlers: GestureResponderHandlers;
  goalsByTier: Record<string, Goal | undefined>;
  markerPositions: Record<string, number>;
  onLayout: (_e: LayoutChangeEvent) => void;
}

interface ProgressFillProps {
  progressPercentage: number;
  progressBarColor: string;
}

const ProgressFill = ({ progressPercentage, progressBarColor }: ProgressFillProps) => (
  <View style={{ height: '100%', backgroundColor: '#eee', borderRadius: 6, overflow: 'hidden' }}>
    <View
      testID="modal-progress-fill"
      style={{
        height: '100%',
        width: `${progressPercentage}%`,
        backgroundColor: progressBarColor,
        borderRadius: 6,
      }}
    />
  </View>
);

interface GoalMarkersRowProps {
  lowGoal: Goal | undefined;
  clearGoal: Goal | undefined;
  stretchGoal: Goal | undefined;
  lowMarker: number;
  clearMarker: number;
  stretchMarker: number;
  tooltip: 'low' | 'clear' | 'stretch' | null;
  setTooltip: (_v: 'low' | 'clear' | 'stretch' | null) => void;
  lowPanHandlers: GestureResponderHandlers;
  clearPanHandlers: GestureResponderHandlers;
}

const GoalMarkersRow = ({
  lowGoal,
  clearGoal,
  stretchGoal,
  lowMarker,
  clearMarker,
  stretchMarker,
  tooltip,
  setTooltip,
  lowPanHandlers,
  clearPanHandlers,
}: GoalMarkersRowProps) => (
  <>
    {lowGoal && (
      <GoalMarkerItem
        goal={lowGoal}
        tier="low"
        position={lowMarker}
        zIndex={1}
        tooltip={tooltip}
        setTooltip={setTooltip}
        panHandlers={lowPanHandlers}
      />
    )}
    {clearGoal && (
      <GoalMarkerItem
        goal={clearGoal}
        tier="clear"
        position={clearMarker}
        zIndex={2}
        tooltip={tooltip}
        setTooltip={setTooltip}
        panHandlers={clearPanHandlers}
      />
    )}
    {stretchGoal && (
      <GoalMarkerItem
        goal={stretchGoal}
        tier="stretch"
        position={stretchMarker}
        zIndex={3}
        tooltip={tooltip}
        setTooltip={setTooltip}
      />
    )}
  </>
);

const GoalLabelRow = ({
  goalsByTier,
  markerPositions,
}: {
  goalsByTier: Record<string, Goal | undefined>;
  markerPositions: Record<string, number>;
}) => (
  <View style={{ position: 'relative', marginTop: 4 }}>
    {GOAL_LABEL_TIERS.filter((t) => goalsByTier[t.tier]).map((t) => (
      <View key={t.tier} style={labelContainerStyle(markerPositions[t.tier]!, t.zIndex)}>
        <Text style={labelTextStyle(getTierColor(t.tier))}>{TIER_ABBREVS[t.tier]}</Text>
      </View>
    ))}
  </View>
);

const GoalProgressBar = ({
  progressPercentage,
  progressBarColor,
  lowGoal,
  clearGoal,
  stretchGoal,
  lowMarker,
  clearMarker,
  stretchMarker,
  tooltip,
  setTooltip,
  lowPanHandlers,
  clearPanHandlers,
  goalsByTier,
  markerPositions,
  onLayout,
}: GoalProgressBarProps) => (
  <View style={{ marginVertical: 16 }} onLayout={onLayout}>
    <View style={{ height: 12, position: 'relative' }}>
      <ProgressFill progressPercentage={progressPercentage} progressBarColor={progressBarColor} />
      <GoalMarkersRow
        lowGoal={lowGoal}
        clearGoal={clearGoal}
        stretchGoal={stretchGoal}
        lowMarker={lowMarker}
        clearMarker={clearMarker}
        stretchMarker={stretchMarker}
        tooltip={tooltip}
        setTooltip={setTooltip}
        lowPanHandlers={lowPanHandlers}
        clearPanHandlers={clearPanHandlers}
      />
    </View>
    <GoalLabelRow goalsByTier={goalsByTier} markerPositions={markerPositions} />
  </View>
);

interface LogUnitSectionProps {
  logAmount: string;
  setLogAmount: (_v: string) => void;
  onLog: () => void;
}

const LogUnitSection = ({ logAmount, setLogAmount, onLog }: LogUnitSectionProps) => (
  <View style={styles.actionButtons}>
    <View style={styles.logUnitContainer}>
      <TextInput
        style={styles.logUnitInput}
        value={logAmount}
        onChangeText={setLogAmount}
        keyboardType="numeric"
      />
      <TouchableOpacity style={styles.logUnitButton} onPress={onLog}>
        <Text style={styles.logUnitButtonText}>Log Units</Text>
      </TouchableOpacity>
    </View>
  </View>
);

const useGoalGroup = (habit: GoalModalProps['habit']) => {
  const [goalGroup, setGoalGroup] = useState<ApiGoalGroup | null>(null);
  useEffect(() => {
    const groupId = habit?.goals.find((g) => g.goal_group_id)?.goal_group_id;
    if (groupId) {
      goalGroupsApi
        .get(groupId)
        .then(setGoalGroup)
        .catch(() => setGoalGroup(null));
    } else {
      setGoalGroup(null);
    }
  }, [habit]);
  return goalGroup;
};

const confirmGoalUpdate = (
  tier: 'low' | 'clear',
  percent: number,
  lowGoal: Goal | undefined,
  clearGoal: Goal | undefined,
  stretchGoal: Goal | undefined,
  habitId: number | undefined,
  markers: { low: number; clear: number },
  setLowMarker: (_v: number) => void,
  setClearMarker: (_v: number) => void,
  onUpdateGoal: GoalModalProps['onUpdateGoal'],
) => {
  const goal = tier === 'low' ? lowGoal : clearGoal;
  if (!goal || !habitId) return;
  const stretchTarget = stretchGoal ? getGoalTarget(stretchGoal) : goal.target;
  const newTarget = Math.max(1, Math.round((percent / 100) * stretchTarget));
  const tierLabel = tier === 'low' ? 'Low Grit' : 'Clear Goal';
  Alert.alert(
    `Edit ${tierLabel.split(' ')[0]} Goal`,
    `Edit the ${tierLabel} to be ${newTarget} ${goal.target_unit} ${goal.frequency_unit.replace('_', ' ')}?`,
    [
      {
        text: 'No',
        style: 'cancel',
        onPress: () => {
          if (tier === 'low') setLowMarker(markers.low);
          else setClearMarker(markers.clear);
        },
      },
      { text: 'Yes', onPress: () => onUpdateGoal(habitId, { ...goal, target: newTarget }) },
    ],
  );
};

function useGoalTiers(habit: GoalModalProps['habit']) {
  const lowGoal = habit?.goals.find((g) => g.tier === 'low');
  const clearGoal = habit?.goals.find((g) => g.tier === 'clear');
  const stretchGoal = habit?.goals.find((g) => g.tier === 'stretch');
  const markers = getMarkerPositions(lowGoal, clearGoal, stretchGoal);
  return { lowGoal, clearGoal, stretchGoal, markers };
}

function useMarkerPanResponders(
  tiers: ReturnType<typeof useGoalTiers>,
  barWidth: React.MutableRefObject<number>,
  lowMarker: number,
  setLowMarker: (_v: number) => void,
  clearMarker: number,
  setClearMarker: (_v: number) => void,
  setTooltip: (_v: null | 'low' | 'clear' | 'stretch') => void,
  onConfirm: (_tier: 'low' | 'clear', _pct: number) => void,
) {
  const createPanResponder = (tier: 'low' | 'clear') =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => setTooltip(tier),
      onPanResponderMove: (_, gesture) => {
        const init = tier === 'low' ? tiers.markers.low : tiers.markers.clear;
        const pct = (((init / 100) * barWidth.current + gesture.dx) / barWidth.current) * 100;
        if (tier === 'low') setLowMarker(Math.min(clampPercentage(pct), clearMarker - 5));
        else setClearMarker(Math.max(clampPercentage(pct), lowMarker + 5));
      },
      onPanResponderRelease: () => {
        setTooltip(null);
        onConfirm(tier, tier === 'low' ? lowMarker : clearMarker);
      },
      onPanResponderTerminate: () => setTooltip(null),
    });

  const lowPan = useRef(createPanResponder('low')).current;
  const clearPan = useRef(createPanResponder('clear')).current;
  return { lowPan, clearPan };
}

function useGoalConfirm(
  tiers: ReturnType<typeof useGoalTiers>,
  habitId: number | undefined,
  setLowMarker: (_v: number) => void,
  setClearMarker: (_v: number) => void,
  onUpdateGoal: GoalModalProps['onUpdateGoal'],
) {
  return (tier: 'low' | 'clear', percent: number) => {
    confirmGoalUpdate(
      tier,
      percent,
      tiers.lowGoal,
      tiers.clearGoal,
      tiers.stretchGoal,
      habitId,
      tiers.markers,
      setLowMarker,
      setClearMarker,
      onUpdateGoal,
    );
  };
}

const useGoalMarkers = (
  habit: GoalModalProps['habit'],
  onUpdateGoal: GoalModalProps['onUpdateGoal'],
) => {
  const barWidth = useRef(0);
  const [lowMarker, setLowMarker] = useState(0);
  const [clearMarker, setClearMarker] = useState(0);
  const [tooltip, setTooltip] = useState<null | 'low' | 'clear' | 'stretch'>(null);
  const tiers = useGoalTiers(habit);

  useEffect(() => {
    setLowMarker(tiers.markers.low);
    setClearMarker(tiers.markers.clear);
  }, [tiers.markers.low, tiers.markers.clear]);

  const handleBarLayout = (e: LayoutChangeEvent) => {
    barWidth.current = e.nativeEvent.layout.width;
  };

  const onConfirm = useGoalConfirm(tiers, habit?.id, setLowMarker, setClearMarker, onUpdateGoal);
  const { lowPan, clearPan } = useMarkerPanResponders(
    tiers,
    barWidth,
    lowMarker,
    setLowMarker,
    clearMarker,
    setClearMarker,
    setTooltip,
    onConfirm,
  );

  return {
    ...tiers,
    lowMarker,
    clearMarker,
    stretchMarker: tiers.markers.stretch,
    tooltip,
    setTooltip,
    lowPan,
    clearPan,
    handleBarLayout,
  };
};

interface GoalModalHeaderProps {
  habit: NonNullable<GoalModalProps['habit']>;
  goalGroup: ApiGoalGroup | null;
  showEmojiSelector: boolean;
  setShowEmojiSelector: (_v: boolean) => void;
  onClose: () => void;
  onUpdateHabit: GoalModalProps['onUpdateHabit'];
}

const GoalModalHeader = ({
  habit,
  goalGroup,
  showEmojiSelector,
  setShowEmojiSelector,
  onClose,
  onUpdateHabit,
}: GoalModalHeaderProps) => (
  <>
    <View style={styles.modalHeader}>
      <Text style={styles.modalTitle}>{habit.name}</Text>
      <TouchableOpacity onPress={() => setShowEmojiSelector(true)}>
        <Text style={styles.iconLarge}>{habit.icon}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onClose} style={styles.closeButton}>
        <Text style={styles.closeButtonText}>×</Text>
      </TouchableOpacity>
    </View>
    {goalGroup && (
      <View testID="goal-group-badge" style={goalGroupBadgeStyles.container}>
        <Text style={goalGroupBadgeStyles.text}>
          {goalGroup.icon ?? '📁'} {goalGroup.name}
        </Text>
      </View>
    )}
    {showEmojiSelector && (
      <View style={styles.emojiSelectorContainer}>
        <EmojiSelector
          onEmojiSelected={(emoji) => {
            onUpdateHabit({ ...habit, icon: emoji });
            setShowEmojiSelector(false);
          }}
          showSearchBar
          columns={6}
          emojiSize={28}
        />
      </View>
    )}
  </>
);

interface GoalModalBodyProps {
  habit: NonNullable<GoalModalProps['habit']>;
  onClose: () => void;
  onUpdateGoal: GoalModalProps['onUpdateGoal'];
  onLogUnit: GoalModalProps['onLogUnit'];
  onUpdateHabit: GoalModalProps['onUpdateHabit'];
}

const buildGoalMaps = (m: ReturnType<typeof useGoalMarkers>) => ({
  goalsByTier: { low: m.lowGoal, clear: m.clearGoal, stretch: m.stretchGoal } as Record<
    string,
    Goal | undefined
  >,
  markerPositions: {
    low: m.lowMarker,
    clear: m.clearMarker,
    stretch: m.stretchMarker,
  } as Record<string, number>,
});

const buildProgressBarProps = (
  habit: NonNullable<GoalModalProps['habit']>,
  m: ReturnType<typeof useGoalMarkers>,
) => ({
  progressPercentage: computeProgressPct(calculateHabitProgress(habit), m.lowGoal, m.stretchGoal),
  progressBarColor: getProgressBarColor(habit),
  lowGoal: m.lowGoal,
  clearGoal: m.clearGoal,
  stretchGoal: m.stretchGoal,
  lowMarker: m.lowMarker,
  clearMarker: m.clearMarker,
  stretchMarker: m.stretchMarker,
  tooltip: m.tooltip,
  setTooltip: m.setTooltip,
  lowPanHandlers: m.lowPan.panHandlers,
  clearPanHandlers: m.clearPan.panHandlers,
  ...buildGoalMaps(m),
  onLayout: m.handleBarLayout,
});

const GoalModalBody = ({
  habit,
  onClose,
  onUpdateGoal,
  onLogUnit,
  onUpdateHabit,
}: GoalModalBodyProps) => {
  const [logAmount, setLogAmount] = useState('1');
  const [showEmojiSelector, setShowEmojiSelector] = useState(false);
  const goalGroup = useGoalGroup(habit);
  const m = useGoalMarkers(habit, onUpdateGoal);

  const handleLogUnit = () => {
    if (!habit.id) return;
    onLogUnit(habit.id, parseFloat(logAmount) || 1);
    setLogAmount('1');
  };

  return (
    <View style={[styles.modalContent, { borderTopColor: STAGE_COLORS[habit.stage] }]}>
      <GoalModalHeader
        habit={habit}
        goalGroup={goalGroup}
        showEmojiSelector={showEmojiSelector}
        setShowEmojiSelector={setShowEmojiSelector}
        onClose={onClose}
        onUpdateHabit={onUpdateHabit}
      />
      <GoalProgressBar {...buildProgressBarProps(habit, m)} />
      <LogUnitSection logAmount={logAmount} setLogAmount={setLogAmount} onLog={handleLogUnit} />
    </View>
  );
};

export const GoalModal = ({
  visible,
  habit,
  onClose,
  onUpdateGoal,
  onLogUnit,
  onUpdateHabit,
}: GoalModalProps) => {
  if (!habit) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.modalOverlay}>
          <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
            <GoalModalBody
              habit={habit}
              onClose={onClose}
              onUpdateGoal={onUpdateGoal}
              onLogUnit={onLogUnit}
              onUpdateHabit={onUpdateHabit}
            />
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

const goalGroupBadgeStyles = StyleSheet.create({
  container: {
    alignSelf: 'flex-start',
    backgroundColor: '#f0ede6',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 8,
  },
  text: {
    fontSize: 12,
    color: '#555',
    fontStyle: 'italic',
  },
});

export default GoalModal;
