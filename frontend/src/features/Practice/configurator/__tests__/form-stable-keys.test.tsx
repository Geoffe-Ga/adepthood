/* eslint-env jest */
// audit-render-08: dynamic form rows must be keyed by a stable id, not the array
// index, so per-row instance state (an open dropdown, focus) stays attached to
// the correct row across a reorder or non-tail delete.
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type {
  CardMeditationCard,
  CardMeditationConfig,
  SenseGroundingConfig,
} from '../../engine/types';
import CardMeditationForm from '../forms/CardMeditationForm';
import SenseGroundingForm from '../forms/SenseGroundingForm';

jest.mock('../../utils/pickCardPhoto', () => ({ pickCardPhoto: jest.fn() }));

// The forms are controlled, so a stateful harness holds the config and
// re-renders on onChange — mirroring the real configurator sheet.
const SenseHarness = ({ initial }: { initial: SenseGroundingConfig }) => {
  const [cfg, setCfg] = React.useState(initial);
  return <SenseGroundingForm value={cfg} onChange={setCfg} />;
};

const CardHarness = ({ initial }: { initial: CardMeditationConfig }) => {
  const [cfg, setCfg] = React.useState(initial);
  return <CardMeditationForm value={cfg} onChange={setCfg} />;
};

const senseConfig = (): SenseGroundingConfig => ({
  mode: 'sense_grounding',
  prompts: [
    { sense: 'sight', label: 'A' },
    { sense: 'hearing', label: 'B' },
    { sense: 'touch', label: 'C' },
  ],
});

describe('SenseGroundingForm stable row keys', () => {
  it('keeps an open dropdown on the correct row after a non-tail delete', () => {
    const { getByTestId, queryByTestId } = render(<SenseHarness initial={senseConfig()} />);
    // Open the LAST row's dropdown — open state lives on that row's instance.
    fireEvent.press(getByTestId('sense-prompt-2-thing-trigger'));
    expect(queryByTestId('sense-prompt-2-panel')).toBeTruthy();

    // Delete the FIRST row; the last row shifts to index 1.
    fireEvent.press(getByTestId('sense-prompt-0-remove'));

    // Stable keys → the open dropdown followed its row to index 1. An
    // index-keyed list would have unmounted it (panel gone / on the wrong row).
    expect(queryByTestId('sense-prompt-1-panel')).toBeTruthy();
    expect(queryByTestId('sense-prompt-0-panel')).toBeNull();
  });

  it('keeps an open dropdown on the correct row after a reorder', () => {
    const { getByTestId, queryByTestId } = render(<SenseHarness initial={senseConfig()} />);
    fireEvent.press(getByTestId('sense-prompt-0-thing-trigger'));
    expect(queryByTestId('sense-prompt-0-panel')).toBeTruthy();

    // Move the first row down; its open dropdown must follow it to index 1.
    fireEvent.press(getByTestId('sense-prompt-0-down'));

    expect(queryByTestId('sense-prompt-1-panel')).toBeTruthy();
    expect(queryByTestId('sense-prompt-0-panel')).toBeNull();
  });

  it('assigns an appended row a fresh stable key that survives a later delete', () => {
    const { getByTestId, queryByTestId } = render(<SenseHarness initial={senseConfig()} />);
    // Append a 4th row, then open its dropdown.
    fireEvent.press(getByTestId('sense-grounding-add'));
    fireEvent.press(getByTestId('sense-prompt-3-thing-trigger'));
    expect(queryByTestId('sense-prompt-3-panel')).toBeTruthy();

    // Delete the first row; the appended row shifts to index 2, and its open
    // dropdown follows — proving append handed out a fresh, stable key.
    fireEvent.press(getByTestId('sense-prompt-0-remove'));
    expect(queryByTestId('sense-prompt-2-panel')).toBeTruthy();
  });
});

describe('CardMeditationForm stable row keys', () => {
  const cards: CardMeditationCard[] = [
    { name: 'Alpha', image_asset_key: null, image_uri: null, symbolism: null },
    { name: 'Beta', image_asset_key: null, image_uri: null, symbolism: null },
    { name: 'Gamma', image_asset_key: null, image_uri: null, symbolism: null },
  ];

  it('keeps the surviving cards intact after a non-tail delete', () => {
    const { getByTestId, queryByTestId } = render(
      <CardHarness initial={{ mode: 'card_meditation', deck_id: 'custom', cards }} />,
    );
    // Delete the middle card; the keysRef stays in lockstep so the survivors
    // keep their own rows.
    fireEvent.press(getByTestId('card-meditation-remove-card-1'));

    expect(getByTestId('card-meditation-card-name-0').props.value).toBe('Alpha');
    expect(getByTestId('card-meditation-card-name-1').props.value).toBe('Gamma');
    expect(queryByTestId('card-meditation-card-name-2')).toBeNull();
  });
});
