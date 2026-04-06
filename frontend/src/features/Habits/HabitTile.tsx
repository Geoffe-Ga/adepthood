import React, { useState } from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';

import { STAGE_COLORS, spacing } from '../../design/tokens';
import useResponsive from '../../design/useResponsive';

import type { HabitTileProps, Goal, Habit } from './Habits.types';
import {
  getProgressPercentage,
  clampPercentage,
  getGoalTier,
  getMarkerPositions,
  getProgressBarColor,
  getTierColor,
  isGoalAchieved,
  isEarlyUnlocked,
  calculateHabitProgress,
} from './HabitUtils';

type TierType = 'low' | 'clear' | 'stretch';

const TIER_LABELS: Record<TierType, string> = {
  low: 'Low Grit',
  clear: 'Clear Goal',
  stretch: 'Stretch Goal',
};

const TIER_ABBREVIATIONS: Record<TierType, string> = {
  low: 'LG',
  clear: 'CG',
  stretch: 'SG',
};

const computeTranslateX = (pct: number): number => {
  if (pct === 0) return 0;
  return pct === 100 ? -12 : -6;
};

const formatGoalTooltip = (goal: Goal, habit: Habit): string => {
  const label = TIER_LABELS[goal.tier];
  const progress = calculateHabitProgress(habit);
  return `${label}: ${progress}/${goal.target} ${goal.target_unit}`;
};

interface GoalTooltipProps {
  goal: Goal;
  habit: Habit;
  tier: TierType;
  scale: number;
}

const GoalTooltipContent = ({ goal, habit, tier, scale }: GoalTooltipProps) => (
  <View
    testID={`tooltip-${tier}`}
    style={{
      position: 'absolute',
      bottom: 16,
      backgroundColor: '#fffdf7',
      borderWidth: 1,
      borderColor: getTierColor(tier),
      borderRadius: 4,
      paddingHorizontal: 4,
      paddingVertical: 2,
    }}
  >
    <Text
      style={{
        fontSize: spacing(1.5, scale),
        color: '#333',
        fontFamily: 'serif',
        fontStyle: 'italic',
        letterSpacing: 0.5,
      }}
    >
      {formatGoalTooltip(goal, habit)}
    </Text>
  </View>
);

interface GoalMarkerProps {
  goal: Goal;
  habit: Habit;
  tier: TierType;
  markerPosition: number;
  barHeight: number;
  zIndex: number;
  scale: number;
  tooltip: TierType | null;
  setTooltip: (_v: TierType | null) => void;
}

const GoalMarker = ({
  goal,
  habit,
  tier,
  markerPosition,
  barHeight,
  zIndex,
  scale,
  tooltip,
  setTooltip,
}: GoalMarkerProps) => {
  const clamped = clampPercentage(markerPosition);
  return (
    <View
      style={{
        position: 'absolute',
        left: `${clamped}%`,
        top: -6 + barHeight / 2,
        transform: [{ translateX: computeTranslateX(clamped) }],
        zIndex,
        alignItems: 'center',
      }}
    >
      {tooltip === tier && (
        <GoalTooltipContent goal={goal} habit={habit} tier={tier} scale={scale} />
      )}
      <TouchableOpacity
        testID={`marker-${tier}`}
        onPressIn={() => setTooltip(tier)}
        onPressOut={() => setTooltip(null)}
        onMouseEnter={() => setTooltip(tier)}
        onMouseLeave={() => setTooltip(null)}
        style={{
          width: 12,
          height: 12,
          borderRadius: 6,
          backgroundColor: '#fffdf7',
          borderWidth: 2,
          borderColor: getTierColor(tier),
        }}
      />
    </View>
  );
};

interface GoalLabelProps {
  tier: TierType;
  markerPosition: number;
  zIndex: number;
  scale: number;
}

