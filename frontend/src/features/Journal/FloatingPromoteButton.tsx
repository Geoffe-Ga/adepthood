/**
 * ``FloatingPromoteButton`` — the action that comes to a selection (#3134).
 *
 * A reader who highlights a sentence deep in a long text should not have to
 * scroll to a footer to act on it, so the moment a passage is chosen this pill
 * rises into view above the bottom-middle of whatever frame hosts it, and it
 * withdraws the moment the selection collapses. It wears the Course reader
 * footer's vocabulary: the one solid terracotta call to action (a quote mark
 * and its label) beside quiet glass companions — an optional secondary action
 * and a trailing X that clears the selection.
 *
 * Presentational only. It positions itself ``absolute`` at
 * ``RESONANCE_BUTTON_CLEARANCE`` above the bottom of its nearest positioned
 * ancestor, centred across it; the host chooses that frame (the quote
 * selection surface hands it a dock pinned to the foot of its scroll viewport)
 * and wires what each press means. Every surface that promotes a passage —
 * journal read mode, a review's sources, and later Course chapters and letters
 * — renders this one component, so the gesture is learned once.
 */
import { Quote, X } from 'lucide-react-native';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ViewStyle,
} from 'react-native';

import { RESONANCE_BUTTON_CLEARANCE } from './JournalEntry.styles';
import { CLOSE_ICON_SIZE, CLOSE_PRESSED_COLOR, CLOSE_REST_COLOR } from './ReflectionDismiss';

import { decorativeHidden } from '@/components/a11yHidden';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  motion,
  surface,
  surfaceShadow,
  touchTarget,
  uiType,
} from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/** The pill's default ``testID``; its parts append ``-anchor``, ``-cancel`` and so on. */
export const FLOATING_PROMOTE_TEST_ID = 'promote-selection-fab';

/** The primary's default label, shared with the selection surface's confirm. */
export const DEFAULT_PROMOTE_LABEL = 'Promote selection';
const DEFAULT_CANCEL_LABEL = 'Clear selection';

/** The quote mark beside the label, in dp: a step under the label's own size. */
const QUOTE_ICON_SIZE = 18;

/** The glass edge, in dp: the Course reader footer's hairline. */
const GLASS_HAIRLINE_WIDTH = 1;

/** CSS backdrop blur behind the glass on web, so prose under the pill frosts rather than shows through. */
const GLASS_BLUR_PX = 6;

/**
 * One layer above the page flow it floats over: enough to clear the text and
 * any sticky footer drawn before it, without reaching for the app's chrome.
 */
const FLOATING_LAYER = 1;

/**
 * Web-only true glass, after the Map magnifier's lens: blur whatever sits under
 * the pill. ``backdropFilter`` is a react-native-web CSS passthrough absent from
 * RN's ``ViewStyle``, so the fragment is typed through a narrowing cast and
 * attached on web only; native draws the translucent wash alone.
 */
const WEB_GLASS_STYLE: ViewStyle | null =
  Platform.OS === 'web'
    ? ({
        backdropFilter: `blur(${GLASS_BLUR_PX}px)`,
        WebkitBackdropFilter: `blur(${GLASS_BLUR_PX}px)`,
      } as unknown as ViewStyle)
    : null;

/** A quieter action offered beside the primary one (a Course chapter's Write a note). */
export interface FloatingSecondaryAction {
  label: string;
  /** Defaults to ``label``. */
  accessibilityLabel?: string;
  onPress: () => void;
  /** Defaults to ``<testID>-secondary``. */
  testID?: string;
}

