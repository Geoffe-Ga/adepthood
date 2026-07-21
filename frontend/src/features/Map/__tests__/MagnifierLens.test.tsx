/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import React from 'react';
import { Animated } from 'react-native';
import { act, create } from 'react-test-renderer';

import { lensCenterForStage, lensFrame } from '../magnifierGeometry';
import type { LensCaption } from '../magnifierGeometry';
import MagnifierLens from '../MagnifierLens';
import { stageWavePoint } from '../waveGeometry';

// A deterministic per-stage caption stand-in for the store-fed lookup: even
// stages read Divine Feminine, odd stages Divine Masculine, and every stage
// carries a distinct free-will sentence so a test can prove the lens re-captions
// to the stage under the glass.
const captionForStage = (stageNumber: number): LensCaption => ({
  polarity: stageNumber % 2 === 0 ? 'Divine Feminine' : 'Divine Masculine',
  freeWill: `Free-will read for stage ${stageNumber}.`,
});

// Mutable reduced-motion knob: default true so lens repositioning is instant
// and deterministic; individual tests flip it to exercise the glide path.
const reducedMotionState = { value: true };
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => reducedMotionState.value,
}));

const GRID_WIDTH = 300;
const GRID_HEIGHT = 600;

interface RenderOptions {
  focusedStage?: number;
  currentStage?: number;
  anchors?: Record<number, number>;
  onSettleStage?: jest.Mock;
  onOpenStage?: jest.Mock;
}

const renderLens = (options: RenderOptions = {}) => {
  const onSettleStage = options.onSettleStage ?? jest.fn();
  const onOpenStage = options.onOpenStage ?? jest.fn();
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <MagnifierLens
        gridWidth={GRID_WIDTH}
        gridHeight={GRID_HEIGHT}
        anchors={options.anchors ?? {}}
        focusedStage={options.focusedStage ?? 1}
        currentStage={options.currentStage ?? 1}
        captionForStage={captionForStage}
        onSettleStage={onSettleStage}
        onOpenStage={onOpenStage}
      />,
    );
  });
  return { tree, onSettleStage, onOpenStage };
};

const lensNode = (tree: ReturnType<typeof create>) =>
  tree.root.findByProps({ testID: 'map-magnifier' });

const freeWillText = (tree: ReturnType<typeof create>): string =>
  tree.root.findByProps({ testID: 'magnifier-freewill' }).props.children as string;

const textByTestId = (tree: ReturnType<typeof create>, testID: string) =>
  tree.root.findByProps({ testID });

/** Synthetic responder touch event at a page position. */
const touch = (pageX: number, pageY: number, timestamp = 0) => ({
  nativeEvent: { pageX, pageY, timestamp },
});

/** A settle/glide `Animated.timing` config: an easing curve over an XY target. */
interface CenterGlideConfig {
  toValue: { x: number; y: number };
  easing: (_t: number) => number;
}

/** Pull the center-driving `Animated.timing` configs (XY toValue) from a spy. */
const centerGlideConfigs = (timing: jest.SpyInstance): CenterGlideConfig[] =>
  timing.mock.calls
    .map(([, config]) => config as CenterGlideConfig)
    .filter(
      (config) =>
        typeof config?.toValue === 'object' &&
        config.toValue !== null &&
        'x' in config.toValue &&
        'y' in config.toValue,
    );

/** The single center glide a settle/focus change is expected to start. */
const soleCenterGlide = (timing: jest.SpyInstance): CenterGlideConfig => {
  const [glide, ...rest] = centerGlideConfigs(timing);
  expect(rest).toHaveLength(0);
  if (!glide) throw new Error('expected exactly one center glide');
  return glide;
};

/**
 * Count the frost-wash raises a spy saw. The frost-in animation is the only
 * `Animated.timing` with a scalar `toValue: 1`; center glides target an XY
 * object and the frost clear targets `0`.
 */