const GoalLabel = ({ tier, markerPosition, zIndex, scale }: GoalLabelProps) => {
  const clamped = clampPercentage(markerPosition);
  return (
    <View
      style={{
        position: 'absolute',
        left: `${clamped}%`,
        transform: [{ translateX: computeTranslateX(clamped) }],
        zIndex,
        backgroundColor: '#fffdf7',
        paddingHorizontal: 2,
        borderRadius: 2,
      }}
    >
      <Text style={{ fontSize: spacing(1.5, scale), color: getTierColor(tier) }}>
        {TIER_ABBREVIATIONS[tier]}
      </Text>
    </View>
  );
};

interface HabitHeaderProps {
  habit: Habit;
  stageColor: string;
  scale: number;
  streakText: string;
  hasCompletedGoal: boolean;
  iconInline: boolean;
  onIconPress?: () => void;
}

const getStreakStyle = (hasCompleted: boolean, stageColor: string, scale: number) =>
  hasCompleted
    ? {
        backgroundColor: stageColor,
        color: '#fff',
        paddingHorizontal: spacing(0.5, scale),
        borderRadius: spacing(0.5, scale),
      }
    : {};

const nameStyle = (scale: number) => ({
  flex: 1 as const,
  fontSize: spacing(2, scale),
  fontWeight: '700' as const,
  textTransform: 'uppercase' as const,
});

const HeaderRow = ({
  name,
  streakText,
  streakStyle,
  scale,
}: {
  name: string;
  streakText: string;
  streakStyle: object;
  scale: number;
}) => (
  <View testID="habit-header" style={{ flexDirection: 'row', alignItems: 'center' }}>
    <Text style={nameStyle(scale)}>{name}</Text>
    <Text style={[{ fontSize: spacing(1.5, scale), textTransform: 'uppercase' }, streakStyle]}>
      {streakText}
    </Text>
  </View>
);

const HabitHeader = ({
  habit,
  stageColor,
  scale,
  streakText,
  hasCompletedGoal,
  iconInline,
  onIconPress,
}: HabitHeaderProps) => {
  const streakStyle = getStreakStyle(hasCompletedGoal, stageColor, scale);

  if (iconInline) {
    return (
      <View testID="habit-header" style={{ flexDirection: 'row', alignItems: 'center' }}>
        <TouchableOpacity
          onPress={onIconPress}
          testID="habit-icon"
          style={{ marginRight: spacing(1, scale) }}
        >
          <Text style={{ fontSize: spacing(3, scale) }}>{habit.icon}</Text>
        </TouchableOpacity>
        <Text style={nameStyle(scale)}>{habit.name}</Text>
        <Text style={[{ fontSize: spacing(1.5, scale), textTransform: 'uppercase' }, streakStyle]}>
          {streakText}
        </Text>
      </View>
    );
  }

  return (
    <>
      <View
        testID="habit-icon-top"
        style={{ alignItems: 'center', marginBottom: spacing(1, scale) }}
      >
        <TouchableOpacity onPress={onIconPress} testID="habit-icon">
          <Text style={{ fontSize: spacing(4, scale) }}>{habit.icon}</Text>
        </TouchableOpacity>
      </View>
      <HeaderRow
        name={habit.name}
        streakText={streakText}
        streakStyle={streakStyle}
        scale={scale}
      />
    </>
  );
};

const TOTAL_HABITS = 10;

const useTileLayout = () => {
  const { width, height, columns, scale, gridGutter } = useResponsive();
  const rows = columns === 2 ? TOTAL_HABITS / columns : TOTAL_HABITS;
  const tileMinHeight = height / rows - 2 * spacing(1, scale) - gridGutter;
  const tileWidth = width / columns;
  const iconInline = columns === 1 || tileWidth < 400;
  return { columns, scale, gridGutter, tileMinHeight, iconInline };
};

interface GoalMarkerEntry {
  goal: Goal;
  tier: TierType;
  markerPosition: number;
  zIndex: number;
  visible: boolean;
}

