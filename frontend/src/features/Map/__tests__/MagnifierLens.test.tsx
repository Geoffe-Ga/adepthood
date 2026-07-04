/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import React from 'react';
import { Animated } from 'react-native';
import { act, create } from 'react-test-renderer';

import { lensCenterForStage, lensFrame } from '../magnifierGeometry';
import MagnifierLens from '../MagnifierLens';
import { stageWavePoint } from '../waveGeometry';

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
        onSettleStage={onSettleStage}
        onOpenStage={onOpenStage}
      />,
    );
  });
  return { tree, onSettleStage, onOpenStage };
};

const lensNode = (tree: ReturnType<typeof create>) =>
  tree.root.findByProps({ testID: 'map-magnifier' });

const headlineText = (tree: ReturnType<typeof create>): string =>
  tree.root.findByProps({ testID: 'magnifier-headline' }).props.children as string;

/** Synthetic responder touch event at a page position. */
const touch = (pageX: number, pageY: number, timestamp = 0) => ({
  nativeEvent: { pageX, pageY, timestamp },
});

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

  it('captions the focused stage with its Aspect word and persona', () => {
    const { tree } = renderLens({ focusedStage: 3 });
    expect(headlineText(tree)).toBe('Self-Love');
    const detail = tree.root.findByProps({ testID: 'magnifier-detail' });
    expect(detail.props.children).toBe('Dominator · Power');
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
          onSettleStage={jest.fn()}
          onOpenStage={jest.fn()}
        />,
      );
    });
    expect(headlineText(tree)).toBe('Intellectual');
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
    expect(headlineText(tree)).toBe('Receptivity');
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
    expect(headlineText(tree)).toBe('Receptivity');
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

  it('exposes a button role with a descriptive label', () => {
    const { tree } = renderLens({ focusedStage: 1, currentStage: 1 });
    const lens = lensNode(tree);
    expect(lens.props.accessibilityRole).toBe('button');
    expect(lens.props.accessibilityLabel).toContain('You are here');
    expect(lens.props.accessibilityLabel).toContain('Agency');
  });

  it('glides with animation when reduced motion is off', () => {
    reducedMotionState.value = false;
    jest.useFakeTimers();
    try {
      const { tree } = renderLens({ focusedStage: 1 });
      act(() => {
        tree.update(
          <MagnifierLens
            gridWidth={GRID_WIDTH}
            gridHeight={GRID_HEIGHT}
            anchors={{}}
            focusedStage={8}
            currentStage={1}
            onSettleStage={jest.fn()}
            onOpenStage={jest.fn()}
          />,
        );
      });
      // Caption follows immediately; the glide itself settles over time.
      expect(headlineText(tree)).toBe('Nondual');
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      expect(tree.root.findByProps({ testID: 'magnifier-frost' })).toBeTruthy();
    } finally {
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
    try {
      const { tree, onSettleStage } = renderLens({ focusedStage: 1 });
      act(() => {
        jest.advanceTimersByTime(2000); // let the mount glide finish
      });
      const lens = lensNode(tree);
      const start = lensCenterForStage(1, GRID_WIDTH, GRID_HEIGHT);
      const stage3Y = stageWavePoint(3).y * GRID_HEIGHT;
      act(() => {
        lens.props.onResponderGrant(touch(150, start.y));
        lens.props.onResponderMove(touch(150, stage3Y));
        lens.props.onResponderRelease(touch(150, stage3Y));
        jest.advanceTimersByTime(2000);
      });
      expect(onSettleStage).toHaveBeenCalledWith(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
