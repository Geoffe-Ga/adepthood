/**
 * ``GetResonanceButton`` — a soft floating affordance that fades in when the
 * user pauses writing and tucks away while they type. Presentational only: the
 * request is wired by the screen that hosts it (a later issue).
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity } from 'react-native';

import { BORDER_RADIUS, SPACING, colors, shadows, touchTarget } from '@/design/tokens';

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

export interface GetResonanceButtonProps {
  visible: boolean;
  loading?: boolean;
  disabled?: boolean;
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

function GetResonanceButton({
  visible,
  loading = false,
  disabled = false,
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

  return (
    <Animated.View
      style={[styles.wrapper, { opacity: anim, transform: [{ translateY }] }]}
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
        <Text style={styles.label}>{view.label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    right: SPACING.lg,
    bottom: SPACING.xl,
  },
  button: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    borderRadius: BORDER_RADIUS.xxl,
    backgroundColor: colors.primary,
    ...shadows.medium,
  },
  label: {
    color: colors.text.light,
    fontSize: 16,
    fontWeight: '600',
  },
});

export default GetResonanceButton;
