/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

const mockPressIn = jest.fn();
const mockPressOut = jest.fn();
jest.mock('@/hooks/usePressScale', () => ({
  usePressScale: () => ({ scale: 1, onPressIn: mockPressIn, onPressOut: mockPressOut }),
}));

import ReturnArcCard, { RETURN_WEEK_COUNT } from '../ReturnArcCard';

import type { ReturnArc, ReturnWeek } from '@/api';

function week(overrides: Partial<ReturnWeek> = {}): ReturnWeek {
  return {
    week_number: 1,
    focus: 'self',
    title: 'Self',
    framing: 'Begin where you already are.',
    ...overrides,
  };
}

function fiveWeeks(): ReturnWeek[] {
  return [
    week({ week_number: 1, focus: 'self', title: 'Toward yourself', framing: 'Frame one.' }),
    week({
      week_number: 2,
      focus: 'benefactor',
      title: 'Toward a benefactor',
      framing: 'Frame two.',
    }),
    week({
      week_number: 3,
      focus: 'stranger',
      title: 'Toward a stranger',
      framing: 'Frame three.',
    }),
    week({
      week_number: 4,
      focus: 'antagonist',
      title: 'Toward a difficult person',
      framing: 'Frame four.',
    }),
    week({
      week_number: 5,
      focus: 'all_beings',
      title: 'Toward all beings',
      framing: 'Frame five.',
    }),
  ];
}

function arc(overrides: Partial<ReturnArc> = {}): ReturnArc {
  return {
    started_at: '2026-06-24T00:00:00Z',
    paused: false,
    week: 1,
    focus: 'self',
    complete: false,
    ...overrides,
  };
}

const noop = () => undefined;

describe('ReturnArcCard', () => {
  it('week 1 renders the self focus title and framing', () => {
    const { getByText } = render(
      <ReturnArcCard
        weeks={fiveWeeks()}
        arc={arc({ week: 1, focus: 'self' })}
        onPause={noop}
        onResume={noop}
        onLeave={noop}
      />,
    );
    expect(getByText('Toward yourself')).toBeTruthy();
    expect(getByText('Frame one.')).toBeTruthy();
  });

  it('week 3 renders the stranger focus title and framing', () => {
    const { getByText } = render(
      <ReturnArcCard
        weeks={fiveWeeks()}
        arc={arc({ week: 3, focus: 'stranger' })}
        onPause={noop}
        onResume={noop}
        onLeave={noop}
      />,
    );
    expect(getByText('Toward a stranger')).toBeTruthy();
    expect(getByText('Frame three.')).toBeTruthy();
  });

  it('renders 5 week-indicator segments, filling up to the current week', () => {
    const { getByTestId } = render(
      <ReturnArcCard
        weeks={fiveWeeks()}
        arc={arc({ week: 3 })}
        onPause={noop}
        onResume={noop}
        onLeave={noop}
      />,
    );
    expect(RETURN_WEEK_COUNT).toBe(5);
    for (let i = 0; i < RETURN_WEEK_COUNT; i += 1) {
      expect(getByTestId(`return-week-segment-${i}`)).toBeTruthy();
    }
    // Filled segments are 0,1,2 for week 3 (0-indexed, 3 filled of 5).
    expect(getByTestId('return-week-segment-0').props.accessibilityLabel).toBe('completed week');
    expect(getByTestId('return-week-segment-1').props.accessibilityLabel).toBe('completed week');
    expect(getByTestId('return-week-segment-2').props.accessibilityLabel).toBe('completed week');
    expect(getByTestId('return-week-segment-3').props.accessibilityLabel).toBe('remaining week');
    expect(getByTestId('return-week-segment-4').props.accessibilityLabel).toBe('remaining week');
  });

  it('pause press calls onPause exactly once when not paused', () => {
    const onPause = jest.fn();
    const { getByTestId } = render(
      <ReturnArcCard
        weeks={fiveWeeks()}
        arc={arc({ paused: false })}
        onPause={onPause}
        onResume={noop}
        onLeave={noop}
      />,
    );
    fireEvent.press(getByTestId('return-arc-pause'));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('resume press calls onResume exactly once when paused', () => {
    const onResume = jest.fn();
    const { getByTestId } = render(
      <ReturnArcCard
        weeks={fiveWeeks()}
        arc={arc({ paused: true })}
        onPause={noop}
        onResume={onResume}
        onLeave={noop}
      />,
    );
    fireEvent.press(getByTestId('return-arc-resume'));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('leave press calls onLeave exactly once', () => {
    const onLeave = jest.fn();
    const { getByTestId } = render(
      <ReturnArcCard
        weeks={fiveWeeks()}
        arc={arc()}
        onPause={noop}
        onResume={noop}
        onLeave={onLeave}
      />,
    );
    fireEvent.press(getByTestId('return-arc-leave'));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('leave affordance has accessibilityRole button and a non-empty label', () => {
    const { getByTestId } = render(
      <ReturnArcCard
        weeks={fiveWeeks()}
        arc={arc()}
        onPause={noop}
        onResume={noop}
        onLeave={noop}
      />,
    );
    const leaveBtn = getByTestId('return-arc-leave');
    expect(leaveBtn.props.accessibilityRole).toBe('button');
    const label: string = leaveBtn.props.accessibilityLabel;
    expect(label).toBeTruthy();
    expect(label.length).toBeGreaterThan(0);
  });

  it('begin-session affordance renders with accessibilityRole button and a non-empty label', () => {
    const { getByTestId } = render(
      <ReturnArcCard
        weeks={fiveWeeks()}
        arc={arc()}
        onPause={noop}
        onResume={noop}
        onLeave={noop}
      />,
    );
    const beginSession = getByTestId('return-arc-begin-session');
    expect(beginSession.props.accessibilityRole).toBe('button');
    const label: string = beginSession.props.accessibilityLabel;
    expect(label).toBeTruthy();
    expect(label.length).toBeGreaterThan(0);
  });

  it('pressing begin-session reveals the guided Metta session', () => {
    const { getByTestId } = render(
      <ReturnArcCard
        weeks={fiveWeeks()}
        arc={arc({ week: 1, focus: 'self' })}
        onPause={noop}
        onResume={noop}
        onLeave={noop}
      />,
    );
    fireEvent.press(getByTestId('return-arc-begin-session'));
    expect(getByTestId('metta-session-begin')).toBeTruthy();
  });

  it('opening then closing the session calls none of onPause, onResume, or onLeave', () => {
    const onPause = jest.fn();
    const onResume = jest.fn();
    const onLeave = jest.fn();
    const { getByTestId } = render(
      <ReturnArcCard
        weeks={fiveWeeks()}
        arc={arc({ week: 1, focus: 'self' })}
        onPause={onPause}
        onResume={onResume}
        onLeave={onLeave}
      />,
    );
    fireEvent.press(getByTestId('return-arc-begin-session'));
    fireEvent.press(getByTestId('metta-session-close'));
    expect(onPause).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();
  });
});
