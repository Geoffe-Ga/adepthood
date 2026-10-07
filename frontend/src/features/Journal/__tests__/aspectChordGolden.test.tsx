/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

import {
  CANON_STAGE_OVERRIDES,
  createCanonicalStages,
  GOLDEN_STAGE_NUMBERS,
} from '@/features/Map/__tests__/stageVocabularyGolden';
import { useStageStore } from '@/store/useStageStore';

/**
 * The Journal chord offers each Aspect under its course Aspect name (golden,
 * #2666, #3037).
 *
 * With the stage store holding what a freshly seeded `GET /stages` serves, the
 * ten chips the writer meets on a new page read the canon Aspect names
 * ("Agency", "Receptivity", "Self-Love" ...), in stage order, as both their
 * visible label and their accessible name. Never the free-will persona: a chip
 * reading "Victim" would have the writer tag their words with the shadow
 * instead of the note they are naming (chords, not rungs).
 */

jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));
jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

jest.mock('@/api', () => ({
  journal: {
    get: jest.fn(),
    create: jest.fn(() => new Promise(() => {})),
    update: jest.fn(() => new Promise(() => {})),
  },
  prompts: { respond: jest.fn(() => Promise.resolve({})) },
  resonance: {
    list: jest.fn(() => Promise.resolve({ items: [] })),
    generate: jest.fn(),
  },
  completionSuggestions: {
    list: jest.fn(() => Promise.resolve({ items: [] })),
    accept: jest.fn(),
    dismiss: jest.fn(),
  },
  promotions: {
    create: jest.fn(),
    remove: jest.fn(),
    setIncluded: jest.fn(),
    list: jest.fn(() => Promise.resolve([])),
  },
}));

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

const JournalEntryScreen = require('../JournalEntryScreen').default;

function renderNewPage() {
  const route = { key: 'k', name: 'JournalEntry' as const, params: undefined };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(<Screen navigation={navigation} route={route} />);
}

describe('the Journal chord golden', () => {
  beforeEach(() => {
    useStageStore.getState().setStages(createCanonicalStages());
  });

  it('offers the ten Aspects under their canon Aspect names, never personas, in stage order', async () => {
    const { getByTestId } = renderNewPage();
    await waitFor(() => {
      expect(getByTestId('aspect-chord-trigger')).toBeTruthy();
    });
    fireEvent.press(getByTestId('aspect-chord-trigger'));

    const page = within(getByTestId('journal-page'));
    for (const stageNumber of GOLDEN_STAGE_NUMBERS) {
      const canon = CANON_STAGE_OVERRIDES[stageNumber];
      if (canon === undefined) throw new Error(`no canon for stage ${stageNumber}`);
      expect(page.getByTestId(`aspect-primary-${stageNumber}-label`).props.children).toBe(
        canon.aspect,
      );
      expect(page.getByTestId(`aspect-primary-${stageNumber}`).props.accessibilityLabel).toBe(
        canon.aspect,
      );
      expect(page.queryByText(canon.relationshipToFreeWill)).toBeNull();
    }
  });
});
