// frontend/features/Map/MagnifierLens.tsx

/**
 * The Map's glass magnifier — the "you are here" box grown into a draggable
 * lens. A translucent pill floats over the center column, magnifying the wave
 * arcs beneath it (a second, scaled copy of the wave SVG stays locked under
 * the glass as it moves). Drag it along the strand to preview other stages —
 * the caption follows the stage under the glass live and the pill snaps to
 * the nearest stage on release. Tap it to open that stage's detail modal.
 *
 * While the lens is in motion a frost wash rises and the magnified artwork
 * fades, so the text and arrows passing beneath read as blurred glass (the
 * web build adds a true backdrop blur); when the glide slides to its stop the
 * frost clears and the arcs sharpen again. Every animation gates on
 * ``useReducedMotion`` and falls back to instant repositioning.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Platform, Text, View } from 'react-native';
import type { GestureResponderEvent, ViewStyle } from 'react-native';

import {
  clampLensCenter,
  DRAG_TAP_SLOP,
  glideDurationMs,
  inertialStageTarget,
  lensCaption,
  lensCenterForStage,
  lensFrame,
  magnifierTransform,
  MAGNIFICATION,
  nearestStage,
} from './magnifierGeometry';
import type { LensCenter, LensFrame } from './magnifierGeometry';
import styles from './Map.styles';
import type { StageAnchors } from './waveGeometry';
import { WaveOverlay } from './WaveOverlay';

import { useReducedMotion } from '@/hooks/useReducedMotion';

/** How long the frost wash takes to rise once the lens starts moving. */
const FROST_IN_MS = 140;

/** How long the frost takes to clear after the lens settles. */
const FROST_OUT_MS = 260;

/** Magnified-artwork opacity while the lens is in motion (the "blur" read). */
const MOTION_CONTENT_OPACITY = 0.35;

/** CSS backdrop blur radius for the web build's true glass effect. */
const GLASS_BLUR_PX = 3;

/**
 * Web-only true glass: blur whatever sits beneath the pill. Native ignores
 * the property, so it is attached only on web (typed via a narrowing cast —
 * ``backdropFilter`` is a react-native-web CSS passthrough absent from RN's
 * ``ViewStyle``).
 */
const WEB_GLASS_STYLE: ViewStyle | null =
  Platform.OS === 'web'
    ? ({
        backdropFilter: `blur(${GLASS_BLUR_PX}px)`,
        WebkitBackdropFilter: `blur(${GLASS_BLUR_PX}px)`,
      } as unknown as ViewStyle)
    : null;

export interface MagnifierLensProps {
  /** Measured grid width in pixels. */
  gridWidth: number;
  /** Measured grid height in pixels. */
  gridHeight: number;
  /** Measured per-stage vertical centers; missing stages use nominal bands. */
  anchors: StageAnchors;
  /** The stage the lens is focused on (its resting point). */
  focusedStage: number;
  /** The user's live stage — earns the YOU ARE HERE chip when under glass. */
  currentStage: number | null;
  /** A drag released over a new stage settles focus there. */
  onSettleStage: (_stageNumber: number) => void;
  /** A tap on the lens opens the focused stage's detail modal. */
  onOpenStage: (_stageNumber: number) => void;
}

/** The lens's animated machinery: its center, frost, and glide driver. */
interface LensMotion {
  center: Animated.ValueXY;
  frost: Animated.Value;
  /** Live mirror of ``center`` for drag math and glide distances. */
  lastCenter: React.MutableRefObject<LensCenter>;
  /** True while a finger owns the lens; the glide effect defers to it. */
  dragging: React.MutableRefObject<boolean>;
  glideTo: (_target: LensCenter, _decelerate?: boolean) => void;
  raiseFrost: () => void;
}

/** One drag's bookkeeping: where the touch and the lens started. */
interface DragOrigin {
  touchX: number;
  touchY: number;
  center: LensCenter;
  lastY: number;
  lastTime: number | null;
  velocityY: number;
}

/** Centers are identical when a parent focus update asks for the glide already in flight. */
const sameLensCenter = (a: LensCenter | null, b: LensCenter): boolean =>
  a !== null && a.x === b.x && a.y === b.y;

/** A tap or focus change starts from rest, so its glide eases in and out — gather, glide, slow. */
const FOCUS_EASING = Easing.inOut(Easing.cubic);

/**
 * A released swipe already carries the finger's speed, so its settle only
 * decelerates: easing *out* keeps that momentum and slides to a slowing stop,
 * never braking to zero and re-accelerating (the jerk of an ease-in restart).
 */
const SETTLE_EASING = Easing.out(Easing.cubic);