const frostRaiseCount = (timing: jest.SpyInstance): number =>
  timing.mock.calls.filter(([, config]) => (config as { toValue?: unknown }).toValue === 1).length;

/** Drive a full grant → move → release drag on the lens. */
const drag = (
  tree: ReturnType<typeof create>,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void => {
  const lens = lensNode(tree);
  act(() => {
    lens.props.onResponderGrant(touch(from.x, from.y));
    lens.props.onResponderMove(touch(to.x, to.y));
    lens.props.onResponderRelease(touch(to.x, to.y));
  });
};

describe('MagnifierLens', () => {
  beforeEach(() => {
    reducedMotionState.value = true;
  });

  it('shows the YOU ARE HERE chip when resting on the current stage', () => {
    const { tree } = renderLens({ focusedStage: 1, currentStage: 1 });
    expect(tree.root.findByProps({ testID: 'you-are-here' })).toBeTruthy();
  });

  it('hides the chip when focused away from the current stage', () => {
    const { tree } = renderLens({ focusedStage: 3, currentStage: 1 });
    expect(
      tree.root.findAll(
        (n: { props: Record<string, unknown> }) => n.props.testID === 'you-are-here',
      ),
    ).toHaveLength(0);
  });

  it('captions the focused stage with only its polarity and free-will read', () => {
    const { tree } = renderLens({ focusedStage: 4 });
    const polarity = textByTestId(tree, 'magnifier-polarity');
    expect(polarity.props.children).toBe('Divine Feminine');
    expect(polarity.props.numberOfLines).toBe(1);
    const freeWill = textByTestId(tree, 'magnifier-freewill');
    expect(freeWill.props.children).toBe('Free-will read for stage 4.');
    expect(freeWill.props.numberOfLines).toBe(2);
  });

  it('drops the eyebrow, headline, detail, and practice lines from the pill', () => {
    const { tree } = renderLens({ focusedStage: 4 });
    for (const testID of [
      'magnifier-eyebrow',
      'magnifier-headline',
      'magnifier-detail',
      'magnifier-practice',
    ]) {
      expect(
        tree.root.findAll((n: { props: Record<string, unknown> }) => n.props.testID === testID),
      ).toHaveLength(0);
    }
  });

  it('re-captions when the focused stage prop changes (stage tap glide)', () => {
    const { tree } = renderLens({ focusedStage: 1 });
    act(() => {
      tree.update(
        <MagnifierLens
          gridWidth={GRID_WIDTH}
          gridHeight={GRID_HEIGHT}
          anchors={{}}
          focusedStage={5}
          currentStage={1}
          captionForStage={captionForStage}
          onSettleStage={jest.fn()}
          onOpenStage={jest.fn()}
        />,
      );
    });
    expect(freeWillText(tree)).toBe('Free-will read for stage 5.');
    expect(textByTestId(tree, 'magnifier-polarity').props.children).toBe('Divine Masculine');
  });

  it('renders a magnified copy of the wave under the glass', () => {
    const { tree } = renderLens();
    expect(tree.root.findByProps({ testID: 'magnifier-map-wave' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'magnifier-wave-arrow-1' })).toBeTruthy();
  });

  it('treats a sub-slop release as a tap and opens the focused stage', () => {
    const { tree, onOpenStage, onSettleStage } = renderLens({ focusedStage: 4 });
    const lens = lensNode(tree);
    act(() => {
      lens.props.onResponderGrant(touch(150, 400));
      lens.props.onResponderMove(touch(152, 401)); // under DRAG_TAP_SLOP
      lens.props.onResponderRelease(touch(152, 401));
    });
    expect(onOpenStage).toHaveBeenCalledWith(4);
    expect(onSettleStage).not.toHaveBeenCalled();
  });

  it('claims the responder on touch start and refuses termination', () => {
    const { tree } = renderLens();
    const lens = lensNode(tree);
    expect(lens.props.onStartShouldSetResponder()).toBe(true);
    expect(lens.props.onResponderTerminationRequest()).toBe(false);
  });

  it('locks horizontal dragging to the center-column rail', () => {
    const { tree } = renderLens({ focusedStage: 1 });
    const lens = lensNode(tree);
    const start = lensCenterForStage(1, GRID_WIDTH, GRID_HEIGHT);
    const stage2Y = stageWavePoint(2).y * GRID_HEIGHT;
    act(() => {
      lens.props.onResponderGrant(touch(150, start.y, 0));
      lens.props.onResponderMove(touch(260, stage2Y, 100));
    });
    const style = lensNode(tree).props.style[2];
    expect(style.transform[0].translateX.__getValue()).toBeCloseTo(
      start.x - lensFrame(GRID_WIDTH, GRID_HEIGHT).width / 2,
    );
    expect(freeWillText(tree)).toBe('Free-will read for stage 2.');
  });

  it('uses release velocity to coast a fast swipe farther than the finger position', () => {
    const { tree, onSettleStage } = renderLens({ focusedStage: 1 });
    const lens = lensNode(tree);
    const start = lensCenterForStage(1, GRID_WIDTH, GRID_HEIGHT);
    const stage3Y = stageWavePoint(3).y * GRID_HEIGHT;
    act(() => {
      lens.props.onResponderGrant(touch(150, start.y, 0));
      lens.props.onResponderMove(touch(150, stage3Y + 28, 80));
      lens.props.onResponderMove(touch(150, stage3Y, 100));
      lens.props.onResponderRelease(touch(150, stage3Y, 100));
    });
    expect(onSettleStage).toHaveBeenCalledWith(6);
  });

  it('drag past the slop settles on the nearest stage instead of tapping', () => {
    const { tree, onOpenStage, onSettleStage } = renderLens({ focusedStage: 1 });
    // Stage 1 rests at y=570; stage 3's nominal anchor is 0.75 → 450.
    const start = lensCenterForStage(1, GRID_WIDTH, GRID_HEIGHT);
    const targetY = stageWavePoint(3).y * GRID_HEIGHT;
    drag(tree, { x: 150, y: start.y }, { x: 150, y: start.y - (start.y - targetY) });
    expect(onSettleStage).toHaveBeenCalledWith(3);
    expect(onOpenStage).not.toHaveBeenCalled();
  });

  it('updates the caption live while dragging over other stages', () => {
    const { tree } = renderLens({ focusedStage: 1 });
    const lens = lensNode(tree);
    const start = lensCenterForStage(1, GRID_WIDTH, GRID_HEIGHT);
    const stage2Y = stageWavePoint(2).y * GRID_HEIGHT;
    act(() => {
      lens.props.onResponderGrant(touch(150, start.y));
      lens.props.onResponderMove(touch(150, start.y - (start.y - stage2Y)));
    });
    expect(freeWillText(tree)).toBe('Free-will read for stage 2.');
  });

  it('a drag released back on the focused stage settles without reporting', () => {
    const { tree, onSettleStage } = renderLens({ focusedStage: 1 });
    const start = lensCenterForStage(1, GRID_WIDTH, GRID_HEIGHT);
    // Move well past the slop but stay nearest to stage 1.
    drag(tree, { x: 150, y: start.y }, { x: 150, y: start.y - 12 });
    expect(onSettleStage).not.toHaveBeenCalled();
  });

  it('responder termination settles the drag like a release', () => {
    const { tree, onSettleStage } = renderLens({ focusedStage: 1 });
    const lens = lensNode(tree);
    const start = lensCenterForStage(1, GRID_WIDTH, GRID_HEIGHT);
    const stage2Y = stageWavePoint(2).y * GRID_HEIGHT;
    act(() => {
      lens.props.onResponderGrant(touch(150, start.y));
      lens.props.onResponderMove(touch(150, start.y - (start.y - stage2Y)));
      lens.props.onResponderTerminate();
    });
    expect(onSettleStage).toHaveBeenCalledWith(2);
  });

  it('exposes a button role with a label that identifies the stage and reads both new facts', () => {
    const { tree } = renderLens({ focusedStage: 1, currentStage: 1 });
    const lens = lensNode(tree);
    expect(lens.props.accessibilityRole).toBe('button');
    expect(lens.props.accessibilityLabel).toContain('You are here');
    // Identity the visible pill now sheds stays in the spoken label.
    expect(lens.props.accessibilityLabel).toContain('Agency');
    expect(lens.props.accessibilityLabel).toContain('1 · BEIGE');
    // Both new facts are read aloud.
    expect(lens.props.accessibilityLabel).toContain('Divine Masculine');
    expect(lens.props.accessibilityLabel).toContain('Free-will read for stage 1.');
    expect(lens.props.accessibilityLabel).toContain('drag to explore');
  });

  it('glides with animation when reduced motion is off', () => {
    reducedMotionState.value = false;
    jest.useFakeTimers();
    const timing = jest.spyOn(Animated, 'timing');
    try {
      const { tree } = renderLens({ focusedStage: 1 });
      act(() => {
        jest.advanceTimersByTime(2000); // let the mount glide finish
      });
      timing.mockClear();
      act(() => {
        tree.update(
          <MagnifierLens
            gridWidth={GRID_WIDTH}
            gridHeight={GRID_HEIGHT}
            anchors={{}}
            focusedStage={8}
            currentStage={1}
            captionForStage={captionForStage}
            onSettleStage={jest.fn()}
            onOpenStage={jest.fn()}
          />,
        );
      });
      // Caption follows immediately; the glide raises the frost wash as it starts.
      expect(freeWillText(tree)).toBe('Free-will read for stage 8.');
      expect(frostRaiseCount(timing)).toBe(1);
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });

  it('starts one uninterrupted settling glide after a swipe changes stages', () => {
    reducedMotionState.value = false;
    jest.useFakeTimers();
    const timing = jest.spyOn(Animated, 'timing');

    const Harness = (): React.JSX.Element => {
      const [focusedStage, setFocusedStage] = React.useState(1);
      return (
        <MagnifierLens
          gridWidth={GRID_WIDTH}
          gridHeight={GRID_HEIGHT}
          anchors={{}}
          focusedStage={focusedStage}
          currentStage={1}
          captionForStage={captionForStage}
          onSettleStage={setFocusedStage}
          onOpenStage={jest.fn()}
        />
      );
    };

    try {
      let tree!: ReturnType<typeof create>;
      act(() => {
        tree = create(<Harness />);
        jest.advanceTimersByTime(2000); // let the mount glide finish
      });
      timing.mockClear();

      const lens = lensNode(tree);
      const start = lensCenterForStage(1, GRID_WIDTH, GRID_HEIGHT);
      const stage3Y = stageWavePoint(3).y * GRID_HEIGHT;
      act(() => {
        lens.props.onResponderGrant(touch(150, start.y, 0));
        lens.props.onResponderMove(touch(150, stage3Y, 100));
        lens.props.onResponderRelease(touch(150, stage3Y, 100));
      });

      const centerGlides = timing.mock.calls.filter(([, config]) => {
        const toValue = (config as { toValue?: unknown }).toValue;
        return typeof toValue === 'object' && toValue !== null && 'x' in toValue && 'y' in toValue;
      });
      expect(centerGlides).toHaveLength(1);
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });

  it('raises the frost while a drag is live when reduced motion is off', () => {
    reducedMotionState.value = false;
    jest.useFakeTimers();
    const timing = jest.spyOn(Animated, 'timing');
    try {
      const { tree, onSettleStage } = renderLens({ focusedStage: 1 });
      act(() => {
        jest.advanceTimersByTime(2000); // let the mount glide finish
      });
      timing.mockClear();
      const lens = lensNode(tree);
      const start = lensCenterForStage(1, GRID_WIDTH, GRID_HEIGHT);
      const stage3Y = stageWavePoint(3).y * GRID_HEIGHT;
      act(() => {
        lens.props.onResponderGrant(touch(150, start.y));
        lens.props.onResponderMove(touch(150, stage3Y));
      });
      // A live drag raises the frost wash before any release-settle glide begins.
      expect(frostRaiseCount(timing)).toBe(1);
      act(() => {
        lens.props.onResponderRelease(touch(150, stage3Y));
        jest.advanceTimersByTime(2000);
      });
      expect(onSettleStage).toHaveBeenCalledWith(3);
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });

  it('coasts to a stop after a fast swipe: the settle decelerates, never restarting from rest', () => {
    reducedMotionState.value = false;
    jest.useFakeTimers();
    const timing = jest.spyOn(Animated, 'timing');
    try {
      const { tree } = renderLens({ focusedStage: 1 });
      act(() => {
        jest.advanceTimersByTime(2000); // let the mount glide finish
      });
      timing.mockClear();

      const lens = lensNode(tree);
      const start = lensCenterForStage(1, GRID_WIDTH, GRID_HEIGHT);
      const stage3Y = stageWavePoint(3).y * GRID_HEIGHT;
      act(() => {
        lens.props.onResponderGrant(touch(150, start.y, 0));
        lens.props.onResponderMove(touch(150, stage3Y + 28, 80));
        lens.props.onResponderMove(touch(150, stage3Y, 100));
        lens.props.onResponderRelease(touch(150, stage3Y, 100));
      });

      const settle = soleCenterGlide(timing);
      // Ease-out spends most of its travel early, then slows to the stage: the
      // lens keeps the finger's speed and decelerates. An ease-in-out settle
      // would sit near zero here (a dead stop before re-accelerating) — the jerk.
      expect(settle.easing(0.1)).toBeGreaterThan(0.2);
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });

  it('locks exactly on a stage after a swipe: the settle target is that stage anchor', () => {
    reducedMotionState.value = false;
    jest.useFakeTimers();
    const timing = jest.spyOn(Animated, 'timing');
    try {
      const { tree, onSettleStage } = renderLens({ focusedStage: 1 });
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      timing.mockClear();

      const lens = lensNode(tree);
      const start = lensCenterForStage(1, GRID_WIDTH, GRID_HEIGHT);
      const stage3Y = stageWavePoint(3).y * GRID_HEIGHT;
      act(() => {
        lens.props.onResponderGrant(touch(150, start.y, 0));
        lens.props.onResponderMove(touch(150, stage3Y + 28, 80));
        lens.props.onResponderMove(touch(150, stage3Y, 100));
        lens.props.onResponderRelease(touch(150, stage3Y, 100));
      });

      expect(onSettleStage).toHaveBeenCalledWith(6);
      const settle = soleCenterGlide(timing);
      expect(settle.toValue.y).toBeCloseTo(stageWavePoint(6).y * GRID_HEIGHT);
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });

  it('a stage-focus glide still gathers speed from rest (ease-in-out, not a snap)', () => {
    reducedMotionState.value = false;
    jest.useFakeTimers();
    const timing = jest.spyOn(Animated, 'timing');
    try {
      const { tree } = renderLens({ focusedStage: 1 });
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      timing.mockClear();

      act(() => {
        tree.update(
          <MagnifierLens
            gridWidth={GRID_WIDTH}
            gridHeight={GRID_HEIGHT}
            anchors={{}}
            focusedStage={6}
            currentStage={1}
            captionForStage={captionForStage}
            onSettleStage={jest.fn()}
            onOpenStage={jest.fn()}
          />,
        );
      });

      const glide = soleCenterGlide(timing);
      // A tap/focus change starts from a standstill, so it must ease in — near
      // zero early travel — rather than lurching off at full speed.
      expect(glide.easing(0.1)).toBeLessThan(0.05);
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });
});
