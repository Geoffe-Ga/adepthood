/* eslint-env jest */
/**
 * ``useNotificationCount`` (#3142): the number the Journal home's
 * "Notifications" button carries. A count of items waiting, nothing more — the
 * due Return card (0/1), the invitations still on offer in rings the writer
 * kept, the stage prompts not set aside, and the voice band (0/1). The stat
 * tiles are counters, not items, and never count.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { countNotifications, useNotificationCount } from '../useNotificationCount';

import type { Invitation, StagePromptsResponse } from '@/api';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

interface ReturnShape {
  arc: { complete: boolean } | null;
  offerVisible: boolean;
  releasedHabits: { habit_id: number; recommitted: boolean }[];
}

const mockReturn = jest.fn<(_options: { enabled: boolean; refreshKey: number }) => ReturnShape>();
const mockInvitations = jest.fn<(_refreshKey: number) => { invitations: Invitation[] }>();
const mockStagePrompts = jest.fn<() => { stage: StagePromptsResponse | null }>();
const mockVoice = jest.fn<(_refreshKey: number) => object | null>();
let mockFocusCallbacks: (() => void)[] = [];

let mockWritingPrompt = false;
let mockEarlyDismissed: boolean | null = true;
jest.mock('../useEarlyReviewDismissal', () => ({
  useEarlyReviewDismissal: () => ({ dismissed: mockEarlyDismissed }),
}));
jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ userTimezone: 'UTC' }) }));
jest.mock('../useDueReview', () => ({
  useDueReview: () => ({ status: 'settled', review: mockWritingPrompt ? {} : null }),
}));
jest.mock('../MorningPagesTip', () => ({ useMorningPagesTipState: () => ({ state: null }) }));

jest.mock('@react-navigation/native', () => ({
  // Keyed on the callback, the way React Navigation re-runs a focus effect; the
  // callback is kept so a test can simulate the screen regaining focus.
  useFocusEffect: (cb: () => void) => {
    const react = jest.requireActual('react') as {
      useEffect: (_f: () => void, _deps: unknown[]) => void;
    };
    react.useEffect(() => {
      mockFocusCallbacks.push(cb);
      cb();
    }, [cb]);
  },
}));

jest.mock('@/features/Return/useMettaReturn', () => ({
  useMettaReturn: (options: { enabled: boolean; refreshKey: number }) => mockReturn(options),
}));
jest.mock('@/features/Invitations/useInvitations', () => ({
  useInvitations: (refreshKey: number) => mockInvitations(refreshKey),
}));
jest.mock('../StagePromptSection', () => {
  const actual = jest.requireActual('../StagePromptSection') as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    useStagePromptPlace: () => ({ week: 9, stage: 3 }),
    useStagePrompts: () => mockStagePrompts(),
  };
});
jest.mock('../VoiceReadinessBand', () => ({
  __esModule: true,
  default: () => null,
  useVoiceReadinessState: (refreshKey: number) => ({ band: mockVoice(refreshKey) }),
}));

const IDLE_RETURN: ReturnShape = { arc: null, offerVisible: false, releasedHabits: [] };

function invitation(id: number, target: Invitation['target_type']): Invitation {
  return {
    id,
    target_type: target,
    reading:
      target === 'course'
        ? {
            content_id: 24,
            stage_number: 2,
            title: 'A reading',
            entry_id: 8,
            entry_title: null,
            quote: 'A journal passage',
            reason: 'A specific connection',
            benefit: 'An exercise',
          }
        : null,
  } as Invitation;
}

function stageWith(dismissed: boolean[]): StagePromptsResponse {
  return {
    stage: 3,
    stage_name: 'Red',
    prompts: dismissed.map((d, i) => ({
      ordinal: i + 1,
      title: `Prompt ${i + 1}`,
      body: 'Body',
      cadence: null,
      dismissed: d,
    })),
  } as StagePromptsResponse;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWritingPrompt = false;
  mockEarlyDismissed = true;
  mockFocusCallbacks = [];
  useDepthPreferencesStore.setState({
    enable_habits: true,
    enable_practices: true,
    enable_course: true,
    enable_sangha: true,
  });
  mockReturn.mockReturnValue(IDLE_RETURN);
  mockInvitations.mockReturnValue({ invitations: [] });
  mockStagePrompts.mockReturnValue({ stage: null });
  mockVoice.mockReturnValue(null);
});

describe('countNotifications', () => {
  it('is zero when nothing is waiting', () => {
    expect(
      countNotifications({ returnDue: false, invitations: 0, stagePrompts: 0, voiceBand: false }),
    ).toBe(0);
  });

  it('adds one for a due Return card and one for the voice band', () => {
    expect(
      countNotifications({ returnDue: true, invitations: 0, stagePrompts: 0, voiceBand: true }),
    ).toBe(2);
  });

  it('adds every invitation and every offered stage prompt', () => {
    expect(
      countNotifications({ returnDue: true, invitations: 2, stagePrompts: 3, voiceBand: false }),
    ).toBe(6);
  });
});

describe('useNotificationCount', () => {
  it('counts nothing on a quiet account', () => {
    const { result } = renderHook(() => useNotificationCount());
    expect(result.current).toBe(0);
  });

  it('sums the Return card, invitations, offered prompts and the voice band', () => {
    mockReturn.mockReturnValue({ ...IDLE_RETURN, offerVisible: true });
    mockInvitations.mockReturnValue({
      invitations: [invitation(1, 'habit'), invitation(2, 'course')],
    });
    mockStagePrompts.mockReturnValue({ stage: stageWith([false, true, false, false]) });
    mockVoice.mockReturnValue({ message: 'Early days', destination: 'SeedCorpus' });

    const { result } = renderHook(() => useNotificationCount());

    // 1 Return + 2 invitations + 3 prompts not set aside + 1 voice band.
    expect(result.current).toBe(7);
  });

  it('counts a running arc or a resting habit as the one Return card', () => {
    mockReturn.mockReturnValue({ ...IDLE_RETURN, arc: { complete: false } });
    expect(renderHook(() => useNotificationCount()).result.current).toBe(1);

    mockReturn.mockReturnValue({
      ...IDLE_RETURN,
      offerVisible: true,
      releasedHabits: [{ habit_id: 4, recommitted: false }],
    });
    expect(renderHook(() => useNotificationCount()).result.current).toBe(1);
  });

  it('does not count a habit already recommitted', () => {
    mockReturn.mockReturnValue({
      ...IDLE_RETURN,
      releasedHabits: [{ habit_id: 4, recommitted: true }],
    });
    expect(renderHook(() => useNotificationCount()).result.current).toBe(0);
  });

  it('neither loads nor counts Return while the habits ring is declined', () => {
    useDepthPreferencesStore.setState({ enable_habits: false });
    mockReturn.mockReturnValue({ ...IDLE_RETURN, offerVisible: true });

    const { result } = renderHook(() => useNotificationCount());

    expect(result.current).toBe(0);
    expect(mockReturn).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('drops a declined ring’s invitations from the count', () => {
    useDepthPreferencesStore.setState({ enable_course: false });
    mockInvitations.mockReturnValue({
      invitations: [invitation(1, 'habit'), invitation(2, 'course')],
    });

    expect(renderHook(() => useNotificationCount()).result.current).toBe(1);
  });

  it('re-reads its sources each time the screen regains focus, not on first focus', () => {
    renderHook(() => useNotificationCount());
    expect(mockInvitations).toHaveBeenLastCalledWith(0);
    expect(mockVoice).toHaveBeenLastCalledWith(0);
    expect(mockReturn).toHaveBeenLastCalledWith(expect.objectContaining({ refreshKey: 0 }));

    act(() => {
      mockFocusCallbacks[0]?.();
    });

    expect(mockInvitations).toHaveBeenLastCalledWith(1);
    expect(mockVoice).toHaveBeenLastCalledWith(1);
    expect(mockReturn).toHaveBeenLastCalledWith(expect.objectContaining({ refreshKey: 1 }));
  });
});

it('counts the active writing invitation and excludes recovered/set-aside cards', () => {
  mockWritingPrompt = true;
  expect(renderHook(() => useNotificationCount()).result.current).toBe(1);
});

it('counts the early-review invitation only while it is offered', () => {
  mockEarlyDismissed = false;
  const { result, rerender } = renderHook(() => useNotificationCount());
  expect(result.current).toBe(1);
  mockEarlyDismissed = true;
  rerender({});
  expect(result.current).toBe(0);
  mockEarlyDismissed = null;
  rerender({});
  expect(result.current).toBe(0);
});
