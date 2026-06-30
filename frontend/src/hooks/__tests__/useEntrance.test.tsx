/* eslint-env jest */
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { Animated } from 'react-native';

import { useEntrance } from '@/hooks/useEntrance';
import * as reducedMotion from '@/hooks/useReducedMotion';

function Probe({ index }: { index?: number }): React.JSX.Element {
  const style = useEntrance(index);
  return <Animated.View testID="probe" style={style} />;
}

describe('useEntrance', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('schedules a fade/settle entrance when motion is allowed', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(false);
    const timing = jest.spyOn(Animated, 'timing');
    render(<Probe />);
    expect(timing).toHaveBeenCalledTimes(1);
  });

  it('schedules no animation under reduced motion', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(true);
    const timing = jest.spyOn(Animated, 'timing');
    render(<Probe />);
    expect(timing).not.toHaveBeenCalled();
  });

  it('exposes an opacity + translateY transform style', () => {
    const { getByTestId } = render(<Probe />);
    const style = getByTestId('probe').props.style;
    expect(style.opacity).toBeDefined();
    expect(style.transform[0].translateY).toBeDefined();
  });
});
