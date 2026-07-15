import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Text, TouchableOpacity, View, type DimensionValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  BOTTOM_TAB_BAR_CONTENT_HEIGHT,
  colors,
  SPACING,
  STAGE_COLORS,
  spacing,
  surface,
  tileDensity,
  touchTarget,
} from '../../design/tokens';
import useResponsive from '../../design/useResponsive';
import { DEFAULT_TIMEZONE } from '../../utils/dateUtils';

import ConfirmDialog from './components/ConfirmDialog';
import { MAX_HABITS } from './constants';
import { TIER_LABELS, type TierType } from './goalMarker';
import type { HabitTileProps, Goal, Habit } from './Habits.types';
import {
  getProgressPercentage,
  clampPercentage,
  getGoalTarget,
  getGoalTier,
  getMarkerPositions,
  getProgressBarColor,
  isGoalAchieved,
  calculateTodaysProgress,
} from './HabitUtils';
import { useStarFill, type StarFillControls } from './hooks/useStarFill';
import { longPressGestureStyle } from './longPressGestureStyle';
import { STAR_LONG_PRESS_MS } from './starFill';
import {
  TierMarkerOverlay,
  type MarkerInteraction,
  type TierMarkerSpec,
} from './TierMarkerOverlay';

/** A tile that is not wired to log units keeps the star as a tooltip-only touch target. */
const NOOP_LOG_UNIT: NonNullable<HabitTileProps['onLogUnit']> = () => {};

/** Marker star size: a touch larger than the bar so it reads as a sitting marker. */
const markerStarSize = (scale: number): number => spacing(2, scale);

/** Round to at most two decimals and drop trailing zeros so the fraction reads cleanly. */
const formatAmount = (value: number): string => String(Math.round(value * 100) / 100);

