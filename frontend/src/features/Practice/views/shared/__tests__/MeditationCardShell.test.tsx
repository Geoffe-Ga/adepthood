import { describe, expect, it } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { allStatuses, fakeControls, fakeState } from '../../__tests__/fixtures';
import { MeditationCardShell } from '../MeditationCardShell';

const TEST_IDS = {
  view: 'shell-view',
  timer: 'shell-timer',
  begin: 'shell-begin',
  cancelLongpress: 'shell-cancel-longpress',
};

const face = <Text testID="probe-face">face</Text>;

describe('MeditationCardShell', () => {
  it('always renders the container view and the face', () => {
    for (const status of allStatuses) {
      const { getByTestId, unmount } = render(
        <MeditationCardShell
          state={fakeState({ status, remainingMs: 60_000 })}
          controls={fakeControls()}
          hideTimer={false}
          face={face}
          testIDs={TEST_IDS}
        />,
      );
      expect(getByTestId(TEST_IDS.view)).toBeTruthy();
      expect(getByTestId('probe-face')).toBeTruthy();
      unmount();
    }
  });

  describe('idle', () => {
    it('renders the Begin button and hides the timer', () => {
      const { getByTestId, queryByTestId } = render(
        <MeditationCardShell
          state={fakeState({ status: 'idle' })}
          controls={fakeControls()}
          hideTimer={false}
          face={face}
          testIDs={TEST_IDS}
        />,
      );
      expect(getByTestId(TEST_IDS.begin)).toBeTruthy();
      expect(getByTestId(TEST_IDS.begin).props.accessibilityLabel).toBe('Begin meditation');
      expect(queryByTestId(TEST_IDS.timer)).toBeNull();
    });

    it('calls controls.start when the Begin button is pressed', () => {
      const controls = fakeControls();
      const { getByTestId } = render(
        <MeditationCardShell
          state={fakeState({ status: 'idle' })}
          controls={controls}
          hideTimer={false}
          face={face}
          testIDs={TEST_IDS}
        />,
      );
      fireEvent.press(getByTestId(TEST_IDS.begin));
      expect(controls.start).toHaveBeenCalledTimes(1);
    });
  });

  describe('running with hideTimer=true', () => {
    it('hides the timer and the standard controls bar, shows the long-press cancel', () => {
      const { getByTestId, queryByTestId } = render(
        <MeditationCardShell
          state={fakeState({ status: 'running', remainingMs: 120_000 })}
          controls={fakeControls()}
          hideTimer
          face={face}
          testIDs={TEST_IDS}
        />,
      );
      expect(queryByTestId(TEST_IDS.timer)).toBeNull();
      expect(queryByTestId('ritual-controls-bar')).toBeNull();
      expect(getByTestId(TEST_IDS.cancelLongpress)).toBeTruthy();
    });

    it('calls controls.cancel on long-press', () => {
      const controls = fakeControls();
      const { getByTestId } = render(
        <MeditationCardShell
          state={fakeState({ status: 'running', remainingMs: 120_000 })}
          controls={controls}
          hideTimer
          face={face}
          testIDs={TEST_IDS}
        />,
      );
      fireEvent(getByTestId(TEST_IDS.cancelLongpress), 'longPress');
      expect(controls.cancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('running with hideTimer=false', () => {
    it('shows the mm:ss timer and the standard controls bar', () => {
      const { getByTestId } = render(
        <MeditationCardShell
          state={fakeState({ status: 'running', remainingMs: 90_000 })}
          controls={fakeControls()}
          hideTimer={false}
          face={face}
          testIDs={TEST_IDS}
        />,
      );
      expect(getByTestId(TEST_IDS.timer).props.children).toBe('01:30');
      expect(getByTestId('ritual-controls-bar')).toBeTruthy();
    });
  });

  describe('paused', () => {
    it('shows the mm:ss timer and the standard controls bar', () => {
      const { getByTestId } = render(
        <MeditationCardShell
          state={fakeState({ status: 'paused', remainingMs: 45_000 })}
          controls={fakeControls()}
          hideTimer
          face={face}
          testIDs={TEST_IDS}
        />,
      );
      expect(getByTestId(TEST_IDS.timer).props.children).toBe('00:45');
      expect(getByTestId('ritual-controls-bar')).toBeTruthy();
    });
  });

  describe('complete', () => {
    it('renders the supplied completeFooter instead of the standard controls bar', () => {
      const { getByTestId, queryByTestId } = render(
        <MeditationCardShell
          state={fakeState({ status: 'complete', remainingMs: 0 })}
          controls={fakeControls()}
          hideTimer
          face={face}
          completeFooter={<Text testID="probe-complete">done</Text>}
          testIDs={TEST_IDS}
        />,
      );
      expect(getByTestId('probe-complete')).toBeTruthy();
      expect(queryByTestId('ritual-controls-bar')).toBeNull();
    });

    it('falls back to the standard controls bar when no completeFooter is supplied', () => {
      const { getByTestId } = render(
        <MeditationCardShell
          state={fakeState({ status: 'complete', remainingMs: 0 })}
          controls={fakeControls()}
          hideTimer
          face={face}
          testIDs={TEST_IDS}
        />,
      );
      expect(getByTestId('ritual-controls-bar')).toBeTruthy();
      expect(getByTestId('ritual-complete-label')).toBeTruthy();
    });

    it('shows the mm:ss timer', () => {
      const { getByTestId } = render(
        <MeditationCardShell
          state={fakeState({ status: 'complete', remainingMs: 0 })}
          controls={fakeControls()}
          hideTimer
          face={face}
          testIDs={TEST_IDS}
        />,
      );
      expect(getByTestId(TEST_IDS.timer).props.children).toBe('00:00');
    });
  });
});