const runGlide = (
  center: Animated.ValueXY,
  frost: Animated.Value,
  target: LensCenter,
  distance: number,
  easing: (_value: number) => number,
  onDone: () => void,
): void => {
  Animated.timing(center, {
    toValue: target,
    duration: glideDurationMs(distance),
    easing,
    useNativeDriver: false,
  }).start(({ finished }) => {
    if (finished) {
      Animated.timing(frost, {
        toValue: 0,
        duration: FROST_OUT_MS,
        useNativeDriver: false,
      }).start();
    }
    onDone();
  });
};

/**
 * Own the lens's animated center + frost. Follows ``focusedStage`` (stage
 * taps, anchor re-measures) with a glide — gather speed, glide, slide to a
 * slowing stop — unless a drag holds the lens, and repositions instantly
 * under reduced motion.
 */
const useLensMotion = (
  focusedStage: number,
  restingCenter: (_stageNumber: number) => LensCenter,
  reducedMotion: boolean,
  onFocusFollowed: (_stageNumber: number) => void,
): LensMotion => {
  const centerRef = useRef<Animated.ValueXY | null>(null);
  const lastCenter = useRef<LensCenter>({ x: 0, y: 0 });
  if (centerRef.current === null) {
    lastCenter.current = restingCenter(focusedStage);
    centerRef.current = new Animated.ValueXY(lastCenter.current);
  }
  const center = centerRef.current;
  const frost = useRef(new Animated.Value(0)).current;
  const dragging = useRef(false);
  const activeGlideTarget = useRef<LensCenter | null>(null);

  useEffect(() => {
    const id = center.addListener((value) => {
      lastCenter.current = value;
    });
    return () => center.removeListener(id);
  }, [center]);

  const raiseFrost = useCallback(() => {
    Animated.timing(frost, { toValue: 1, duration: FROST_IN_MS, useNativeDriver: false }).start();
  }, [frost]);

  const glideTo = useCallback(
    (target: LensCenter, decelerate = false) => {
      if (sameLensCenter(activeGlideTarget.current, target)) return;

      if (reducedMotion) {
        activeGlideTarget.current = null;
        center.setValue(target);
        frost.setValue(0);
        return;
      }
      activeGlideTarget.current = target;
      const distance = Math.hypot(target.x - lastCenter.current.x, target.y - lastCenter.current.y);
      raiseFrost();
      runGlide(center, frost, target, distance, decelerate ? SETTLE_EASING : FOCUS_EASING, () => {
        activeGlideTarget.current = null;
      });
    },
    [center, frost, raiseFrost, reducedMotion],
  );

  useEffect(() => {
    onFocusFollowed(focusedStage);
    if (dragging.current) return;
    glideTo(restingCenter(focusedStage));
  }, [focusedStage, glideTo, onFocusFollowed, restingCenter]);

  return { center, frost, lastCenter, dragging, glideTo, raiseFrost };
};

/** Everything the drag handlers need beyond the motion machinery itself. */
interface LensDragParams {
  motion: LensMotion;
  frame: LensFrame;
  gridWidth: number;
  gridHeight: number;
  anchors: StageAnchors;
  reducedMotion: boolean;
  /** A stage's clamped resting center (shared with the glide effect). */
  restingCenter: (_stageNumber: number) => LensCenter;
  focusedStage: number;
  hoverStage: number;
  onHoverStage: (_stageNumber: number) => void;
  onSettleStage: (_stageNumber: number) => void;
  onOpenStage: (_stageNumber: number) => void;
}

/** The responder props implementing drag-to-explore + tap-to-open. */
interface LensDragHandlers {
  onStartShouldSetResponder: () => boolean;
  onResponderTerminationRequest: () => boolean;
  onResponderGrant: (_event: GestureResponderEvent) => void;
  onResponderMove: (_event: GestureResponderEvent) => void;
  onResponderRelease: (_event: GestureResponderEvent) => void;
  onResponderTerminate: () => void;
}

const newDragOrigin = (event: GestureResponderEvent, center: LensCenter): DragOrigin => ({
  touchX: event.nativeEvent.pageX,
  touchY: event.nativeEvent.pageY,
  center: { ...center },
  lastY: center.y,
  lastTime: event.nativeEvent.timestamp ?? null,
  velocityY: 0,
});

const rememberVerticalVelocity = (
  origin: React.MutableRefObject<DragOrigin>,
  nextY: number,
  eventTime: number | undefined,
): void => {
  if (typeof eventTime === 'number' && origin.current.lastTime !== null) {
    const dt = eventTime - origin.current.lastTime;
    if (dt > 0) origin.current.velocityY = (nextY - origin.current.lastY) / dt;
    origin.current.lastTime = eventTime;
  }
  origin.current.lastY = nextY;
};