interface ProgressBarProps {
  habit: Habit;
  barHeight: number;
  progressPercentage: number;
  progressBarColor: string;
  markers: GoalMarkerEntry[];
  scale: number;
  tooltip: TierType | null;
  setTooltip: (_v: TierType | null) => void;
}

interface MarkerListProps {
  markers: GoalMarkerEntry[];
  habit: Habit;
  barHeight: number;
  scale: number;
  tooltip: TierType | null;
  setTooltip: (_v: TierType | null) => void;
}

const MarkerList = ({ markers, habit, barHeight, scale, tooltip, setTooltip }: MarkerListProps) => (
  <>
    {markers
      .filter((m) => m.visible)
      .map((m) => (
        <GoalMarker
          key={m.tier}
          goal={m.goal}
          habit={habit}
          tier={m.tier}
          markerPosition={m.markerPosition}
          barHeight={barHeight}
          zIndex={m.zIndex}
          scale={scale}
          tooltip={tooltip}
          setTooltip={setTooltip}
        />
      ))}
  </>
);

const LabelList = ({ markers, scale }: { markers: GoalMarkerEntry[]; scale: number }) => (
  <>
    {markers
      .filter((m) => m.visible)
      .map((m) => (
        <GoalLabel
          key={m.tier}
          tier={m.tier}
          markerPosition={m.markerPosition}
          zIndex={m.zIndex}
          scale={scale}
        />
      ))}
  </>
);

const ProgressBar = ({
  habit,
  barHeight,
  progressPercentage,
  progressBarColor,
  markers,
  scale,
  tooltip,
  setTooltip,
}: ProgressBarProps) => (
  <View style={{ marginTop: spacing(1, scale) }}>
    <View style={{ height: barHeight, position: 'relative' }}>
      <View
        style={{
          height: '100%',
          backgroundColor: '#eee',
          borderRadius: barHeight / 2,
          overflow: 'hidden',
        }}
      >
        <View
          testID="progress-fill"
          style={{
            height: '100%',
            width: `${progressPercentage}%`,
            backgroundColor: progressBarColor,
            borderRadius: barHeight / 2,
          }}
        />
      </View>
      <MarkerList
        markers={markers}
        habit={habit}
        barHeight={barHeight}
        scale={scale}
        tooltip={tooltip}
        setTooltip={setTooltip}
      />
    </View>
    <View style={{ position: 'relative', marginTop: spacing(0.5, scale) }}>
      <LabelList markers={markers} scale={scale} />
    </View>
  </View>
);

const useHabitTileData = (habit: Habit) => {
  const lowGoal = habit.goals.find((g) => g.tier === 'low');
  const clearGoal = habit.goals.find((g) => g.tier === 'clear');
  const stretchGoal = habit.goals.find((g) => g.tier === 'stretch');

  const { currentGoal, nextGoal, completedAllGoals } = getGoalTier(habit);
  const progressPercentage = clampPercentage(getProgressPercentage(habit, currentGoal, nextGoal));
  const progressBarColor = getProgressBarColor(habit);
  const hasCompletedGoal = completedAllGoals || progressPercentage >= 100;

  const {
    low: lowMarker,
    clear: clearMarker,
    stretch: stretchMarker,
  } = getMarkerPositions(lowGoal, clearGoal, stretchGoal);
  const hasCleared = clearGoal ? isGoalAchieved(clearGoal, habit) : false;

  const markers: GoalMarkerEntry[] = [
    {
      goal: lowGoal!,
      tier: 'low',
      markerPosition: lowMarker,
      zIndex: 1,
      visible: !!lowGoal && lowMarker >= 0,
    },
    {
      goal: clearGoal!,
      tier: 'clear',
      markerPosition: clearMarker,
      zIndex: 2,
      visible: !!clearGoal && clearMarker >= 0,
    },
    {
      goal: stretchGoal!,
      tier: 'stretch',
      markerPosition: stretchMarker,
      zIndex: 3,
      visible: !!stretchGoal && stretchMarker >= 0 && hasCleared,
    },
  ];

  return { progressPercentage, progressBarColor, hasCompletedGoal, markers };
};

