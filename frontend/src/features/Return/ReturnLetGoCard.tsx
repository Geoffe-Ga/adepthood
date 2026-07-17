/**
 * ``ReturnLetGoCard`` — the declinable let-go moment offered right after a
 * Return begins. It lists the person's currently-revealed habits so any of them
 * can be set to rest for the arc (releasing simply pauses them), or the whole
 * thing kept as it is. Releasing is framed as tending the foundation, never as
 * failing. Presentational + reduced-motion-safe; tokens only.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  RETURN_LETGO_BODY,
  RETURN_LETGO_EMPTY,
  RETURN_LETGO_ERROR,
  RETURN_LETGO_HEADING,
  RETURN_LETGO_RELEASE,
  RETURN_LETGO_RELEASE_A11Y,
  RETURN_LETGO_SKIP,
  RETURN_LETGO_SKIP_A11Y,
  buildReturnLetGoHabitA11y,
} from './returnCopy';

import { habits } from '@/api';
import type { ApiHabitWithGoals } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  paperShadow,
  spacing,
  touchTarget,
} from '@/design/tokens';
import { usePressScale } from '@/hooks/usePressScale';
import type { PressScale } from '@/hooks/usePressScale';
import { useReducedMotion } from '@/hooks/useReducedMotion';

export interface ReturnLetGoCardProps {
  onRelease: (_habitIds: number[]) => void;
  onSkip: () => void;
}

/** True for a habit the person has unlocked — the only kind offered to let rest. */
function isRevealed(habit: ApiHabitWithGoals): boolean {
  return habit.revealed === true;
}

/** Add or remove a habit id from the current selection. */
function toggleSelection(selected: number[], habitId: number): number[] {
  return selected.includes(habitId)
    ? selected.filter((id) => id !== habitId)
    : [...selected, habitId];
}

/** The revealed-habit load state: ``null`` habits means still loading. */
interface RevealedHabitsState {
  revealed: ApiHabitWithGoals[] | null;
  loadFailed: boolean;
}

/** Load the revealed habits once on mount, tracking a load failure distinctly. */
function useRevealedHabits(): RevealedHabitsState {
  const [revealed, setRevealed] = useState<ApiHabitWithGoals[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let mounted = true;
    const apply = (all: ApiHabitWithGoals[]): void => {
      if (mounted) setRevealed(all.filter(isRevealed));
    };
    const fallback = (): void => {
      // A failed load surfaces a distinct line, never the empty-state copy —
      // a flaky connection must not read as "you have nothing to release."
      if (mounted) {
        setRevealed([]);
        setLoadFailed(true);
      }
    };
    void habits.listAll().then(apply).catch(fallback);
    return () => {
      mounted = false;
    };
  }, []);
  return { revealed, loadFailed };
}

/** A single selectable habit row within the let-go picker. */
function HabitRow({
  habit,
  selected,
  onToggle,
}: {
  habit: ApiHabitWithGoals;
  selected: boolean;
  onToggle: (_habitId: number) => void;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[styles.habitRow, selected ? styles.habitRowSelected : undefined]}
      onPress={() => onToggle(habit.id)}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={buildReturnLetGoHabitA11y(habit.name)}
      testID={`return-letgo-habit-${habit.id}`}
    >
      <Text style={styles.habitName}>
        {habit.icon} {habit.name}
      </Text>
    </TouchableOpacity>
  );
}

/** The habit list, or the warm empty line when nothing is revealed to rest. */
function HabitPicker({
  revealed,
  selected,
  onToggle,
}: {
  revealed: ApiHabitWithGoals[];
  selected: number[];
  onToggle: (_habitId: number) => void;
}): React.JSX.Element {
  if (revealed.length === 0) {
    return <Text style={styles.empty}>{RETURN_LETGO_EMPTY}</Text>;
  }
  return (
    <View>
      {revealed.map((habit) => (
        <HabitRow
          key={habit.id}
          habit={habit}
          selected={selected.includes(habit.id)}
          onToggle={onToggle}
        />
      ))}
    </View>
  );
}