const settleStageWithMomentum = (
  centerY: number,
  velocityY: number,
  gridHeight: number,
  anchors: StageAnchors,
): number => inertialStageTarget(centerY, velocityY, gridHeight, anchors);

const dragCenterOnRail = (
  event: GestureResponderEvent,
  origin: DragOrigin,
  frame: LensFrame,
  gridWidth: number,
  gridHeight: number,
): LensCenter =>
  clampLensCenter(
    { x: origin.center.x, y: origin.center.y + event.nativeEvent.pageY - origin.touchY },
    frame,
    gridWidth,
    gridHeight,
  );

const settleDraggedLens = (params: LensDragParams, dragOrigin: DragOrigin): void => {
  const { motion, gridHeight, anchors } = params;
  motion.dragging.current = false;
  const settled = settleStageWithMomentum(
    motion.lastCenter.current.y,
    dragOrigin.velocityY,
    gridHeight,
    anchors,
  );
  motion.glideTo(params.restingCenter(settled), true);
  if (settled !== params.focusedStage) params.onSettleStage(settled);
};

/**
 * Drag the lens with a plain responder: releases within ``DRAG_TAP_SLOP`` are
 * taps (open the stage); real drags track the finger, re-caption the stage
 * under the glass live, and snap to the nearest stage on release.
 */
const useLensDrag = (params: LensDragParams): LensDragHandlers => {
  const { motion, frame, gridWidth, gridHeight, anchors } = params;
  const dragOrigin = useRef<DragOrigin>({
    touchX: 0,
    touchY: 0,
    center: { x: 0, y: 0 },
    lastY: 0,
    lastTime: null,
    velocityY: 0,
  });

  const handleMove = (event: GestureResponderEvent): void => {
    const dx = event.nativeEvent.pageX - dragOrigin.current.touchX;
    const dy = event.nativeEvent.pageY - dragOrigin.current.touchY;
    const eventTime = event.nativeEvent.timestamp;
    if (!motion.dragging.current) {
      if (Math.hypot(dx, dy) < DRAG_TAP_SLOP) return;
      motion.dragging.current = true;
      if (!params.reducedMotion) motion.raiseFrost();
    }
    const next = dragCenterOnRail(event, dragOrigin.current, frame, gridWidth, gridHeight);
    rememberVerticalVelocity(dragOrigin, next.y, eventTime);
    motion.center.setValue(next);
    params.onHoverStage(nearestStage(next.y, gridHeight, anchors));
  };

  const settleDrag = (): void => settleDraggedLens(params, dragOrigin.current);

  return {
    onStartShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
    onResponderGrant: (event) => {
      motion.dragging.current = false;
      motion.center.stopAnimation((value: LensCenter) => {
        motion.lastCenter.current = value;
      });
      dragOrigin.current = newDragOrigin(event, motion.lastCenter.current);
    },
    onResponderMove: handleMove,
    onResponderRelease: () => {
      if (motion.dragging.current) {
        settleDrag();
        return;
      }
      params.onOpenStage(params.hoverStage);
    },
    onResponderTerminate: settleDrag,
  };
};

/**
 * Animated style keeping the magnified full-size wave copy locked under the
 * moving glass: the grid point at the lens center always renders at the
 * pill's own center (see ``magnifierTransform`` for the derivation).
 */
const magnifiedContentStyle = (
  center: Animated.ValueXY,
  frost: Animated.Value,
  frame: LensFrame,
  gridWidth: number,
  gridHeight: number,
) => {
  const t = magnifierTransform(frame, gridWidth, gridHeight);
  const negativeScale = new Animated.Value(-t.magnification);
  return {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    width: gridWidth,
    height: gridHeight,
    opacity: frost.interpolate({
      inputRange: [0, 1],
      outputRange: [1, MOTION_CONTENT_OPACITY],
    }),
    transform: [
      {
        translateX: Animated.add(
          new Animated.Value(t.kx),
          Animated.multiply(center.x, negativeScale),
        ),
      },
      {
        translateY: Animated.add(
          new Animated.Value(t.ky),
          Animated.multiply(center.y, negativeScale),
        ),
      },
      { scale: MAGNIFICATION },
    ],
  };
};