const formatGoalTooltip = (goal: Goal, habit: Habit, tz: string): string => {
  const label = TIER_LABELS[goal.tier];
  const progress = calculateTodaysProgress(habit, tz);
  // Divide by the daily-normalized target the "met" star and bar use
  // (getGoalTarget), not the raw weekly/monthly goal.target — otherwise a
  // per_week/per_month goal whose star is filled still shows a sub-100%
  // fraction because numerator (today) and denominator (week/month) mixed scales.
  const target = getGoalTarget(goal);
  return `${label}: ${formatAmount(progress)}/${formatAmount(target)} ${goal.target_unit}`;
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

// Softened from default black to a darkish grey so the habit name reads
// calmer / less abrasive against the tile.
const HABIT_TEXT_COLOR = colors.text.secondaryAccessible;

const nameStyle = (scale: number) => ({
  flex: 1 as const,
  fontSize: spacing(2, scale),
  fontWeight: '700' as const,
  textTransform: 'uppercase' as const,
  color: HABIT_TEXT_COLOR,
});

const StreakText = ({
  streakText,
  streakStyle,
  scale,
}: {
  streakText: string;
  streakStyle: object;
  scale: number;
}) => (
  <Text
    style={[
      {
        fontSize: spacing(1.5, scale),
        textTransform: 'uppercase' as const,
        color: HABIT_TEXT_COLOR,
      },
      streakStyle,
    ]}
  >
    {streakText}
  </Text>
);

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
    <StreakText streakText={streakText} streakStyle={streakStyle} scale={scale} />
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
        <StreakText streakText={streakText} streakStyle={streakStyle} scale={scale} />
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

const TOTAL_HABITS = MAX_HABITS;

/** Tile border thickness so the aptitude/stage color reads clearly at a glance. */
export const TILE_BORDER_WIDTH = 3;

// Empirical vertical budget reserved for the screen chrome the hook cannot
// measure directly: the top action bar, the SafeAreaView container padding, a
// footer/pagination allowance, and one grid gutter. Kept flat so the hook stays
// A-grade. When a footer or pagination bar is visible the small remainder falls
// to the FlatList scroll (the documented short-viewport degrade).
const habitGridChrome = (scale: number, gridGutter: number): number =>
  2 * spacing(1, scale) + spacing(3, scale) + 2 * spacing(1, scale) + SPACING.sm + gridGutter;

export const useTileLayout = () => {
  const { contentWidth, height, columns, scale, gridGutter } = useResponsive();
  const insets = useSafeAreaInsets();
  const rows = columns === 2 ? TOTAL_HABITS / columns : TOTAL_HABITS;
  const chrome = habitGridChrome(scale, gridGutter);
  const bottomBarReserve = BOTTOM_TAB_BAR_CONTENT_HEIGHT + insets.bottom;
  const availableHeight = height - insets.top - bottomBarReserve - chrome;
  const rowPitch = availableHeight / rows;
  // Floor to whole pixels so the reserved stack never rounds above the viewport.
  const tileMinHeight = Math.max(touchTarget.minimum, Math.floor(rowPitch - gridGutter));
  // Size tiles off the content-capped width so a wide viewport lays them out at
  // the same measure the shared ContentContainer renders the grid at, rather
  // than off the raw (uncapped) window width.
  const tileWidth = contentWidth / columns;
  const iconInline = columns === 1 || tileWidth < 400;
  return { columns, scale, gridGutter, tileMinHeight, iconInline };
};

/** A tile marker spec carries its resolved `Goal` for tooltip formatting. */
interface TileMarkerSpec extends TierMarkerSpec {
  goal: Goal;
}

/** Tile tooltip body: the tier progress line, sized to scale with the tile. */
const TileTooltipText = ({
  goal,
  habit,
  tz,
  scale,
}: {
  goal: Goal;
  habit: Habit;
  tz: string;
  scale: number;
}) => (
  <Text
    style={{
      fontSize: spacing(1.5, scale),
      color: '#333',
      fontFamily: 'serif',
      fontStyle: 'italic',
      letterSpacing: 0.5,
    }}
  >
    {formatGoalTooltip(goal, habit, tz)}
  </Text>
);

/** A quick tap on any marker reveals its tier-progress tooltip; no fill is armed. */
const tooltipOnlyInteraction = (
  tier: TierType,
  setTooltip: (_v: TierType | null) => void,
): MarkerInteraction => ({
  Wrapper: TouchableOpacity,
  interactionProps: {
    onPressIn: () => setTooltip(tier),
    onPressOut: () => setTooltip(null),
  },
});

/**
 * A logging tile mirrors the goal modal's star behavior: a quick tap still shows
 * the tooltip, but holding past the shared long-press delay arms the fill sweep
 * toward that star and logs its delta on arrival; an early release reverts.
 */
const fillMarkerInteraction = (
  tier: TierType,
  setTooltip: (_v: TierType | null) => void,
  starFill: StarFillControls,
): MarkerInteraction => ({
  Wrapper: TouchableOpacity,
  interactionProps: {
    onPressIn: () => setTooltip(tier),
    onPressOut: () => {
      setTooltip(null);
      starFill.release();
    },
    onLongPress: () => starFill.begin(tier),
    delayLongPress: STAR_LONG_PRESS_MS,
    accessibilityRole: 'button',
    accessibilityLabel: TIER_LABELS[tier],
    accessibilityHint: `Hold to log your ${TIER_LABELS[tier]} for today.`,
  },
});

/**
 * Stars only arm the fill when the tile is actually wired to log units; without
 * a real `onLogUnit` the marker stays tooltip-only so it never silently sweeps
 * toward a no-op.
 */
const tileMarkerInteraction = (
  tier: TierType,
  setTooltip: (_v: TierType | null) => void,
  starFill: StarFillControls,
  hasLogUnit: boolean,
): MarkerInteraction =>
  hasLogUnit
    ? fillMarkerInteraction(tier, setTooltip, starFill)
    : tooltipOnlyInteraction(tier, setTooltip);

interface ProgressBarProps {
  habit: Habit;
  barHeight: number;
  progressPercentage: number;
  progressBarColor: string;
  markers: TileMarkerSpec[];
  scale: number;
  tooltip: TierType | null;
  setTooltip: (_v: TierType | null) => void;
  tz: string;
  starFill: StarFillControls;
  hasLogUnit: boolean;
}

const COLOR_TRANSITION_MS = 400;

const useColorTransition = (color: string) => {
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const prevColorRef = useRef(color);

  useEffect(() => {
    if (prevColorRef.current !== color) {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: COLOR_TRANSITION_MS,
        easing: Easing.linear,
        useNativeDriver: false,
      }).start(() => {
        prevColorRef.current = color;
      });
    }
  }, [color, fadeAnim]);

  return { fadeAnim, prevColor: prevColorRef.current };
};

interface AnimatedFillProps {
  width: DimensionValue;
  color: string;
  prevColor: string;
  fadeAnim: Animated.Value;
  borderRadius: number;
}

const AnimatedFill = ({ width, color, prevColor, fadeAnim, borderRadius }: AnimatedFillProps) => (
  <>
    <View
      style={{
        position: 'absolute',
        height: '100%',
        width,
        backgroundColor: prevColor,
        borderRadius,
      }}
    />
    <Animated.View
      testID="progress-fill"
      style={{
        position: 'absolute',
        height: '100%',
        width,
        backgroundColor: color,
        borderRadius,
        opacity: fadeAnim,
      }}
    />
  </>
);

