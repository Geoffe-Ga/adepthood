/**
 * ``GetResonanceButton`` — the affordance that asks the page to read itself back.
 *
 * Three presentations. Floating (the default) is the narrow writing surface's:
 * it fades in when the user pauses writing and tucks away while they type.
 * Margin keeps that same writing action in the wide page's marginalia column.
 * Inline sits in the reading page's action row. Presentational only: the hosting
 * screen wires the resonance request.
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

/** Where the button sits: lifted over the page, in its margin, or in an action row. */
export type ResonanceButtonLayout = 'floating' | 'margin' | 'inline';

export interface GetResonanceButtonProps {
  visible: boolean;
  loading?: boolean;
  checking?: boolean;
  disabled?: boolean;
  layout?: ResonanceButtonLayout;
  onPress: () => void;
}

/** Derive the button's view state (keeps the component's branching low). */
function getButtonState(visible: boolean, loading: boolean, checking: boolean, disabled: boolean) {
  const busy = loading || checking;
  return {
    // Hidden = inert: not pressable and not reachable by the screen reader.
    interactive: visible && !disabled && !busy,
    // ``box-none``, not ``auto``: the floating wrapper spans the page edge to
    // edge, so an ``auto`` band takes every touch across its full width — not
    // only the ones aimed at the button centred in it. The button below claims
    // its own touches; the band claims none. Hidden stays ``none`` so an
    // invisible affordance is inert rather than merely transparent.
    pointerEvents: (visible ? 'box-none' : 'none') as 'box-none' | 'none',
    importantForA11y: (visible ? 'auto' : 'no-hide-descendants') as 'auto' | 'no-hide-descendants',
    label: loading ? 'Listening…' : checking ? 'Checking availability…' : 'Get Resonance',
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

/** Resolve one of the three explicit hosts without making the render branch on layout. */
function layoutWrapperStyle(layout: ResonanceButtonLayout) {
  if (layout === 'floating') return styles.floatingWrapper;
  if (layout === 'margin') return styles.marginWrapper;
  return styles.inlineWrapper;
}

/** Keep the longest transient label inside the fixed marginalia measure. */
function visibleLabel(layout: ResonanceButtonLayout, label: string): string {
  return layout === 'margin' && label === 'Checking availability…' ? 'Checking…' : label;
}

function GetResonanceButton({
  visible,
  loading = false,
  checking = false,
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
  const view = getButtonState(visible, loading, checking, disabled);
  const label = visibleLabel(layout, view.label);
  // Both in-flow variants have to give their space back. Floating is absolutely
  // positioned, so a hidden one already costs the flow nothing.
  const collapsed = layout !== 'floating' && !visible;

  return (
    <Animated.View
      style={[
        layoutWrapperStyle(layout),
        collapsed ? styles.inlineCollapsed : null,
        { opacity: anim, transform: [{ translateY }] },
      ]}
      pointerEvents={view.pointerEvents}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={view.importantForA11y}
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
        <Text style={styles.label}>{label}</Text>
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
  /** Centred within the margin group; that parent owns vertical settlement. */
  marginWrapper: {
    alignItems: 'center',
  },
  /**
   * A hidden in-flow button surrenders its box entirely rather than fading to a
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
