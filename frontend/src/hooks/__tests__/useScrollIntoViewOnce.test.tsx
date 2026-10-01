import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo, ScrollView, View } from 'react-native';

import { useScrollIntoViewOnce } from '../useScrollIntoViewOnce';

const TARGET_Y = 640;
const MOVED_Y = 700;

const scrollTo = jest.fn();

function Harness({ active }: { active: boolean }): React.JSX.Element {
  const { scrollRef, onTargetLayout } = useScrollIntoViewOnce(active);
  return (
    <ScrollView ref={scrollRef}>
      <View testID="target" onLayout={onTargetLayout} />
    </ScrollView>
  );
}

/** What React Native hands ``onLayout`` once the target has been laid out at ``y``. */
const layoutAt = (y: number) => ({
  nativeEvent: { layout: { x: 0, y, width: 320, height: 48 } },
});

/** Let the reduced-motion read land. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  scrollTo.mockClear();
  jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(scrollTo);
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useScrollIntoViewOnce', () => {
  it('scrolls to the target once it has been laid out, animated by default', async () => {
    const view = render(<Harness active />);
    await flush();

    fireEvent(view.getByTestId('target'), 'layout', layoutAt(TARGET_Y));

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: TARGET_Y, animated: true });
  });

  it('never scrolls while inactive', async () => {
    const view = render(<Harness active={false} />);
    await flush();

    fireEvent(view.getByTestId('target'), 'layout', layoutAt(TARGET_Y));

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('scrolls once only: a later layout does not pull the screen back', async () => {
    const view = render(<Harness active />);
    await flush();

    fireEvent(view.getByTestId('target'), 'layout', layoutAt(TARGET_Y));
    fireEvent(view.getByTestId('target'), 'layout', layoutAt(MOVED_Y));

    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('jumps rather than glides when the writer has asked for reduced motion', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const view = render(<Harness active />);
    await flush();

    fireEvent(view.getByTestId('target'), 'layout', layoutAt(TARGET_Y));

    expect(scrollTo).toHaveBeenCalledWith({ y: TARGET_Y, animated: false });
  });

  it.each([
    [true, false],
    [false, true],
  ])(
    'waits for the reduce-motion setting (%p) when the layout lands first, then scrolls once',
    async (reduce, animated) => {
      let answer: (_reduce: boolean) => void = () => undefined;
      jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      );
      const view = render(<Harness active />);

      fireEvent(view.getByTestId('target'), 'layout', layoutAt(TARGET_Y));
      expect(scrollTo).not.toHaveBeenCalled();

      await act(async () => {
        answer(reduce);
      });

      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenCalledWith({ y: TARGET_Y, animated });
    },
  );

  it('still scrolls, without animation, when the setting cannot be read', async () => {
    jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockRejectedValue(new Error('unavailable'));
    const view = render(<Harness active />);

    fireEvent(view.getByTestId('target'), 'layout', layoutAt(TARGET_Y));
    await flush();

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: TARGET_Y, animated: false });
  });

  it('scrolls to an already laid-out target when it turns active later, and again after re-arming', async () => {
    const view = render(<Harness active={false} />);
    await flush();
    fireEvent(view.getByTestId('target'), 'layout', layoutAt(TARGET_Y));
    expect(scrollTo).not.toHaveBeenCalled();

    view.rerender(<Harness active />);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: TARGET_Y, animated: true });

    view.rerender(<Harness active={false} />);
    view.rerender(<Harness active />);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});