interface TileMarkerLayerProps {
  habit: Habit;
  tz: string;
  scale: number;
  barHeight: number;
  markers: TileMarkerSpec[];
  tooltip: TierType | null;
  setTooltip: (_v: TierType | null) => void;
  starFill: StarFillControls;
  hasLogUnit: boolean;
}

/** The tier-star overlay that sits atop the tile bar, wired for tap-tooltip and long-press fill. */
const TileMarkerLayer = ({
  habit,
  tz,
  scale,
  barHeight,
  markers,
  tooltip,
  setTooltip,
  starFill,
  hasLogUnit,
}: TileMarkerLayerProps) => (
  <TierMarkerOverlay<TileMarkerSpec>
    markers={markers}
    barHeight={barHeight}
    starSize={markerStarSize(scale)}
    tooltip={tooltip}
    setTooltip={setTooltip}
    markerTestIDPrefix="marker"
    tooltipTestIDPrefix="tooltip"
    renderTooltip={(m) => <TileTooltipText goal={m.goal} habit={habit} tz={tz} scale={scale} />}
    resolveInteraction={(m) => tileMarkerInteraction(m.tier, setTooltip, starFill, hasLogUnit)}
  />
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
  tz,
  starFill,
  hasLogUnit,
}: ProgressBarProps) => {
  const { fadeAnim, prevColor } = useColorTransition(progressBarColor);
  const borderR = barHeight / 2;

  return (
    <View style={{ marginTop: spacing(tileDensity.barGap, scale) }}>
      <View style={{ height: barHeight, position: 'relative' }}>
        <View
          style={{
            height: '100%',
            backgroundColor: '#eee',
            borderRadius: borderR,
            overflow: 'hidden',
          }}
        >
          <AnimatedFill
            width={`${progressPercentage}%`}
            color={progressBarColor}
            prevColor={prevColor}
            fadeAnim={fadeAnim}
            borderRadius={borderR}
          />
        </View>
        <TileMarkerLayer
          habit={habit}
          tz={tz}
          scale={scale}
          barHeight={barHeight}
          markers={markers}
          tooltip={tooltip}
          setTooltip={setTooltip}
          starFill={starFill}
          hasLogUnit={hasLogUnit}
        />
      </View>
    </View>
  );
};

const useHabitTileData = (habit: Habit, tz: string, stageColor: string) => {
  const lowGoal = habit.goals.find((g) => g.tier === 'low');
  const clearGoal = habit.goals.find((g) => g.tier === 'clear');
  const stretchGoal = habit.goals.find((g) => g.tier === 'stretch');

  const { currentGoal, completedAllGoals } = getGoalTier(habit, tz);
  const progressPercentage = clampPercentage(getProgressPercentage(habit, currentGoal, tz));
  const progressBarColor = getProgressBarColor(habit, tz, stageColor);
  const hasCompletedGoal = completedAllGoals || progressPercentage >= 100;

  const {
    low: lowMarker,
    clear: clearMarker,
    stretch: stretchMarker,
  } = getMarkerPositions(lowGoal, clearGoal, stretchGoal);

  // SG is unconditionally visible (the prior ``hasCleared`` gate caused user-reported confusion).
  // ``met`` is only computed when the goal exists — an absent tier has no goal to achieve.
  const markers: TileMarkerSpec[] = [
    {
      goal: lowGoal!,
      tier: 'low',
      position: lowMarker,
      zIndex: 1,
      visible: !!lowGoal,
      met: lowGoal ? isGoalAchieved(lowGoal, habit, tz) : false,
    },
    {
      goal: clearGoal!,
      tier: 'clear',
      position: clearMarker,
      zIndex: 2,
      visible: !!clearGoal,
      met: clearGoal ? isGoalAchieved(clearGoal, habit, tz) : false,
    },
    {
      goal: stretchGoal!,
      tier: 'stretch',
      position: stretchMarker,
      zIndex: 3,
      visible: !!stretchGoal,
      met: stretchGoal ? isGoalAchieved(stretchGoal, habit, tz) : false,
    },
  ];

  return { progressPercentage, progressBarColor, hasCompletedGoal, markers };
};

const LOCKED_BACKGROUND = '#e8e8e8';
const LOCKED_OPACITY = 0.4;