export interface FloatingPromoteButtonProps {
  /** True while a non-empty passage is chosen; false fades the pill out and unmounts it. */
  visible: boolean;
  /** The primary action: promote the chosen passage. */
  onPress: () => void;
  /** The primary label; defaults to "Promote selection". */
  label?: string;
  /** The primary's accessible name; defaults to ``label``. */
  accessibilityLabel?: string;
  secondaryAction?: FloatingSecondaryAction;
  /** The trailing X; omit it and no X is drawn. */
  onCancel?: () => void;
  /** The X's accessible name; defaults to "Clear selection". */
  cancelAccessibilityLabel?: string;
  /** True while the primary's work is in flight: a working mark, and no second press. */
  busy?: boolean;
  testID?: string;
}

/** Whether the pill is in the tree, the 0..1 progress its fade and settle read, and the motion wish. */
interface FloatingPresence {
  mounted: boolean;
  progress: Animated.Value;
  reducedMotion: boolean;
}

/**
 * Keep the pill mounted through its fade-out and drop it from the tree once the
 * fade has run, so a withdrawn pill is not merely invisible. Arrival settles in
 * over ``motion.base``, departure is quicker (``motion.fast``) because the
 * reader has already moved on. Under reduced motion both are instant.
 */
function useFloatingPresence(visible: boolean): FloatingPresence {
  const reducedMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
    if (reducedMotion) {
      progress.setValue(visible ? 1 : 0);
      if (!visible) setMounted(false);
      return undefined;
    }
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? motion.base : motion.fast,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [visible, reducedMotion, progress]);

  return { mounted: mounted || visible, progress, reducedMotion };
}

/**
 * The leading mark: the quote, or a working indicator while busy -- which,
 * under reduced motion, settles into a static mark rather than spinning.
 */
function PrimaryMark({
  busy,
  reducedMotion,
  testID,
}: {
  busy: boolean;
  reducedMotion: boolean;
  testID: string;
}): React.JSX.Element {
  if (busy) {
    return (
      <ActivityIndicator
        accessible={false}
        animating={!reducedMotion}
        hidesWhenStopped={false}
        color={accent.onPrimary}
        size="small"
        testID={`${testID}-busy`}
      />
    );
  }
  // The label names the action, so the mark is decoration: hidden on a wrapper
  // that also carries the testID, which a lucide glyph does not forward on
  // every platform.
  return (
    <View testID={`${testID}-icon`} {...decorativeHidden()}>
      <Quote size={QUOTE_ICON_SIZE} color={accent.onPrimary} />
    </View>
  );
}

/** The trailing X, holding its own pressed state so the glyph can take the accent. */
function ClearControl({
  onPress,
  accessibilityLabel,
  interactive,
  testID,
}: {
  onPress: () => void;
  accessibilityLabel: string;
  interactive: boolean;
  testID: string;
}): React.JSX.Element {
  const [pressed, setPressed] = useState(false);
  return (
    <TouchableOpacity
      style={[styles.glass, styles.clear, WEB_GLASS_STYLE]}
      // The accent tint IS the press feedback, as on the reflection cards' X.
      activeOpacity={1}
      onPress={interactive ? onPress : undefined}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      disabled={!interactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={`${testID}-cancel`}
    >
      <X
        size={CLOSE_ICON_SIZE}
        color={pressed ? CLOSE_PRESSED_COLOR : CLOSE_REST_COLOR}
        {...decorativeHidden()}
      />
    </TouchableOpacity>
  );
}

/** The secondary glass action, labelled in the accent like a tertiary button. */
function SecondaryControl({
  action,
  interactive,
  testID,
}: {
  action: FloatingSecondaryAction;
  interactive: boolean;
  testID: string;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[styles.glass, styles.secondary, WEB_GLASS_STYLE]}
      onPress={interactive ? action.onPress : undefined}
      disabled={!interactive}
      accessibilityRole="button"
      accessibilityLabel={action.accessibilityLabel ?? action.label}
      testID={action.testID ?? `${testID}-secondary`}
    >
      <Text style={styles.secondaryLabel}>{action.label}</Text>
    </TouchableOpacity>
  );
}

