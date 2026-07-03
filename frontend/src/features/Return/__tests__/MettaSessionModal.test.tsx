/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/hooks/usePressScale', () => ({
  usePressScale: () => ({ scale: 1, onPressIn: jest.fn(), onPressOut: jest.fn() }),
}));

jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

const MOCK_PHRASES = {
  self: ['May I be at ease.', 'May I be well.'],
  benefactor: ['May they be at ease.'],
  stranger: ['May they be at ease.'],
  antagonist: ['May they be free from suffering.', 'May they be at peace.'],
  all_beings: ['May all beings be at ease.'],
} as const;

jest.mock('../mettaSessionCopy', () => ({
  METTA_SESSION_HEADING: 'A guided Metta session',
  METTA_SESSION_BEGIN: 'Begin',
  METTA_SESSION_BEGIN_A11Y: 'Begin the guided phrases',
  METTA_SESSION_ADVANCE: 'Next',
  METTA_SESSION_ADVANCE_A11Y: 'Move to the next phrase',
  METTA_SESSION_CLOSE: 'Close',
  METTA_SESSION_CLOSE_A11Y: 'Close the session',
  METTA_SESSION_REST: 'Rest here as long as you like.',
  METTA_SESSION_PHRASES: MOCK_PHRASES,
}));

const MettaSessionModal = require('../MettaSessionModal').default;

describe('MettaSessionModal', () => {
  let fetchSpy: jest.SpiedFunction<typeof global.fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch') as jest.SpiedFunction<typeof global.fetch>;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('renders nothing when visible is false', () => {
    const { queryByTestId } = render(
      <MettaSessionModal visible={false} focus="self" onClose={jest.fn()} />,
    );
    expect(queryByTestId('metta-session-begin')).toBeNull();
  });

  it('shows a heading and a begin affordance with role and label when visible', () => {
    const { getByTestId, getByText } = render(
      <MettaSessionModal visible focus="self" onClose={jest.fn()} />,
    );
    expect(getByText('A guided Metta session')).toBeTruthy();
    const begin = getByTestId('metta-session-begin');
    expect(begin.props.accessibilityRole).toBe('button');
    const label: string = begin.props.accessibilityLabel;
    expect(label).toBeTruthy();
    expect(label.length).toBeGreaterThan(0);
  });

  it('pressing begin enters the running phase and shows the self focus first phrase', () => {
    const { getByTestId, getByText, queryByText } = render(
      <MettaSessionModal visible focus="self" onClose={jest.fn()} />,
    );
    fireEvent.press(getByTestId('metta-session-begin'));
    expect(getByText(MOCK_PHRASES.self[0])).toBeTruthy();
    expect(queryByText(MOCK_PHRASES.antagonist[0])).toBeNull();
  });

  it('pressing begin enters the running phase and shows the antagonist focus first phrase', () => {
    const { getByTestId, getByText, queryByText } = render(
      <MettaSessionModal visible focus="antagonist" onClose={jest.fn()} />,
    );
    fireEvent.press(getByTestId('metta-session-begin'));
    expect(getByText(MOCK_PHRASES.antagonist[0])).toBeTruthy();
    expect(queryByText(MOCK_PHRASES.self[0])).toBeNull();
  });

  it('advance affordance has role and label and steps through phrases in order', () => {
    const { getByTestId, getByText, queryByText } = render(
      <MettaSessionModal visible focus="self" onClose={jest.fn()} />,
    );
    fireEvent.press(getByTestId('metta-session-begin'));
    const advance = getByTestId('metta-session-advance');
    expect(advance.props.accessibilityRole).toBe('button');
    const label: string = advance.props.accessibilityLabel;
    expect(label).toBeTruthy();
    expect(label.length).toBeGreaterThan(0);

    fireEvent.press(advance);
    expect(getByText(MOCK_PHRASES.self[1])).toBeTruthy();
    expect(queryByText(MOCK_PHRASES.self[0])).toBeNull();
  });

  it('advancing past the last phrase lands on the rest state', () => {
    const { getByTestId, getByText } = render(
      <MettaSessionModal visible focus="self" onClose={jest.fn()} />,
    );
    fireEvent.press(getByTestId('metta-session-begin'));
    fireEvent.press(getByTestId('metta-session-advance'));
    fireEvent.press(getByTestId('metta-session-advance'));
    expect(getByText('Rest here as long as you like.')).toBeTruthy();
  });

  it('close affordance is present in idle, running, and rest phases with role and label', () => {
    const onCloseIdle = jest.fn();
    const idle = render(<MettaSessionModal visible focus="self" onClose={onCloseIdle} />);
    const idleClose = idle.getByTestId('metta-session-close');
    expect(idleClose.props.accessibilityRole).toBe('button');
    expect((idleClose.props.accessibilityLabel as string).length).toBeGreaterThan(0);
    fireEvent.press(idleClose);
    expect(onCloseIdle).toHaveBeenCalledTimes(1);

    const onCloseRunning = jest.fn();
    const running = render(<MettaSessionModal visible focus="self" onClose={onCloseRunning} />);
    fireEvent.press(running.getByTestId('metta-session-begin'));
    fireEvent.press(running.getByTestId('metta-session-close'));
    expect(onCloseRunning).toHaveBeenCalledTimes(1);

    const onCloseRest = jest.fn();
    const rest = render(<MettaSessionModal visible focus="self" onClose={onCloseRest} />);
    fireEvent.press(rest.getByTestId('metta-session-begin'));
    fireEvent.press(rest.getByTestId('metta-session-advance'));
    fireEvent.press(rest.getByTestId('metta-session-advance'));
    fireEvent.press(rest.getByTestId('metta-session-close'));
    expect(onCloseRest).toHaveBeenCalledTimes(1);
  });

  it('closing issues no network call', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(<MettaSessionModal visible focus="self" onClose={onClose} />);
    fireEvent.press(getByTestId('metta-session-begin'));
    fireEvent.press(getByTestId('metta-session-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('re-opening after a close resets to the idle begin affordance', () => {
    const onClose = jest.fn();
    const { getByTestId, queryByTestId, rerender } = render(
      <MettaSessionModal visible focus="self" onClose={onClose} />,
    );
    fireEvent.press(getByTestId('metta-session-begin'));
    fireEvent.press(getByTestId('metta-session-close'));

    rerender(<MettaSessionModal visible={false} focus="self" onClose={onClose} />);
    expect(queryByTestId('metta-session-begin')).toBeNull();

    rerender(<MettaSessionModal visible focus="self" onClose={onClose} />);
    expect(getByTestId('metta-session-begin')).toBeTruthy();
  });

  it('renders an optional weekTitle when provided', () => {
    const { getByText } = render(
      <MettaSessionModal visible focus="self" weekTitle="Toward yourself" onClose={jest.fn()} />,
    );
    expect(getByText('Toward yourself')).toBeTruthy();
  });
});