// The calendar no longer participates in unlock — a locked habit is a standing
// invitation the user accepts by tapping, never a timer that counts down. So
// the label is a static "Stage X · Locked" regardless of start_date.
const getUnlockLabel = (habit: Habit): string => `Stage ${habit.stage} · Locked`;

interface LockedTileProps {
  habit: Habit;
  stageColor: string;
  scale: number;
  gridGutter: number;
  tileMinHeight: number;
  onUnlockHabit?: (_habitId: number) => void;
}

const getLockedTileStyle = (
  stageColor: string,
  scale: number,
  gridGutter: number,
  tileMinHeight: number,
) => ({
  flex: 1 as const,
  borderWidth: TILE_BORDER_WIDTH,
  borderColor: stageColor,
  paddingVertical: spacing(tileDensity.paddingV, scale),
  paddingHorizontal: spacing(1, scale),
  margin: gridGutter / 2,
  minHeight: tileMinHeight,
  borderRadius: spacing(1, scale),
  backgroundColor: LOCKED_BACKGROUND,
  opacity: LOCKED_OPACITY,
  ...longPressGestureStyle,
});

const LOCKED_NAME_STYLE = {
  flex: 1 as const,
  fontWeight: '700' as const,
  textTransform: 'uppercase' as const,
  color: '#999',
};

const LockedTileButton = ({
  habit,
  stageColor,
  scale,
  gridGutter,
  tileMinHeight,
  onUnlock,
}: Omit<LockedTileProps, 'onUnlockHabit'> & { onUnlock?: () => void }) => (
  <TouchableOpacity
    testID="habit-tile"
    accessibilityLabel={`${habit.name} locked`}
    // A locked tile's only affordance is the unlock invitation — both a tap and
    // a long-press open the same confirm dialog. No goal editor / stats behind it.
    onPress={onUnlock}
    onLongPress={onUnlock}
    style={getLockedTileStyle(stageColor, scale, gridGutter, tileMinHeight)}
  >
    <View testID="habit-header" style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Text style={{ fontSize: spacing(2, scale), marginRight: spacing(1, scale) }}>🔒</Text>
      <Text style={{ ...LOCKED_NAME_STYLE, fontSize: spacing(2, scale) }}>{habit.name}</Text>
    </View>
    <Text
      testID="unlock-label"
      style={{
        fontSize: spacing(1.5, scale),
        color: '#999',
        marginTop: spacing(0.5, scale),
        fontStyle: 'italic',
      }}
    >
      {getUnlockLabel(habit)}
    </Text>
  </TouchableOpacity>
);

const LockedTile = ({ onUnlockHabit, ...rest }: LockedTileProps) => {
  const [showUnlockConfirm, setShowUnlockConfirm] = useState(false);
  const handleUnlock = onUnlockHabit ? () => setShowUnlockConfirm(true) : undefined;
  return (
    <>
      <LockedTileButton {...rest} onUnlock={handleUnlock} />
      <ConfirmDialog
        visible={showUnlockConfirm}
        title={`Unlock "${rest.habit.name}"?`}
        message="This habit is yours to begin whenever you choose. Unlock it now, or leave it locked and come back to it later."
        testID="unlock-habit-confirm"
        cancelTestID="unlock-habit-cancel"
        confirmTestID="unlock-habit-confirm-button"
        confirmLabel="Unlock"
        onCancel={() => setShowUnlockConfirm(false)}
        onConfirm={() => {
          setShowUnlockConfirm(false);
          onUnlockHabit?.(rest.habit.id);
        }}
      />
    </>
  );
};

interface UnlockedTileProps {
  habit: Habit;
  stageColor: string;
  onOpenGoals?: () => void;
  onLongPress?: () => void;
  onIconPress?: () => void;
  onLogUnit?: HabitTileProps['onLogUnit'];
  tz: string;
}

const buildUnlockedTileStyle = (
  stageColor: string,
  scale: number,
  gridGutter: number,
  tileMinHeight: number,
) => ({
  flex: 1 as const,
  borderWidth: TILE_BORDER_WIDTH,
  borderColor: stageColor,
  paddingVertical: spacing(tileDensity.paddingV, scale),
  paddingHorizontal: spacing(1, scale),
  margin: gridGutter / 2,
  minHeight: tileMinHeight,
  borderRadius: spacing(1, scale),
  backgroundColor: surface.canvas,
  ...longPressGestureStyle,
});

interface TileProgressSectionProps {
  habit: Habit;
  tz: string;
  scale: number;
  barHeight: number;
  progressPercentage: number;
  progressBarColor: string;
  markers: TileMarkerSpec[];
  onLogUnit?: HabitTileProps['onLogUnit'];
}

