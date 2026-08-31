/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

import type {
  JournalListResponse,
  PromptDetail,
  PromptListResponse,
  StagePromptDetail,
  StagePromptsResponse,
} from '@/api';

const mockList = jest.fn() as jest.MockedFunction<() => Promise<JournalListResponse>>;
const mockPromptCurrent = jest.fn() as jest.MockedFunction<() => Promise<PromptDetail>>;
const mockPromptStage = jest.fn() as jest.MockedFunction<
  (_stage: number) => Promise<StagePromptsResponse>
>;
const mockPromptHistory = jest.fn() as jest.MockedFunction<() => Promise<PromptListResponse>>;
const mockNavigate = jest.fn();

jest.mock('@/api', () => ({
  journal: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    update: jest.fn(),
  },
  prompts: {
    current: (...a: unknown[]) =>
      (mockPromptCurrent as unknown as (...x: unknown[]) => unknown)(...a),
    stage: (...a: unknown[]) => (mockPromptStage as unknown as (...x: unknown[]) => unknown)(...a),
    history: (...a: unknown[]) =>
      (mockPromptHistory as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

jest.mock('@react-navigation/native', () => {
  const react = jest.requireActual('react') as {
    useEffect: (_cb: () => undefined | (() => void), _deps: unknown[]) => void;
  };
  return {
    useNavigation: () => ({ navigate: mockNavigate, setOptions: jest.fn() }),
    // Keyed on the callback (not []), so a stage that resolves after mount
    // re-runs the effect the way React Navigation's own focus effect does.
    useFocusEffect: (cb: () => undefined | (() => void)) => react.useEffect(cb, [cb]),
  };
});

jest.mock('../SearchBar', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="shelf-search-stub" />;
  return { __esModule: true, default: Stub };
});
jest.mock('../StatTileRow', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="stat-tile-row-stub" />;
  return { __esModule: true, default: Stub };
});
jest.mock('@/features/Return/ReturnStack', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="return-stack-stub" />;
  return { __esModule: true, default: Stub };
});
jest.mock('@/features/Invitations/InvitationStack', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="invitation-stack-stub" />;
  return { __esModule: true, default: Stub };
});
jest.mock('../MorningPagesTip', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="morning-pages-tip-stub" />;
  return { __esModule: true, default: Stub };
});

const JournalShelfScreen = require('../JournalShelfScreen').default;

// Fixtures only: the shelf must read every one of these strings off the wire.
const ORANGE_PROMPTS: StagePromptDetail[] = [
  {
    ordinal: 1,
    title: 'Make a List of 25 Curiosities',
    body: 'What are you curious about?',
    cadence: 'Build to 25 across four sittings',
  },
  {
    ordinal: 2,
    title: 'Make a List of 15 Problems',
    body: 'What keeps you up at night?',
    cadence: 'Build to 15 across two sittings',
  },
  {
    ordinal: 3,
    title: 'Combine Curiosities in Service of One Problem',
    body: 'Which curiosity serves which problem?',
    cadence: 'One combination per sitting',
  },
  {
    ordinal: 4,
    title: 'Formulate Your Answer as a Four Quadrant Vow',
    body: 'What do you vow?',
    // A stage whose chapter states no cadence for a prompt: rendered as
    // nothing at all rather than as an invented rhythm.
    cadence: null,
  },
];

const BEIGE_PROMPTS: StagePromptDetail[] = [
  { ordinal: 1, title: 'Name What You Need', body: 'What do you need?', cadence: 'Daily' },
  {
    ordinal: 2,
    title: 'Track the Body',
    body: 'Where does it live?',
    cadence: 'At least 4x per week',
  },
  {
    ordinal: 3,
    title: 'Notice the Ground',
    body: 'What holds you?',
    cadence: 'Whenever they arise',
  },
];

function stageResponse(
  stage: number,
  stageName: string,
  prompts: StagePromptDetail[],
): StagePromptsResponse {
  return { stage, stage_name: stageName, prompts };
}

function answered(weekNumber: number, promptOrdinal: number): PromptDetail {
  return {
    week_number: weekNumber,
    question: 'Answered already.',
    has_responded: true,
    response: 'I wrote it.',
    timestamp: '2026-06-01T00:00:00Z',
    prompt_ordinal: promptOrdinal,
  };
}

function history(items: PromptDetail[]): PromptListResponse {
  return { items, total: items.length, has_more: false };
}

beforeEach(() => {
  mockList.mockReset();
  mockNavigate.mockReset();
  mockPromptCurrent.mockReset();
  mockPromptStage.mockReset();
  mockPromptHistory.mockReset();
  mockList.mockResolvedValue({ items: [], total: 0, has_more: false });
  // Week 14 sits in stage 5 (five 21-day stages, three weeks each).
  mockPromptCurrent.mockResolvedValue({
    week_number: 14,
    question: 'What did you notice this week?',
    has_responded: false,
    response: null,
    timestamp: null,
    prompt_ordinal: 1,
  });
  mockPromptStage.mockResolvedValue(stageResponse(5, 'Orange', ORANGE_PROMPTS));
  mockPromptHistory.mockResolvedValue(history([]));
});

