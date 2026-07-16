/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, fireEvent, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

import type { Stage } from '../../../api';
import { colors, STAGE_COLORS, STAGE_ORDER } from '../../../design/tokens';
import StageSelector from '../StageSelector';

function backgroundColorOf(style: StyleProp<ViewStyle>): string {
  const flat = StyleSheet.flatten(style) ?? {};
  return (flat.backgroundColor as string | undefined) ?? '';
}

function glyphColorOf(style: StyleProp<TextStyle>): string {
  const flat = StyleSheet.flatten(style) ?? {};
  return (flat.color as string | undefined) ?? '';
}

/** WCAG relative luminance of a #rrggbb color. */
const luminance = (hex: string): number => {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`not a 6-digit hex: ${hex}`);
  const channels = [match[1], match[2], match[3]].map((pair) => {
    const c = Number.parseInt(pair!, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};

const contrast = (a: string, b: string): number => {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

const AA_NORMAL = 4.5;

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

  it('shows checkmark for completed stages and the number for uncompleted ones', () => {
    const { getByTestId } = render(
      <StageSelector stages={sampleStages} selectedStage={2} onSelectStage={onSelectStage} />,
    );

    // Stage 1 (progress 1.0) renders the checkmark glyph and flags completion.
    const pill1 = getByTestId('stage-pill-1');
    expect(within(pill1).getByText('✓')).toBeTruthy();
    expect(pill1.props.accessibilityLabel).toBe('Stage 1, completed');

    // Stage 2 (unlocked, progress 0.5) renders its number, never the checkmark.
    const pill2 = getByTestId('stage-pill-2');
    expect(within(pill2).getByText('2')).toBeTruthy();
    expect(within(pill2).queryByText('✓')).toBeNull();
    expect(pill2.props.accessibilityLabel).toBe('Stage 2');
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

  it('resolves per-stage state by stage_number regardless of array order', () => {
    // The O(1) keyed-Map lookup must key on stage_number, not array position —
    // so a shuffled API response still highlights/locks the correct pills.
    const shuffled: Stage[] = [sampleStages[2]!, sampleStages[0]!, sampleStages[1]!];
    const { getByTestId } = render(
      <StageSelector stages={shuffled} selectedStage={2} onSelectStage={onSelectStage} />,
    );

    // Stage 1 completed (progress 1.0), stage 2 selected+unlocked, stage 3 locked.
    expect(getByTestId('stage-pill-1').props.accessibilityState).toEqual({
      selected: false,
      disabled: false,
    });
    expect(getByTestId('stage-pill-2').props.accessibilityState).toEqual({
      selected: true,
      disabled: false,
    });
    expect(getByTestId('stage-pill-3').props.accessibilityState).toEqual({
      selected: false,
      disabled: true,
    });
  });

  it('renders no pills when the stages list is empty', () => {
    const { queryByTestId } = render(
      <StageSelector stages={[]} selectedStage={1} onSelectStage={onSelectStage} />,
    );

    expect(queryByTestId('stage-pill-1')).toBeNull();
  });

  it('falls back to the neutral color for an unrecognized spiral_dynamics_color', () => {
    const stages = [makeStage({ stage_number: 1, spiral_dynamics_color: 'Mauve' })];
    const { getByTestId } = render(
      <StageSelector stages={stages} selectedStage={1} onSelectStage={onSelectStage} />,
    );

    const style = getByTestId('stage-pill-1').props.style as StyleProp<ViewStyle>;
    expect(backgroundColorOf(style)).toBe(colors.neutral);
  });

  it('falls back to the STAGE_ORDER position color when the API omits a stage number', () => {
    // Only stage 2 comes back from the API; pill 1 still renders and is
    // colored by its STAGE_ORDER position (Beige) since it has no matching
    // API record to read spiral_dynamics_color from.
    const stages = [makeStage({ stage_number: 2, spiral_dynamics_color: 'Purple' })];
    const { getByTestId } = render(
      <StageSelector stages={stages} selectedStage={1} onSelectStage={onSelectStage} />,
    );

    const pill1 = getByTestId('stage-pill-1');
    const style = pill1.props.style as StyleProp<ViewStyle>;
    expect(backgroundColorOf(style)).toBe(STAGE_COLORS[STAGE_ORDER[0]!]);
    expect(pill1.props.accessibilityState).toMatchObject({ selected: true, disabled: true });
  });

  it('falls back to neutral when a missing stage number also exceeds STAGE_ORDER', () => {
    // stage_number 12 forces pills 1..12; pill 11 has neither an API record
    // nor a STAGE_ORDER entry (only 10 named stages), so it resolves neutral.
    const stages = [makeStage({ stage_number: 12 })];
    const { getByTestId } = render(
      <StageSelector stages={stages} selectedStage={1} onSelectStage={onSelectStage} />,
    );

    const pill11 = getByTestId('stage-pill-11');
    const style = pill11.props.style as StyleProp<ViewStyle>;
    expect(backgroundColorOf(style)).toBe(colors.neutral);
  });

  it('renders the lock glyph for a locked, non-completed stage', () => {
    const stages = [makeStage({ stage_number: 1, is_unlocked: false, progress: 0 })];
    const { getByTestId } = render(
      <StageSelector stages={stages} selectedStage={1} onSelectStage={onSelectStage} />,
    );

    expect(within(getByTestId('stage-pill-1')).getByText('🔒')).toBeTruthy();
  });

  it('prioritizes the completed checkmark over the lock glyph when a stage is both', () => {
    // Unusual API data (progress complete but is_unlocked false) pins the
    // ternary order: completed wins the glyph even though the pill is locked.
    const stages = [makeStage({ stage_number: 1, is_unlocked: false, progress: 1.0 })];
    const { getByTestId } = render(
      <StageSelector stages={stages} selectedStage={1} onSelectStage={onSelectStage} />,
    );

    const pill1 = getByTestId('stage-pill-1');
    expect(within(pill1).getByText('✓')).toBeTruthy();
    expect(within(pill1).queryByText('🔒')).toBeNull();
    expect(pill1.props.accessibilityLabel).toBe('Stage 1, locked, completed');
  });

  describe('glyph contrast (WCAG AA)', () => {
    it('renders the number glyph readably on a light stage fill', () => {
      const stages = [
        makeStage({
          stage_number: 1,
          spiral_dynamics_color: 'Clear Light',
          is_unlocked: true,
          progress: 0,
        }),
      ];
      const { getByTestId } = render(
        <StageSelector stages={stages} selectedStage={1} onSelectStage={onSelectStage} />,
      );

      const pill = getByTestId('stage-pill-1');
      const fill = backgroundColorOf(pill.props.style as StyleProp<ViewStyle>);
      const glyph = within(pill).getByText('1');
      const glyphColor = glyphColorOf(glyph.props.style as StyleProp<TextStyle>);
      expect(contrast(glyphColor, fill)).toBeGreaterThanOrEqual(AA_NORMAL);
    });

    it('renders the completed checkmark readably on a light stage fill', () => {
      const stages = [
        makeStage({
          stage_number: 1,
          spiral_dynamics_color: 'Clear Light',
          is_unlocked: true,
          progress: 1.0,
        }),
      ];
      const { getByTestId } = render(
        <StageSelector stages={stages} selectedStage={1} onSelectStage={onSelectStage} />,
      );

      const pill = getByTestId('stage-pill-1');
      const fill = backgroundColorOf(pill.props.style as StyleProp<ViewStyle>);
      const glyph = within(pill).getByText('✓');
      const glyphColor = glyphColorOf(glyph.props.style as StyleProp<TextStyle>);
      expect(contrast(glyphColor, fill)).toBeGreaterThanOrEqual(AA_NORMAL);
    });

    it('renders the completed checkmark readably on the Ultraviolet dark stage fill', () => {
      const stages = [
        makeStage({
          stage_number: 1,
          spiral_dynamics_color: 'Ultraviolet',
          is_unlocked: true,
          progress: 1.0,
        }),
      ];
      const { getByTestId } = render(
        <StageSelector stages={stages} selectedStage={1} onSelectStage={onSelectStage} />,
      );

      const pill = getByTestId('stage-pill-1');
      const fill = backgroundColorOf(pill.props.style as StyleProp<ViewStyle>);
      const glyph = within(pill).getByText('✓');
      const glyphColor = glyphColorOf(glyph.props.style as StyleProp<TextStyle>);
      expect(contrast(glyphColor, fill)).toBeGreaterThanOrEqual(AA_NORMAL);
    });

    it('renders the lock glyph readably on a light stage fill', () => {
      const stages = [
        makeStage({
          stage_number: 1,
          spiral_dynamics_color: 'Clear Light',
          is_unlocked: false,
          progress: 0,
        }),
      ];
      const { getByTestId } = render(
        <StageSelector stages={stages} selectedStage={1} onSelectStage={onSelectStage} />,
      );

      const pill = getByTestId('stage-pill-1');
      const fill = backgroundColorOf(pill.props.style as StyleProp<ViewStyle>);
      const glyph = within(pill).getByText('🔒');
      const glyphColor = glyphColorOf(glyph.props.style as StyleProp<TextStyle>);
      expect(contrast(glyphColor, fill)).toBeGreaterThanOrEqual(AA_NORMAL);
    });

    it('renders the lock glyph readably on the Ultraviolet dark stage fill', () => {
      const stages = [
        makeStage({
          stage_number: 1,
          spiral_dynamics_color: 'Ultraviolet',
          is_unlocked: false,
          progress: 0,
        }),
      ];
      const { getByTestId } = render(
        <StageSelector stages={stages} selectedStage={1} onSelectStage={onSelectStage} />,
      );

      const pill = getByTestId('stage-pill-1');
      const fill = backgroundColorOf(pill.props.style as StyleProp<ViewStyle>);
      const glyph = within(pill).getByText('🔒');
      const glyphColor = glyphColorOf(glyph.props.style as StyleProp<TextStyle>);
      expect(contrast(glyphColor, fill)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  });
});