/** The magnified wave copy + frost wash, clipped to the pill. */
const LensGlass = ({
  motion,
  frame,
  gridWidth,
  gridHeight,
  anchors,
}: {
  motion: LensMotion;
  frame: LensFrame;
  gridWidth: number;
  gridHeight: number;
  anchors: StageAnchors;
}): React.JSX.Element => {
  const contentStyle = useMemo(
    () => magnifiedContentStyle(motion.center, motion.frost, frame, gridWidth, gridHeight),
    [motion.center, motion.frost, frame, gridWidth, gridHeight],
  );

  return (
    <View style={[styles.magnifierClip, { borderRadius: frame.radius }]} pointerEvents="none">
      <Animated.View style={contentStyle}>
        <WaveOverlay
          width={gridWidth}
          height={gridHeight}
          anchors={anchors}
          idPrefix="magnifier-"
        />
      </Animated.View>
      <Animated.View
        testID="magnifier-frost"
        style={[styles.magnifierFrost, { opacity: motion.frost }]}
      />
    </View>
  );
};

/** Chip + caption block for the stage currently under the glass. */
const LensCaptionBlock = ({
  stageNumber,
  isCurrent,
}: {
  stageNumber: number;
  isCurrent: boolean;
}): React.JSX.Element => {
  const caption = lensCaption(stageNumber);
  return (
    <View style={styles.magnifierCaption} pointerEvents="none">
      {isCurrent ? (
        <View style={styles.youAreHere} testID="you-are-here">
          <Text style={styles.youAreHereText}>YOU ARE HERE</Text>
        </View>
      ) : null}
      <Text style={styles.magnifierHeadline} testID="magnifier-headline" numberOfLines={1}>
        {caption.headline}
      </Text>
      <Text style={styles.magnifierDetail} testID="magnifier-detail" numberOfLines={1}>
        {caption.detail}
      </Text>
    </View>
  );
};

/** Accessibility read for the lens: where it is and what it can do. */
const lensAccessibilityLabel = (stageNumber: number, isCurrent: boolean): string => {
  const caption = lensCaption(stageNumber);
  const prefix = isCurrent ? 'You are here. ' : '';
  return (
    `${prefix}Magnifier over ${caption.headline} — ${caption.detail}. ` +
    'Tap to read about this stage; drag to explore others.'
  );
};

/** The pill shell: glass styling, center-driven position, drag + a11y wiring. */
const LensShell = ({
  frame,
  motion,
  handlers,
  label,
  children,
}: {
  frame: LensFrame;
  motion: LensMotion;
  handlers: LensDragHandlers;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element => (
  <Animated.View
    testID="map-magnifier"
    style={[
      styles.magnifier,
      WEB_GLASS_STYLE,
      {
        width: frame.width,
        height: frame.height,
        borderRadius: frame.radius,
        transform: [
          { translateX: Animated.subtract(motion.center.x, new Animated.Value(frame.width / 2)) },
          { translateY: Animated.subtract(motion.center.y, new Animated.Value(frame.height / 2)) },
        ],
      },
    ]}
    {...handlers}
    accessible
    accessibilityRole="button"
    accessibilityLabel={label}
  >
    {children}
  </Animated.View>
);

export const MagnifierLens = (props: MagnifierLensProps): React.JSX.Element => {
  const { gridWidth, gridHeight, anchors, focusedStage, currentStage } = props;
  const reducedMotion = useReducedMotion();
  const frame = useMemo(() => lensFrame(gridWidth, gridHeight), [gridWidth, gridHeight]);
  const [hoverStage, setHoverStage] = useState(focusedStage);

  const restingCenter = useCallback(
    (stageNumber: number): LensCenter =>
      clampLensCenter(
        lensCenterForStage(stageNumber, gridWidth, gridHeight, anchors),
        frame,
        gridWidth,
        gridHeight,
      ),
    [anchors, frame, gridWidth, gridHeight],
  );

  const motion = useLensMotion(focusedStage, restingCenter, reducedMotion, setHoverStage);
  const dragHandlers = useLensDrag({
    motion,
    frame,
    gridWidth,
    gridHeight,
    anchors,
    reducedMotion,
    restingCenter,
    focusedStage,
    hoverStage,
    onHoverStage: setHoverStage,
    onSettleStage: props.onSettleStage,
    onOpenStage: props.onOpenStage,
  });

  const isCurrent = hoverStage === currentStage;
  return (
    <LensShell
      frame={frame}
      motion={motion}
      handlers={dragHandlers}
      label={lensAccessibilityLabel(hoverStage, isCurrent)}
    >
      <LensGlass
        motion={motion}
        frame={frame}
        gridWidth={gridWidth}
        gridHeight={gridHeight}
        anchors={anchors}
      />
      <LensCaptionBlock stageNumber={hoverStage} isCurrent={isCurrent} />
    </LensShell>
  );
};

export default MagnifierLens;
