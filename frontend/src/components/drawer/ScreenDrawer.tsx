/**
 * A left-anchored, slide-in drawer panel presented over the current screen. The
 * panel width tracks the viewport (clamped for tablets), a labelled scrim closes
 * it, and the slide honours the OS reduce-motion setting by snapping open with no
 * transition. Because a ``Modal`` with ``visible={false}`` renders nothing, the
 * component is fully unmounted when closed.
 */
import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

import { colors, ink, motion, SPACING, surface, surfaceShadow, type } from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/** Fraction of the viewport width the drawer occupies before clamping. */
const DRAWER_WIDTH_FRACTION = 0.8;
/** Upper bound on drawer width in dp so it stays a drawer on wide screens. */
const DRAWER_MAX_WIDTH = 320;
/** Resting horizontal offset of the fully-open panel. */
const OPEN_TRANSLATE_X = 0;

export interface ScreenDrawerProps {
  /** Whether the drawer is mounted and open. */
  visible: boolean;
  /** Fired when the scrim is pressed or the OS back gesture requests close. */
  onClose: () => void;
  /** Human-readable screen name used to build the scrim's accessibility label. */
  screenName: string;
  /** Optional heading rendered at the top of the panel. */
  title?: string;
  /** Panel contents. */
  children: React.ReactNode;
  /** Test hook for the underlying Modal; defaults to ``screen-drawer``. */
  testID?: string;
}

/** Drive the panel's horizontal slide, snapping open under reduced motion. */
function useDrawerSlide(panelWidth: number, visible: boolean): Animated.Value {
  const reduced = useReducedMotion();
  const translateX = useRef(new Animated.Value(-panelWidth)).current;

  useEffect(() => {
    const toValue = visible ? OPEN_TRANSLATE_X : -panelWidth;
    if (reduced) {
      translateX.setValue(toValue);
      return;
    }
    const animation = Animated.timing(translateX, {
      toValue,
      duration: motion.base,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [reduced, translateX, visible, panelWidth]);

  return translateX;
}

interface DrawerPanelProps {
  panelWidth: number;
  translateX: Animated.Value;
  title?: string;
  children: React.ReactNode;
}

/** The sliding panel: an optional heading above a scrollable body. */
function DrawerPanel({
  panelWidth,
  translateX,
  title,
  children,
}: DrawerPanelProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  return (
    <Animated.View
      style={[styles.panel, { width: panelWidth, transform: [{ translateX }] }]}
      testID="screen-drawer-panel"
    >
      {title === undefined ? null : (
        <Text style={[type(width).heading, styles.title]}>{title}</Text>
      )}
      <ScrollView style={styles.scroll}>{children}</ScrollView>
    </Animated.View>
  );
}

/** A slide-in, scrim-dismissable drawer anchored to the left of the screen. */
export default function ScreenDrawer({
  visible,
  onClose,
  screenName,
  title,
  children,
  testID,
}: ScreenDrawerProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(width * DRAWER_WIDTH_FRACTION, DRAWER_MAX_WIDTH);
  const translateX = useDrawerSlide(panelWidth, visible);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      testID={testID ?? 'screen-drawer'}
    >
      <View accessibilityViewIsModal style={styles.root}>
        <DrawerPanel panelWidth={panelWidth} translateX={translateX} title={title}>
          {children}
        </DrawerPanel>
        <TouchableOpacity
          style={styles.scrim}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={`Close ${screenName} menu`}
          testID="screen-drawer-scrim"
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    flexDirection: 'row',
  },
  panel: {
    backgroundColor: surface.raised,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: surface.hairline,
    padding: SPACING.lg,
    ...surfaceShadow.raised,
  },
  title: {
    color: ink.primary,
    marginBottom: SPACING.md,
  },
  scroll: {
    flexGrow: 0,
  },
  scrim: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
  },
});
