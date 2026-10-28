import { describe, expect, it } from '@jest/globals';
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

import { Ribbon, ribbonTableRows } from '../Ribbon';

import { STAGE_COLORS } from '@/design/tokens';

const blocks = [
  { label: 'First aspect', weeks: 3, color: STAGE_COLORS.Beige! },
  { label: 'Second aspect', weeks: 3, color: STAGE_COLORS.Purple! },
  { label: 'Longer aspect', weeks: 6, color: STAGE_COLORS.Red! },
  { label: 'Final aspect', weeks: 1, color: STAGE_COLORS.Blue! },
];

describe('the ribbon timeline', () => {
  it('names each stage’s inclusive position rather than repeating its duration', () => {
    expect(ribbonTableRows(blocks)).toEqual([
      { label: 'First aspect', values: ['Weeks 1–3'] },
      { label: 'Second aspect', values: ['Weeks 4–6'] },
      { label: 'Longer aspect', values: ['Weeks 7–12'] },
      { label: 'Final aspect', values: ['Week 13'] },
    ]);
  });

  it('keeps the stage, habit birth and current position in the table twin', () => {
    const tree = render(
      <Ribbon
        blocks={blocks}
        secondaryBlocks={[{ ...blocks[0]!, label: 'Previous first aspect' }]}
        markers={[{ label: 'Water began', week: 5 }]}
        currentWeek={8}
        summary="Your arc, with a habit beginning in week five."
      />,
    );
    const legend = within(tree.getByTestId('ribbon-stage-key'));
    expect(legend.getByText('Second aspect')).toBeTruthy();
    expect(legend.getByText('Weeks 4–6')).toBeTruthy();
    fireEvent.press(tree.getByRole('button', { name: 'Show as table' }));
    expect(tree.queryByText('Weeks / week')).toBeNull();
    expect(tree.getByText('Weeks 4–6')).toBeTruthy();
    expect(tree.getByText('Water began')).toBeTruthy();
    expect(tree.getByText('Week 5')).toBeTruthy();
    expect(tree.getByText('You are here')).toBeTruthy();
    expect(tree.getByText('Week 8')).toBeTruthy();
    expect(tree.getByText('Previous first aspect')).toBeTruthy();
  });
});
