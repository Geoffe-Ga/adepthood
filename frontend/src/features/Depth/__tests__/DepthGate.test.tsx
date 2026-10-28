import { describe, it, expect, afterEach } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { View } from 'react-native';

import DepthGate from '../DepthGate';
import { DEPTH_RINGS, RING_FLAG, type DepthRing } from '../depthRings';

import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

afterEach(() => {
  useDepthPreferencesStore.getState().reset();
});

function renderGated(ring: DepthRing) {
  return render(
    <DepthGate ring={ring}>
      <View testID="gated-child" />
    </DepthGate>,
  );
}

describe('DepthGate', () => {
  it('names exactly the four optional rings, each with its own store flag', () => {
    expect([...DEPTH_RINGS].sort()).toEqual(['course', 'habits', 'practices', 'sangha']);
    expect(RING_FLAG).toEqual({
      habits: 'enable_habits',
      practices: 'enable_practices',
      course: 'enable_course',
      sangha: 'enable_sangha',
    });
  });

  it.each(DEPTH_RINGS)('renders its child while the %s ring is on', (ring) => {
    const { queryByTestId } = renderGated(ring);
    expect(queryByTestId('gated-child')).not.toBeNull();
  });

  it.each(DEPTH_RINGS)('renders nothing once the %s ring is declined', (ring) => {
    useDepthPreferencesStore.setState({ [RING_FLAG[ring]]: false });
    const { queryByTestId } = renderGated(ring);
    expect(queryByTestId('gated-child')).toBeNull();
  });

  it.each(DEPTH_RINGS)('declining another ring never hides the %s child', (ring) => {
    const others = DEPTH_RINGS.filter((other) => other !== ring);
    useDepthPreferencesStore.setState(
      Object.fromEntries(others.map((other) => [RING_FLAG[other], false])),
    );
    const { queryByTestId } = renderGated(ring);
    expect(queryByTestId('gated-child')).not.toBeNull();
  });
});