/** The picker, or the distinct load-error line when the habit list failed to load. */
function LetGoBody({
  revealed,
  loadFailed,
  selected,
  onToggle,
}: {
  revealed: ApiHabitWithGoals[];
  loadFailed: boolean;
  selected: number[];
  onToggle: (_habitId: number) => void;
}): React.JSX.Element {
  if (loadFailed) {
    return (
      <Text style={styles.empty} testID="return-letgo-error">
        {RETURN_LETGO_ERROR}
      </Text>
    );
  }
  return <HabitPicker revealed={revealed} selected={selected} onToggle={onToggle} />;
}

/** The release + skip button row. Release goes live only once something is chosen. */
function LetGoActions({
  nothingChosen,
  press,
  onRelease,
  onSkip,
}: {
  nothingChosen: boolean;
  press: PressScale;
  onRelease: () => void;
  onSkip: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.actions}>
      <TouchableOpacity
        style={[styles.release, nothingChosen ? styles.releaseDisabled : undefined]}
        onPress={onRelease}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        disabled={nothingChosen}
        accessibilityRole="button"
        accessibilityState={{ disabled: nothingChosen }}
        accessibilityLabel={RETURN_LETGO_RELEASE_A11Y}
        testID="return-letgo-release"
      >
        <Text style={styles.releaseText}>{RETURN_LETGO_RELEASE}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.skip}
        onPress={onSkip}
        accessibilityRole="button"
        accessibilityLabel={RETURN_LETGO_SKIP_A11Y}
        testID="return-letgo-skip"
      >
        <Text style={styles.skipText}>{RETURN_LETGO_SKIP}</Text>
      </TouchableOpacity>
    </View>
  );
}

function ReturnLetGoCard({ onRelease, onSkip }: ReturnLetGoCardProps): React.JSX.Element {
  const press = usePressScale(useReducedMotion());
  const { revealed, loadFailed } = useRevealedHabits();
  const [selected, setSelected] = useState<number[]>([]);

  const toggle = useCallback((habitId: number): void => {
    setSelected((prev) => toggleSelection(prev, habitId));
  }, []);
  // Releasing nothing is a no-op the backend rejects, so the affordance is only
  // live once something is chosen — "Keep them all" remains the empty path.
  const nothingChosen = selected.length === 0;

  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <View style={styles.card} testID="return-letgo-card">
        <Text style={styles.heading} accessibilityRole="header">
          {RETURN_LETGO_HEADING}
        </Text>
        <Text style={styles.body}>{RETURN_LETGO_BODY}</Text>
        {revealed === null ? (
          <View testID="return-letgo-loading" />
        ) : (
          <>
            <LetGoBody
              revealed={revealed}
              loadFailed={loadFailed}
              selected={selected}
              onToggle={toggle}
            />
            <LetGoActions
              nothingChosen={nothingChosen}
              press={press}
              onRelease={() => onRelease(selected)}
              onSkip={onSkip}
            />
          </>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.paper.background,
    borderLeftWidth: 3,
    borderLeftColor: colors.tier.low,
    ...paperShadow.card,
  },
  heading: {
    ...editorialType.title,
    color: colors.paper.ink,
  },
  body: {
    ...editorialType.marginNote,
    color: colors.paper.ink,
    marginTop: spacing(1),
  },
  empty: {
    ...editorialType.marginNote,
    color: colors.paper.inkSoft,
    marginTop: spacing(1.5),
  },
  habitRow: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    marginTop: spacing(1),
    borderRadius: BORDER_RADIUS.sm,
    borderWidth: 1,
    borderColor: colors.paper.hairline,
  },
  habitRowSelected: {
    borderColor: colors.tier.clear,
    backgroundColor: colors.paper.anchorHighlight,
  },
  habitName: {
    ...editorialType.marginNote,
    color: colors.paper.ink,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing(1.5),
    gap: spacing(1),
  },
  release: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.tier.clear,
    alignItems: 'center',
    justifyContent: 'center',
  },
  releaseDisabled: {
    opacity: 0.5,
  },
  releaseText: {
    ...editorialType.action,
    color: colors.paper.background,
  },
  skip: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipText: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
});

export default ReturnLetGoCard;
