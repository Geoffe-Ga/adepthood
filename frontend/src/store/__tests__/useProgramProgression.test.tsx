import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { useDerivedCurrentStage, useDerivedCurrentWeek } from '../useProgramProgression';
import { useProgramStore } from '../useProgramStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const Probe = ({
  today,
  fallbackStage,
  fallbackWeek,
}: {
  today: Date;
  fallbackStage: number;
  fallbackWeek: number;
}) => {
  const stage = useDerivedCurrentStage(fallbackStage, today);
  const week = useDerivedCurrentWeek(fallbackWeek, today);
  return (
    <>
      <Text testID="stage">{stage}</Text>
      <Text testID="week">{week}</Text>
    </>
  );
};

beforeEach(() => {
  act(() => useProgramStore.getState().hydrateProgramStartDate(null));
});

describe('useDerivedCurrentStage / useDerivedCurrentWeek', () => {
  it('returns the fallback when no anchor is set', () => {
    const result = render(
      <Probe today={new Date(2026, 4, 12)} fallbackStage={3} fallbackWeek={9} />,
    );
    expect(result.getByTestId('stage').props.children).toBe(3);
    expect(result.getByTestId('week').props.children).toBe(9);
  });

  it('returns date-derived stage/week when the anchor is set', () => {
    act(() => useProgramStore.getState().setProgramStartDate(new Date(2026, 0, 1)));
    // Day 22 → Stage 2 (21-day stage 1 elapsed), Week 4.
    const result = render(
      <Probe today={new Date(2026, 0, 23)} fallbackStage={1} fallbackWeek={1} />,
    );
    expect(result.getByTestId('stage').props.children).toBe(2);
    expect(result.getByTestId('week').props.children).toBe(4);
  });

  it('reacts when the anchor changes', () => {
    const Wrapped = () => <Probe today={new Date(2026, 5, 1)} fallbackStage={1} fallbackWeek={1} />;
    const result = render(<Wrapped />);
    expect(result.getByTestId('stage').props.children).toBe(1);

    act(() => useProgramStore.getState().setProgramStartDate(new Date(2026, 0, 1)));
    // June 1, 2026 - Jan 1, 2026 = ~151 days → Stage 8.
    expect(result.getByTestId('stage').props.children).toBe(8);
  });
});