/**
 * The tile's progress bar plus its own tooltip state and the shared star-fill
 * animation. The hook is always called (rules-of-hooks); a tile with no real
 * logger gets a no-op, and `hasLogUnit` gates whether the stars ever arm the
 * sweep. While a fill/revert runs the animated frame wins over the static
 * percent, mirroring the goal modal's bar.
 */
const TileProgressSection = ({
  habit,
  tz,
  scale,
  barHeight,
  progressPercentage,
  progressBarColor,
  markers,
  onLogUnit,
}: TileProgressSectionProps) => {
  const [tooltip, setTooltip] = useState<TierType | null>(null);
  const fill = useStarFill({
    habit,
    tz,
    progressPercent: progressPercentage,
    onLogUnit: onLogUnit ?? NOOP_LOG_UNIT,
  });

  return (
    <ProgressBar
      habit={habit}
      barHeight={barHeight}
      progressPercentage={fill.displayPercent ?? progressPercentage}
      progressBarColor={progressBarColor}
      markers={markers}
      scale={scale}
      tooltip={tooltip}
      setTooltip={setTooltip}
      tz={tz}
      starFill={fill}
      hasLogUnit={onLogUnit !== undefined}
    />
  );
};

const UnlockedTile = ({
  habit,
  stageColor,
  onOpenGoals,
  onLongPress,
  onIconPress,
  onLogUnit,
  tz,
}: UnlockedTileProps) => {
  const { scale, gridGutter, tileMinHeight, iconInline } = useTileLayout();
  const { progressPercentage, progressBarColor, hasCompletedGoal, markers } = useHabitTileData(
    habit,
    tz,
    stageColor,
  );

  const streakText =
    `${habit.streak} days${hasCompletedGoal ? ' — Achieved Today!' : ''}`.toUpperCase();
  const barHeight = Math.max(8, spacing(2, scale));

  return (
    <TouchableOpacity
      testID="habit-tile"
      style={buildUnlockedTileStyle(stageColor, scale, gridGutter, tileMinHeight)}
      onPress={onOpenGoals}
      onLongPress={onLongPress}
    >
      <HabitHeader
        habit={habit}
        stageColor={stageColor}
        scale={scale}
        streakText={streakText}
        hasCompletedGoal={hasCompletedGoal}
        iconInline={iconInline}
        onIconPress={onIconPress}
      />
      <TileProgressSection
        habit={habit}
        tz={tz}
        scale={scale}
        barHeight={barHeight}
        progressPercentage={progressPercentage}
        progressBarColor={progressBarColor}
        markers={markers}
        onLogUnit={onLogUnit}
      />
    </TouchableOpacity>
  );
};

const HabitTileComponent = ({
  habit,
  locked,
  onOpenGoals,
  onLongPress,
  onIconPress,
  onUnlockHabit,
  onLogUnit,
  tz = DEFAULT_TIMEZONE,
  stageColor,
  globalIndex = 0,
}: HabitTileProps) => {
  const { scale, gridGutter, tileMinHeight } = useTileLayout();
  const color = stageColor ?? STAGE_COLORS[habit.stage] ?? '#000';

  // Handlers are always provided (so they stay stable for React.memo), but
  // LockedTile deliberately does NOT expose onOpenGoals/onLongPress/onIconPress
  // in its UI — its only interaction is the unlock dialog. So those handlers
  // are never invoked for a locked row; the rendercount test pins this.
  if (locked) {
    return (
      <LockedTile
        habit={habit}
        stageColor={color}
        scale={scale}
        gridGutter={gridGutter}
        tileMinHeight={tileMinHeight}
        onUnlockHabit={onUnlockHabit}
      />
    );
  }

  // Bind the stable parent handlers to this tile's habit/index. These wrappers
  // are recreated only when the tile actually re-renders (below the memo
  // boundary), so they never defeat React.memo on unchanged rows.
  return (
    <UnlockedTile
      habit={habit}
      stageColor={color}
      onOpenGoals={onOpenGoals ? () => onOpenGoals(habit) : undefined}
      onLongPress={onLongPress ? () => onLongPress(habit) : undefined}
      onIconPress={onIconPress ? () => onIconPress(globalIndex) : undefined}
      onLogUnit={onLogUnit}
      tz={tz}
    />
  );
};

// Memoized so a state change elsewhere (logging a unit, opening a modal) does
// not re-render every visible row — only rows whose props actually changed
// (issue #468). Relies on the parent passing stable handler references.
export const HabitTile = React.memo(HabitTileComponent);

export default HabitTile;