describe('the Journal shelf shows a whole stage of prompts, each with its cadence', () => {
  it('renders every prompt of the stage in curriculum order, not one undifferentiated question', async () => {
    const { findByTestId, getAllByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-stage-prompts');

    const ordinals = getAllByTestId(/^journal-stage-prompt-\d+$/).map(
      (node) => node.props.testID as string,
    );
    expect(ordinals).toEqual([
      'journal-stage-prompt-1',
      'journal-stage-prompt-2',
      'journal-stage-prompt-3',
      'journal-stage-prompt-4',
    ]);
  });

  it('reads the stage from the API for the reader’s current stage', async () => {
    const { findByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-stage-prompts');
    expect(mockPromptStage).toHaveBeenCalledWith(5);
  });

  it('says how often each prompt is meant to be written', async () => {
    const { findByText, getByText } = render(<JournalShelfScreen />);
    expect(await findByText('Make a List of 25 Curiosities')).toBeTruthy();
    expect(getByText('Build to 25 across four sittings')).toBeTruthy();
    expect(getByText('One combination per sitting')).toBeTruthy();
  });

  it('renders nothing where a prompt carries no cadence rather than inventing one', async () => {
    const { findByTestId } = render(<JournalShelfScreen />);
    const card = await findByTestId('journal-stage-prompt-4');
    expect(within(card).queryByTestId('journal-stage-prompt-cadence-4')).toBeNull();
    expect(within(card).getByText('Formulate Your Answer as a Four Quadrant Vow')).toBeTruthy();
  });

  it('renders a three-prompt stage without padding it to four', async () => {
    mockPromptStage.mockResolvedValue(stageResponse(1, 'Beige', BEIGE_PROMPTS));
    mockPromptCurrent.mockResolvedValue({
      week_number: 2,
      question: 'What did you notice this week?',
      has_responded: false,
      response: null,
      timestamp: null,
      prompt_ordinal: 1,
    });
    const { findByTestId, getAllByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-stage-prompts');
    expect(getAllByTestId(/^journal-stage-prompt-\d+$/)).toHaveLength(3);
    expect(mockPromptStage).toHaveBeenCalledWith(1);
  });

  it('opens the tapped prompt — not the week’s default — with its own title and ordinal', async () => {
    const { findByTestId } = render(<JournalShelfScreen />);
    fireEvent.press(await findByTestId('journal-stage-prompt-3'));
    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', {
      weekNumber: 14,
      promptOrdinal: 3,
      promptQuestion: 'Which curiosity serves which problem?',
      prefillTitle: 'Combine Curiosities in Service of One Problem',
    });
  });

  it('marks the answered prompts and keeps the unanswered ones on the shelf', async () => {
    mockPromptHistory.mockResolvedValue(history([answered(13, 1), answered(14, 2)]));
    const { findByTestId, getAllByTestId, queryByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-stage-prompts');

    // Answering two of four hides neither the set nor the other two.
    expect(getAllByTestId(/^journal-stage-prompt-\d+$/)).toHaveLength(4);
    expect(await findByTestId('journal-stage-prompt-answered-1')).toBeTruthy();
    expect(queryByTestId('journal-stage-prompt-answered-2')).not.toBeNull();
    expect(queryByTestId('journal-stage-prompt-answered-3')).toBeNull();
    expect(queryByTestId('journal-stage-prompt-answered-4')).toBeNull();
  });

  it('does not credit a prompt answered in a different stage', async () => {
    // Week 5 is stage 2; its ordinal 3 must not mark stage 5's third prompt.
    mockPromptHistory.mockResolvedValue(history([answered(5, 3)]));
    const { findByTestId, queryByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-stage-prompts');
    expect(queryByTestId('journal-stage-prompt-answered-3')).toBeNull();
  });

  it('keeps the whole set on the shelf once every prompt has been answered', async () => {
    mockPromptHistory.mockResolvedValue(
      history([answered(13, 1), answered(14, 2), answered(15, 3), answered(15, 4)]),
    );
    const { findByTestId, getAllByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-stage-prompts');
    expect(getAllByTestId(/^journal-stage-prompt-\d+$/)).toHaveLength(4);
    expect(getAllByTestId(/^journal-stage-prompt-answered-\d+$/)).toHaveLength(4);
  });

  it('renders the shelf without the prompt section when the stage fetch fails', async () => {
    mockPromptStage.mockRejectedValue(new Error('offline'));
    const { findByTestId, queryByTestId } = render(<JournalShelfScreen />);
    expect(await findByTestId('journal-shelf')).toBeTruthy();
    expect(queryByTestId('journal-stage-prompts')).toBeNull();
  });

  it('still shows the prompts when only the response history fails to load', async () => {
    mockPromptHistory.mockRejectedValue(new Error('offline'));
    const { findByTestId, getAllByTestId, queryByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-stage-prompts');
    expect(getAllByTestId(/^journal-stage-prompt-\d+$/)).toHaveLength(4);
    expect(queryByTestId('journal-stage-prompt-answered-1')).toBeNull();
  });

  it('renders no prompt section for a stage that carries no prompts', async () => {
    mockPromptStage.mockResolvedValue(stageResponse(5, 'Orange', []));
    const { findByTestId, queryByTestId } = render(<JournalShelfScreen />);
    expect(await findByTestId('journal-shelf')).toBeTruthy();
    expect(queryByTestId('journal-stage-prompts')).toBeNull();
  });
});
