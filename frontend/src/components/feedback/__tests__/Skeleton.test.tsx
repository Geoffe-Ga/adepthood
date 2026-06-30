/* eslint-env jest */
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { Animated, StyleSheet } from 'react-native';

import { Skeleton, SkeletonCard } from '@/components/feedback/Skeleton';
import * as reducedMotion from '@/hooks/useReducedMotion';

const STATIC_OPACITY = 0.4;

describe('Skeleton', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs a shimmer loop when motion is allowed', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(false);
    const loop = jest.spyOn(Animated, 'loop');
    const { getByTestId } = render(<Skeleton />);
    expect(getByTestId('skeleton')).toBeTruthy();
    expect(loop).toHaveBeenCalledTimes(1);
  });

  it('omits the shimmer loop under reduced motion (static block)', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(true);
    const loop = jest.spyOn(Animated, 'loop');
    const { getByTestId } = render(<Skeleton />);
    expect(loop).not.toHaveBeenCalled();
    expect(StyleSheet.flatten(getByTestId('skeleton').props.style).opacity).toBe(STATIC_OPACITY);
  });

  it('SkeletonCard stacks placeholder lines', () => {
    const { getByTestId } = render(<SkeletonCard />);
    expect(getByTestId('skeleton-card')).toBeTruthy();
    expect(getByTestId('skeleton-card-title')).toBeTruthy();
  });
});
