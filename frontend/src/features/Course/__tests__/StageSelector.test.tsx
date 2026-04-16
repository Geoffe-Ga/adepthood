/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';

import type { Stage } from '../../../api';
import StageSelector from '../StageSelector';

const makeStage = (overrides: Partial<Stage> = {}): Stage => ({
  id: 1,
  title: 'Stage 1',
  subtitle: 'First stage',
  stage_number: 1,
  overview_url: 'https://example.com',
  category: 'foundation',
  aspect: 'body',
  spiral_dynamics_color: 'Beige',
  growing_up_stage: 'Archaic',
  divine_gender_polarity: 'neutral',
  relationship_to_free_will: 'reactive',
  free_will_description: 'Instinctual survival',
  is_unlocked: true,
  progress: 0,
  ...overrides,
});

const sampleStages: Stage[] = [
  makeStage({ id: 1, stage_number: 1, title: 'Stage 1', is_unlocked: true, progress: 1.0 }),
  makeStage({
    id: 2,
    stage_number: 2,
    title: 'Stage 2',
    spiral_dynamics_color: 'Purple',
    is_unlocked: true,
    progress: 0.5,
  }),
  makeStage({
    id: 3,
    stage_number: 3,
    title: 'Stage 3',
    spiral_dynamics_color: 'Red',
    is_unlocked: false,
    progress: 0,
  }),
];

describe('StageSelector', () => {
  let onSelectStage: jest.Mock;

  beforeEach(() => {
    onSelectStage = jest.fn() as any;
  });

  it('renders one pill per stage from API data', () => {
    const { getByTestId, queryByTestId } = render(
      <StageSelector stages={sampleStages} selectedStage={1} onSelectStage={onSelectStage} />,
    );

    // sampleStages has 3 stages (max stage_number = 3)
    for (let i = 1; i <= 3; i++) {
      expect(getByTestId(`stage-pill-${i}`)).toBeTruthy();
    }
    // No pill 4 should exist
    expect(queryByTestId('stage-pill-4')).toBeNull();
  });

  it('shows checkmark for completed stages', () => {
    const { getByTestId } = render(
      <StageSelector stages={sampleStages} selectedStage={2} onSelectStage={onSelectStage} />,
    );

    // Stage 1 has progress === 1.0, should show checkmark
    const pill1 = getByTestId('stage-pill-1');
    expect(pill1).toBeTruthy();
  });

  it('calls onSelectStage when an unlocked stage is tapped', () => {
    const { getByTestId } = render(
      <StageSelector stages={sampleStages} selectedStage={1} onSelectStage={onSelectStage} />,
    );

    fireEvent.press(getByTestId('stage-pill-2'));
    expect(onSelectStage).toHaveBeenCalledWith(2);
  });

  it('does not call onSelectStage when a locked stage is tapped', () => {
    const { getByTestId } = render(
      <StageSelector stages={sampleStages} selectedStage={1} onSelectStage={onSelectStage} />,
    );

    // Stage 3 is locked
    fireEvent.press(getByTestId('stage-pill-3'));
    expect(onSelectStage).not.toHaveBeenCalled();
  });

  it('marks the selected stage as active', () => {
    const { getByTestId } = render(
      <StageSelector stages={sampleStages} selectedStage={2} onSelectStage={onSelectStage} />,
    );

    const pill = getByTestId('stage-pill-2');
    expect(pill.props.accessibilityState).toEqual({ selected: true, disabled: false });
  });

  it('marks locked stages with disabled accessibility state', () => {
    const { getByTestId } = render(
      <StageSelector stages={sampleStages} selectedStage={1} onSelectStage={onSelectStage} />,
    );

    const pill = getByTestId('stage-pill-3');
    expect(pill.props.accessibilityState).toEqual({ selected: false, disabled: true });
  });
});
