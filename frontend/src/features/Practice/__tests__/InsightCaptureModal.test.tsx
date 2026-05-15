/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import {
  InsightCaptureModal,
  type InsightCaptureModalProps,
  PRACTICE_INSIGHT_HARD_CAP,
  PRACTICE_INSIGHT_SOFT_CAP,
} from '../components/InsightCaptureModal';
import type { ModeSummaryMetadata } from '../insights/format';

type RenderOpts = Partial<InsightCaptureModalProps>;

function renderModal(opts: RenderOpts = {}) {
  const props: InsightCaptureModalProps = {
    visible: opts.visible ?? true,
    mode: opts.mode ?? 'meditation_timer',
    durationMinutes: opts.durationMinutes ?? 10,
    modeMetadata: opts.modeMetadata ?? { mode: 'meditation_timer' },
    onSave: opts.onSave ?? jest.fn(),
    onSkip: opts.onSkip ?? jest.fn(),
    // Defer to the explicit undefined-vs-default distinction so a test that
    // passes ``onJournal: undefined`` exercises the "hand-off not wired"
    // branch instead of silently getting the spy.
    onJournal: 'onJournal' in opts ? opts.onJournal : jest.fn(),
  };
  return { ...render(<InsightCaptureModal {...props} />), props };
}

describe('InsightCaptureModal', () => {
  it('renders nothing when visible is false', () => {
    const { queryByTestId } = renderModal({ visible: false });
    expect(queryByTestId('insight-capture-modal')).toBeNull();
  });

  it.each<[string, ModeSummaryMetadata['mode'], ModeSummaryMetadata, number, string]>([
    ['meditation', 'meditation_timer', { mode: 'meditation_timer' }, 10, '10:00 of stillness'],
    ['count-up', 'count_up', { mode: 'count_up' }, 7.5, '07:30 of open practice'],
    ['metronome', 'metronome', { mode: 'metronome', bpm_used: 60 }, 30, 'BPM 60 for 30:00'],
    [
      'interval-bell',
      'interval_bell',
      { mode: 'interval_bell', intervals_struck: 3, total_intervals: 5 },
      15,
      '3/5 bells over 15:00',
    ],
    [
      'rep-counter',
      'rep_counter',
      { mode: 'rep_counter', rep_count: 108, unit_label: 'breath cycles' },
      12 + 34 / 60,
      '108 breath cycles in 12:34',
    ],
    [
      'sense-grounding',
      'sense_grounding',
      { mode: 'sense_grounding', senses_completed: ['sight', 'touch', 'hearing'] },
      4,
      'Grounded through 3 senses',
    ],
    [
      'tarot',
      'tarot',
      { mode: 'tarot', card_index: 0, card_name: 'The Fool' },
      5,
      'The Fool for 05:00',
    ],
  ])('renders the %s summary line', (_label, mode, modeMetadata, durationMinutes, expected) => {
    const { getByTestId } = renderModal({ mode, modeMetadata, durationMinutes });
    expect(getByTestId('insight-summary').props.children).toBe(expected);
  });

  it('passes the typed insight to onSave when Save is pressed', () => {
    const onSave = jest.fn();
    const { getByTestId } = renderModal({ onSave });
    fireEvent.changeText(getByTestId('insight-input'), 'Felt steady.');
    fireEvent.press(getByTestId('insight-save'));
    expect(onSave).toHaveBeenCalledWith('Felt steady.');
  });

  it('passes the typed insight to onJournal when Save & journal is pressed', () => {
    const onJournal = jest.fn();
    const { getByTestId } = renderModal({ onJournal });
    fireEvent.changeText(getByTestId('insight-input'), 'Curious about a memory.');
    fireEvent.press(getByTestId('insight-journal'));
    expect(onJournal).toHaveBeenCalledWith('Curious about a memory.');
  });

  it('hides the Save & journal CTA when onJournal is not wired', () => {
    const { queryByTestId } = renderModal({ onJournal: undefined });
    expect(queryByTestId('insight-journal')).toBeNull();
  });

  it('calls onSkip with no arguments when Skip is pressed (no insight POSTed)', () => {
    const onSkip = jest.fn();
    const { getByTestId } = renderModal({ onSkip });
    // Typing then skipping must still skip — the buffered insight is discarded.
    fireEvent.changeText(getByTestId('insight-input'), 'Will not be saved.');
    fireEvent.press(getByTestId('insight-skip'));
    expect(onSkip).toHaveBeenCalledWith();
  });

  it('trims whitespace-only insights to empty strings (still routed via onSave)', () => {
    const onSave = jest.fn();
    const { getByTestId } = renderModal({ onSave });
    fireEvent.changeText(getByTestId('insight-input'), '   ');
    fireEvent.press(getByTestId('insight-save'));
    expect(onSave).toHaveBeenCalledWith('');
  });

  it('shows a soft hint once the soft cap is crossed but keeps Save enabled', () => {
    const onSave = jest.fn();
    const { getByTestId, queryByTestId } = renderModal({ onSave });
    const longish = 'x'.repeat(PRACTICE_INSIGHT_SOFT_CAP + 1);
    fireEvent.changeText(getByTestId('insight-input'), longish);
    expect(queryByTestId('insight-soft-hint')).toBeTruthy();
    expect(queryByTestId('insight-hard-error')).toBeNull();
    fireEvent.press(getByTestId('insight-save'));
    expect(onSave).toHaveBeenCalledWith(longish);
  });

  it('disables Save and surfaces a validation message beyond the hard cap', () => {
    const onSave = jest.fn();
    const onJournal = jest.fn();
    const { getByTestId, queryByTestId } = renderModal({ onSave, onJournal });
    const tooLong = 'x'.repeat(PRACTICE_INSIGHT_HARD_CAP + 1);
    fireEvent.changeText(getByTestId('insight-input'), tooLong);
    expect(queryByTestId('insight-hard-error')).toBeTruthy();
    fireEvent.press(getByTestId('insight-save'));
    fireEvent.press(getByTestId('insight-journal'));
    expect(onSave).not.toHaveBeenCalled();
    expect(onJournal).not.toHaveBeenCalled();
  });

  it('still lets the user skip when the hard cap is exceeded (analytics row matters)', () => {
    const onSkip = jest.fn();
    const { getByTestId } = renderModal({ onSkip });
    fireEvent.changeText(getByTestId('insight-input'), 'x'.repeat(PRACTICE_INSIGHT_HARD_CAP + 50));
    fireEvent.press(getByTestId('insight-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('pins the hard cap constant to the cross-system value (2000 chars)', () => {
    // Cross-system contract: the backend mirror is asserted in
    // ``backend/tests/test_openapi_insight_cap_contract.py``.  Together the
    // two tests bracket the contract — bumping the cap on one side without
    // the other will fail the corresponding test before merge.
    expect(PRACTICE_INSIGHT_HARD_CAP).toBe(2_000);
  });

  it('clears the draft when the modal is re-shown after dismissal (retry path)', () => {
    // Render a controlled wrapper so we can flip ``visible`` without
    // remounting — the bug the reviewer flagged is that the draft state
    // survived an open → close → open cycle because the component is
    // null-rendered (not unmounted) when ``visible`` is false.
    function Harness({ visible }: { visible: boolean }) {
      return (
        <InsightCaptureModal
          visible={visible}
          mode="meditation_timer"
          durationMinutes={10}
          modeMetadata={{ mode: 'meditation_timer' }}
          onSave={jest.fn()}
          onSkip={jest.fn()}
        />
      );
    }
    const { getByTestId, rerender } = render(<Harness visible />);
    fireEvent.changeText(getByTestId('insight-input'), 'stale draft from a prior session');
    rerender(<Harness visible={false} />);
    rerender(<Harness visible />);
    expect(getByTestId('insight-input').props.value).toBe('');
  });

  it('keeps Save enabled when the raw input crosses the hard cap only via trailing whitespace', () => {
    // The submitted value is ``trimmed``; evaluating the cap against
    // ``trimmed.length`` means a user who types right up to the cap and
    // then adds a trailing space (e.g. mid-sentence) is not blocked.
    const onSave = jest.fn();
    const { getByTestId, queryByTestId } = renderModal({ onSave });
    const atCap = 'x'.repeat(PRACTICE_INSIGHT_HARD_CAP);
    fireEvent.changeText(getByTestId('insight-input'), `${atCap}    `);
    expect(queryByTestId('insight-hard-error')).toBeNull();
    fireEvent.press(getByTestId('insight-save'));
    expect(onSave).toHaveBeenCalledWith(atCap);
  });
});
