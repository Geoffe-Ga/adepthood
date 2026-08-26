/**
 * ``GetResonanceButton`` — the affordance that asks the page to read itself back.
 *
 * Two presentations. Floating (the default) is the writing surface's: it fades in
 * when the user pauses writing and tucks away while they type. Inline sits in the
 * page flow as a steady control, for the reading view where nothing is being
 * typed and so nothing should be getting out of the way. Presentational only:
 * the hosting screen wires the resonance request.
 */
import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, StyleSheet, Text, TouchableOpacity } from 'react-native';

import { BORDER_RADIUS, SPACING, colors, shadows, touchTarget, uiType } from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/** Pure visibility rule, extracted so it can be unit-tested without rendering. */
export interface ResonanceVisibilityInput {
  isIdle: boolean;
  hasContent: boolean;
  isLoading: boolean;
}

export function shouldShowResonance({
  isIdle,
  hasContent,
  isLoading,
}: ResonanceVisibilityInput): boolean {
  // Stay visible while a pass is running so the loading state is never orphaned.
  if (isLoading) return true;
  return isIdle && hasContent;
}

const FADE_DURATION_MS = 220;
const SLIDE_DISTANCE = 8;

/** Where the button sits: lifted over the page, or in the flow of it. */
export type ResonanceButtonLayout = 'floating' | 'inline';

export interface GetResonanceButtonProps {
  visible: boolean;
  loading?: boolean;
  disabled?: boolean;
  layout?: ResonanceButtonLayout;
  onPress: () => void;
}

/** Derive the button's view state (keeps the component's branching low). */
function getButtonState(visible: boolean, loading: boolean, disabled: boolean) {
  return {
    // Hidden = inert: not pressable and not reachable by the screen reader.
    interactive: visible && !disabled && !loading,
    pointerEvents: (visible ? 'auto' : 'none') as 'auto' | 'none',
    importantForA11y: (visible ? 'auto' : 'no-hide-descendants') as 'auto' | 'no-hide-descendants',
    label: loading ? 'Listening…' : 'Get Resonance',
    a11yLabel: loading ? 'Listening to your writing' : 'Get resonance',
  };
}

/**
 * The in-progress mark beside the busy label, so a running pass reads as running
 * and not merely as a relabelled button. It carries no accessible name of its
 * own: the button already announces ``busy``, and a second voice for the same
 * fact is noise. Under reduced motion it settles into a static mark rather than
 * spinning — still visibly a busy state, just not an animated one.
 */
function ResonanceSpinner(): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  return (
    <ActivityIndicator
      testID="resonance-loading"
      size="small"
      color={colors.text.light}
      animating={!reducedMotion}
      hidesWhenStopped={false}
      accessible={false}
    />
  );
}

function GetResonanceButton({
  visible,
  loading = false,
  disabled = false,
  layout = 'floating',
  onPress,
}: GetResonanceButtonProps): React.JSX.Element {
  const anim = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: FADE_DURATION_MS,
      useNativeDriver: true,
    }).start();
  }, [visible, anim]);

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [SLIDE_DISTANCE, 0] });
  const view = getButtonState(visible, loading, disabled);
  // Only the inline variant has to give its space back. Floating is absolutely
  // positioned, so a hidden one already costs the flow nothing; inline sits in
  // the flow and would otherwise leave a transparent gap in the action row.
  const collapsed = layout === 'inline' && !visible;

  return (
    <Animated.View
      style={[
        layout === 'inline' ? styles.inlineWrapper : styles.floatingWrapper,
        collapsed ? styles.inlineCollapsed : null,
        { opacity: anim, transform: [{ translateY }] },
      ]}
      pointerEvents={view.pointerEvents}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={view.importantForA11y}
    >
      <TouchableOpacity
        style={styles.button}
        onPress={view.interactive ? onPress : undefined}
        disabled={!view.interactive}
        accessibilityRole="button"
        accessibilityLabel={view.a11yLabel}
        accessibilityState={{ disabled: !view.interactive, busy: loading }}
        testID="get-resonance-button"
      >
        {loading ? <ResonanceSpinner /> : null}
        <Text style={styles.label}>{view.label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  /** Lifted clear of the writing surface, centred above the page's bottom edge. */
  floatingWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: SPACING.xl,
    alignItems: 'center',
  },
  /** In the flow of the reading column, sized to its own label. */
  inlineWrapper: {
    alignItems: 'flex-start',
  },
  /**
   * A hidden inline button surrenders its box entirely rather than fading to a
   * transparent one — a zero-height clip, not a design measure. The fade still
   * runs; this only stops the invisible frame from spacing the row apart.
   */
  inlineCollapsed: {
    height: 0,
    overflow: 'hidden',
  },
  button: {
    minHeight: touchTarget.minimum,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.xl,
    borderRadius: BORDER_RADIUS.xxl,
    backgroundColor: colors.primary,
    ...shadows.medium,
  },
  label: {
    color: colors.text.light,
    ...uiType.button,
  },
});

export default GetResonanceButton;