/** The primary call to action: the quote mark (or busy mark) and its label. */
function PrimaryControl({
  onPress,
  label,
  accessibilityLabel,
  busy,
  interactive,
  reducedMotion,
  testID,
}: {
  onPress: () => void;
  label: string;
  accessibilityLabel: string;
  busy: boolean;
  interactive: boolean;
  reducedMotion: boolean;
  testID: string;
}): React.JSX.Element {
  // Busy or withdrawn-but-fading: no second press reaches the work.
  const enabled = interactive && !busy;
  return (
    <TouchableOpacity
      style={styles.primary}
      onPress={enabled ? onPress : undefined}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !enabled, busy }}
      testID={testID}
    >
      <PrimaryMark busy={busy} reducedMotion={reducedMotion} testID={testID} />
      <Text style={styles.primaryLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function FloatingPromoteButton({
  visible,
  onPress,
  label = DEFAULT_PROMOTE_LABEL,
  accessibilityLabel,
  secondaryAction,
  onCancel,
  cancelAccessibilityLabel = DEFAULT_CANCEL_LABEL,
  busy = false,
  testID = FLOATING_PROMOTE_TEST_ID,
}: FloatingPromoteButtonProps): React.JSX.Element | null {
  const { mounted, progress, reducedMotion } = useFloatingPresence(visible);
  if (!mounted) return null;
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [motion.settleY, 0] });
  return (
    <Animated.View
      style={[styles.anchor, { opacity: progress, transform: [{ translateY }] }]}
      // ``box-none``: the band spans its frame, so only the pills take touches
      // and a tap beside them still lands on the text beneath. Withdrawn but
      // still fading, it is hidden from every reader and inert to touch.
      pointerEvents={visible ? 'box-none' : 'none'}
      testID={`${testID}-anchor`}
      {...decorativeHidden(!visible)}
    >
      <View style={styles.row} pointerEvents="box-none">
        <PrimaryControl
          onPress={onPress}
          label={label}
          accessibilityLabel={accessibilityLabel ?? label}
          busy={busy}
          interactive={visible}
          reducedMotion={reducedMotion}
          testID={testID}
        />
        {secondaryAction == null ? null : (
          <SecondaryControl action={secondaryAction} interactive={visible} testID={testID} />
        )}
        {onCancel == null ? null : (
          <ClearControl
            onPress={onCancel}
            accessibilityLabel={cancelAccessibilityLabel}
            interactive={visible}
            testID={testID}
          />
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  /**
   * Lifted one resonance band above the frame's foot — the journal's floating
   * band, where the writing timer floats too — and centred across the frame.
   */
  anchor: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: RESONANCE_BUTTON_CLEARANCE,
    alignItems: 'center',
    zIndex: FLOATING_LAYER,
  },
  /** The pills share one row, one height and one centre line (Action rows rule b). */
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  /**
   * The one solid control, as on the Course reader footer: a call to action has
   * to read over whatever prose lies under it, so the accent fill carries it.
   */
  primary: {
    minHeight: touchTarget.minimum,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.xl,
    borderRadius: BORDER_RADIUS.circle,
    backgroundColor: accent.primary,
    ...surfaceShadow.raised,
  },
  primaryLabel: {
    ...uiType.button,
    color: accent.onPrimary,
  },
  /**
   * The Course footer's glass — a hairline edge and a soft lift — with a denser
   * wash, because this pill floats over full-strength prose rather than over
   * the reader's bottom fade.
   */
  glass: {
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BORDER_RADIUS.circle,
    borderWidth: GLASS_HAIRLINE_WIDTH,
    borderColor: surface.hairline,
    backgroundColor: colors.mystical.transparentLight,
    ...surfaceShadow.card,
  },
  clear: {
    minWidth: touchTarget.minimum,
  },
  secondary: {
    paddingHorizontal: SPACING.lg,
  },
  secondaryLabel: {
    ...uiType.button,
    color: accent.primary,
  },
});

export default FloatingPromoteButton;
