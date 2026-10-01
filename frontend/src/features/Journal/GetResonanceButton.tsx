/**
 * ``GetResonanceButton`` — the affordance that asks the page to read itself back.
 *
 * One presentation: in the page flow, centred in the margin that hosts it in
 * both modes and at every width (#3004). It fades in and out with ``visible``
 * and gives its space back while hidden. Presentational only: the hosting
 * screen wires the resonance request and decides when it is visible.
 */
import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, StyleSheet, Text, TouchableOpacity } from 'react-native';

import { decorativeHidden } from '@/components/a11yHidden';
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

export interface GetResonanceButtonProps {
  visible: boolean;
  loading?: boolean;
  checking?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

/** Derive the button's view state (keeps the component's branching low). */
function getButtonState(visible: boolean, loading: boolean, checking: boolean, disabled: boolean) {
  const busy = loading || checking;
  return {
    // Hidden = inert: not pressable and not reachable by the screen reader.
    interactive: visible && !disabled && !busy,
    // ``box-none``, not ``auto``: the wrapper spans its column, so an ``auto``
    // band takes every touch across its full width — not only the ones aimed at
    // the button centred in it. The button below claims its own touches; the
    // band claims none. Hidden stays ``none`` so an invisible affordance is
    // inert rather than merely transparent.
    pointerEvents: (visible ? 'box-none' : 'none') as 'box-none' | 'none',
    // The margin's measure is fixed, so the checking label stays short; the
    // accessible name below carries the whole phrase.
    label: loading ? 'Listening…' : checking ? 'Checking…' : 'Get Resonance',
    a11yLabel: loading
      ? 'Listening to your writing'
      : checking
        ? 'Checking resonance availability'
        : 'Get resonance',
    busy,
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

function busyIndicator(busy: boolean): React.JSX.Element | null {
  return busy ? <ResonanceSpinner /> : null;
}

function GetResonanceButton({
  visible,
  loading = false,
  checking = false,
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
  const view = getButtonState(visible, loading, checking, disabled);

  return (
    <Animated.View
      style={[
        styles.wrapper,
        visible ? null : styles.collapsed,
        { opacity: anim, transform: [{ translateY }] },
      ]}
      pointerEvents={view.pointerEvents}
      // Every reader skips a hidden band, the web's included. Hidden forces the
      // button below disabled, so no focusable control sits inside aria-hidden.
      {...decorativeHidden(!visible)}
    >
      {/* The one thing in the band that is meant to be pressed: a touchable is
          its own touch target, so ``box-none`` above reaches it and nothing
          else in the band. */}
      <TouchableOpacity
        style={styles.button}
        onPress={view.interactive ? onPress : undefined}
        disabled={!view.interactive}
        accessibilityRole="button"
        accessibilityLabel={view.a11yLabel}
        accessibilityState={{ disabled: !view.interactive, busy: view.busy }}
        testID="get-resonance-button"
      >
        {busyIndicator(view.busy)}
        <Text style={styles.label}>{view.label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  /** Centred within the margin group; that parent owns vertical settlement. */
  wrapper: {
    alignItems: 'center',
  },
  /**
   * A hidden button surrenders its box entirely rather than fading to a
   * transparent one — a zero-height clip, not a design measure. The fade still
   * runs; this only stops the invisible frame from spacing the margin apart.
   */
  collapsed: {
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