const showUnlockConfirmation = (habit: Habit, onUnlock: (_id: number) => void) => {
  const dateStr = new Date(habit.start_date).toLocaleDateString();
  Alert.alert(
    'Unlock Early?',
    `Unlock "${habit.name}" early? The recommended start date is ${dateStr}.`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unlock', onPress: () => onUnlock(habit.id) },
    ],
  );
};

const getTileOpacity = (isLocked: boolean, isFutureStart: boolean): number => {
  if (isLocked) return 0.4;
  if (isFutureStart) return 0.5;
  return 1;
};

const getTileStyle = (
  stageColor: string,
  earlyUnlocked: boolean,
  isLocked: boolean,
  isFutureStart: boolean,
  scale: number,
  gridGutter: number,
  tileMinHeight: number,
) => ({
  flex: 1 as const,
  borderWidth: 1,
  borderColor: stageColor,
  borderStyle: earlyUnlocked ? ('dashed' as const) : undefined,
  padding: spacing(1, scale),
  margin: gridGutter / 2,
  minHeight: tileMinHeight,
  borderRadius: spacing(1, scale),
  backgroundColor: '#f8f8f8',
  opacity: getTileOpacity(isLocked, isFutureStart),
});

const buildLongPressHandler = (
  habit: Habit,
  isLocked: boolean,
  onLongPress: () => void,
  onUnlockHabit?: (_id: number) => void,
) => {
  if (isLocked && onUnlockHabit) {
    return () => showUnlockConfirmation(habit, onUnlockHabit);
  }
  return onLongPress;
};

const getStreakLabel = (streak: number, hasCompletedGoal: boolean): string =>
  `${streak} days${hasCompletedGoal ? ' — Achieved Today!' : ''}`.toUpperCase();

const useHabitTileState = (habit: Habit) => {
  const layout = useTileLayout();
  const stageColor = STAGE_COLORS[habit.stage] ?? '#000';
  const data = useHabitTileData(habit);
  const isFutureStart = new Date(habit.start_date).getTime() > Date.now();
  const isLocked = habit.revealed === false;
  const tileStyle = getTileStyle(
    stageColor,
    isEarlyUnlocked(habit),
    isLocked,
    isFutureStart,
    layout.scale,
    layout.gridGutter,
    layout.tileMinHeight,
  );
  return { ...layout, stageColor, ...data, isLocked, tileStyle };
};

export const HabitTile = ({
  habit,
  onOpenGoals,
  onLongPress,
  onIconPress,
  onUnlockHabit,
}: HabitTileProps) => {
  const {
    scale,
    iconInline,
    stageColor,
    isLocked,
    tileStyle,
    progressPercentage,
    progressBarColor,
    hasCompletedGoal,
    markers,
  } = useHabitTileState(habit);
  const [tooltip, setTooltip] = useState<TierType | null>(null);
  const barHeight = Math.max(8, spacing(2, scale));

  return (
    <TouchableOpacity
      testID="habit-tile"
      style={tileStyle}
      onPress={isLocked ? undefined : onOpenGoals}
      onLongPress={buildLongPressHandler(habit, isLocked, onLongPress, onUnlockHabit)}
    >
      <HabitHeader
        habit={habit}
        stageColor={stageColor}
        scale={scale}
        streakText={getStreakLabel(habit.streak, hasCompletedGoal)}
        hasCompletedGoal={hasCompletedGoal}
        iconInline={iconInline}
        onIconPress={isLocked ? undefined : onIconPress}
      />
      <ProgressBar
        habit={habit}
        barHeight={barHeight}
        progressPercentage={progressPercentage}
        progressBarColor={progressBarColor}
        markers={markers}
        scale={scale}
        tooltip={tooltip}
        setTooltip={setTooltip}
      />
    </TouchableOpacity>
  );
};

export default HabitTile;
