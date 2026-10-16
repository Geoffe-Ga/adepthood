/* eslint-env jest */
// #3343: the Course tab stays mounted while the re-auth sheet signs a
// different account in. The switch resets the Start Here store, but the
// stage loader only re-ran on a route-stage or program-anchor change, so with
// equal (here: null) anchors the incoming account sat on an empty Start Here
// surface until the screen remounted. These specs drive that mounted A-to-B
// transition in the order AuthContext really performs it -- credential
// cleared, durable scope wiped and moved, then the incoming token committed --
// and never remount the screen.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import type { CourseProgress, SiteResource, Stage } from '../../../api';
import { useProgramStore } from '../../../store/useProgramStore';
import { useStartHereStore } from '../startHereStore';

import * as userScope from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';
import { settle } from '@/testing/asyncSettle';

const TOKEN_A = 'e30.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature';
const TOKEN_A_RENEWED = 'e30.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAxfQ.signature';
const TOKEN_B = 'e30.eyJzdWIiOiIyIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature';
const USER_A = 1;
const USER_B = 2;

// One credential, read by both the HTTP layer (captureSessionToken) and React
// (useAuth), exactly as AuthProvider's tokenRef and token state share one value.
let mockToken: string | null = TOKEN_A;
const mockTokenListeners = new Set<() => void>();
function commitToken(next: string | null): void {
  mockToken = next;
  mockTokenListeners.forEach((listener) => listener());
}

jest.mock('@/context/AuthContext', () => {
  const ReactMod = require('react');
  return {
    useAuth: () => ({
      token: ReactMod.useSyncExternalStore(
        (listener: () => void) => {
          mockTokenListeners.add(listener);
          return () => mockTokenListeners.delete(listener);
        },
        () => mockToken,
      ),
    }),
  };
});

const makeStage = (stageNumber: number): Stage => ({
  id: stageNumber,
  title: `Stage ${stageNumber}`,
  subtitle: '',
  stage_number: stageNumber,
  overview_url: 'https://example.com',
  category: 'foundation',
  aspect: 'body',
  spiral_dynamics_color: 'Beige',
  growing_up_stage: 'Archaic',
  divine_gender_polarity: 'neutral',
  relationship_to_free_will: 'reactive',
  free_will_description: '',
  is_unlocked: true,
  progress: 0,
});
const stagesList: Stage[] = [makeStage(1), makeStage(2)];

const resource = (slug: string, title: string, order: number): SiteResource => ({
  slug,
  title,
  description: '',
  url: `content://${slug}`,
  order,
  is_read: false,
});
const unread = (total: number): CourseProgress => ({
  total_items: total,
  read_items: 0,
  progress_percent: 0,
  next_unlock_day: null,
});
const RESOURCES: Record<string, SiteResource[]> = {
  [TOKEN_A]: [resource('a-philosophy', 'Account A Philosophy', 1)],
  [TOKEN_A_RENEWED]: [resource('a-philosophy', 'Account A Philosophy', 1)],
  [TOKEN_B]: [resource('b-about', 'Account B About', 1), resource('b-faq', 'Account B FAQ', 2)],
};

const mockSiteResources = jest.fn((token: unknown) =>
  Promise.resolve(RESOURCES[String(token)] ?? []),
);
const mockStartHereProgress = jest.fn((token: unknown) =>
  Promise.resolve(unread((RESOURCES[String(token)] ?? []).length)),
);
const mockNextUnread = jest.fn((token: unknown) => {
  const first = RESOURCES[String(token)]?.[0];
  return Promise.resolve(
    first
      ? {
          kind: 'resource',
          slug: first.slug,
          content_id: null,
          stage_number: null,
          title: first.title,
        }
      : null,
  );
});
const mockStagesList = jest.fn((_token: unknown) => Promise.resolve(stagesList));

jest.mock('../../../api', () => ({
  captureSessionToken: () => mockToken ?? undefined,
  uiFlags: { get: () => Promise.resolve({ course_last_stage: null }) },
  stages: {
    listAll: (token: unknown) => mockStagesList(token),
    programCalendar: () =>
      Promise.resolve({
        program_started_at: null,
        calendar_stage: 1,
        calendar_week: 1,
        current_stage: 1,
        cycle_number: 1,
      }),
  },
  course: {
    // Answers for whichever credential is current at dispatch, as the real
    // default-token request does.
    nextUnread: () => mockNextUnread(mockToken),
    stageContentAll: () => Promise.resolve([]),
    stageProgress: () => Promise.resolve(unread(0)),
    markRead: jest.fn(),
    contentBody: jest.fn(),
    startHereProgress: (token: unknown) => mockStartHereProgress(token),
    siteResources: (token: unknown) => mockSiteResources(token),
    siteResourceBody: jest.fn(),
    stageIntro: () => Promise.reject(new Error('content_not_found')),
    stageIntroBody: jest.fn(),
  },
}));

let mockRouteParams: { stageNumber?: number } | undefined;
jest.mock('../../../navigation/hooks', () => ({
  useAppRoute: () => ({ key: 'Course-test', name: 'Course', params: mockRouteParams }),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => {
  const ReactMod = require('react');
  return {
    SafeAreaView: ({ children }: { children: unknown }) =>
      ReactMod.createElement(ReactMod.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// eslint-disable-next-line import/order
const { render, act, fireEvent } = require('@testing-library/react-native');
const CourseScreen = require('../CourseScreen').default;

/** The re-auth sheet signing `owner` in over the mounted tab (AuthContext order). */
async function signInOverMountedTab(owner: number, token: string): Promise<void> {
  await act(async () => {
    // clearTokenForReauth: the expired credential leaves React first.
    commitToken(null);
  });
  await act(async () => {
    // adoptDeviceOwner -> wipeUserState -> setActiveUser(incoming).
    userScope.beginActiveUserTransition();
    resetAllStores();
    userScope.setActiveUser(owner);
  });
  await act(async () => {
    // applyAuthResponse commits the incoming token only after it is on disk.
    commitToken(token);
  });
  await settle();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams = undefined;
  mockToken = TOKEN_A;
  userScope.setActiveUser(USER_A);
  useStartHereStore.getState().reset();
  // Both accounts share a null program anchor: the case the loader never saw.
  useProgramStore.setState({ programStartDate: null, programStartDay: null });
});

describe('CourseScreen — a mounted account switch reloads Start Here (#3343)', () => {
  it("loads the incoming account's resources and read marks without a remount", async () => {
    const view = render(<CourseScreen />);
    await settle();
    expect(view.getByTestId('start-here-resource-a-philosophy')).toBeTruthy();

    await signInOverMountedTab(USER_B, TOKEN_B);

    expect(view.getByTestId('start-here-section')).toBeTruthy();
    expect(view.getByTestId('start-here-resource-b-about')).toBeTruthy();
    expect(view.getByTestId('start-here-resource-b-faq')).toBeTruthy();
    expect(view.getByText('0 of 2 read')).toBeTruthy();
    expect(view.queryByTestId('start-here-resource-a-philosophy')).toBeNull();
    expect(mockSiteResources).toHaveBeenLastCalledWith(TOKEN_B);
    expect(mockStartHereProgress).toHaveBeenLastCalledWith(TOKEN_B);
  });

  it("re-asks Read next for the incoming account instead of keeping account A's answer", async () => {
    const view = render(<CourseScreen />);
    await settle();
    expect(view.getByTestId('read-next').props.accessibilityLabel).toBe(
      'Read next: Account A Philosophy',
    );

    await signInOverMountedTab(USER_B, TOKEN_B);

    expect(view.getByTestId('read-next').props.accessibilityLabel).toBe(
      'Read next: Account B About',
    );
  });

  it('never lets a held account A Read next answer reach the incoming account', async () => {
    let releaseA!: (_target: null) => void;
    mockNextUnread.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseA = resolve;
        }),
    );
    const view = render(<CourseScreen />);
    await settle();

    await signInOverMountedTab(USER_B, TOKEN_B);
    await act(async () => releaseA(null));
    await settle();

    expect(view.getByTestId('read-next').props.accessibilityLabel).toBe(
      'Read next: Account B About',
    );
  });

  it("shows a truthful retry when the incoming account's resources fail, and retry loads them", async () => {
    const view = render(<CourseScreen />);
    await settle();
    mockSiteResources.mockImplementationOnce(() => Promise.reject(new Error('offline')));

    await signInOverMountedTab(USER_B, TOKEN_B);

    // Which surface carries the failure is #3344's concern; here it must be
    // an error with a retry, never a silently empty landing.
    expect(view.queryByTestId('start-here-resource-b-about')).toBeNull();
    expect(view.queryByTestId('course-loading')).toBeNull();
    fireEvent.press(view.getByText('Try again'));
    await settle();
    expect(view.getByTestId('start-here-resource-b-about')).toBeTruthy();
  });

  it("never lets a held account A answer populate the incoming account's Start Here", async () => {
    const view = render(<CourseScreen />);
    await settle();
    let releaseA!: (_resources: SiteResource[]) => void;
    mockSiteResources.mockImplementationOnce(
      () =>
        new Promise<SiteResource[]>((resolve) => {
          releaseA = resolve;
        }),
    );
    // A's own forced reload is in flight when the switch begins.
    act(() => {
      void useStartHereStore.getState().load(true);
    });

    await signInOverMountedTab(USER_B, TOKEN_B);
    await act(async () => releaseA([resource('a-held', 'Held A', 1)]));
    await settle();

    expect(view.queryByTestId('start-here-resource-a-held')).toBeNull();
    expect(view.getByTestId('start-here-resource-b-about')).toBeTruthy();
  });

  it('reloads the returning account after an A-to-B-to-A switch without leaking B', async () => {
    const view = render(<CourseScreen />);
    await settle();
    await signInOverMountedTab(USER_B, TOKEN_B);
    expect(view.getByTestId('start-here-resource-b-about')).toBeTruthy();

    await signInOverMountedTab(USER_A, TOKEN_A);

    expect(view.getByTestId('start-here-resource-a-philosophy')).toBeTruthy();
    expect(view.queryByTestId('start-here-resource-b-about')).toBeNull();
  });

  it('keeps an explicit Frequency route across the switch while loading B in the background', async () => {
    mockRouteParams = { stageNumber: 2 };
    const view = render(<CourseScreen />);
    await settle();
    expect(view.getByTestId('stage-pill-2').props.accessibilityState.selected).toBe(true);

    await signInOverMountedTab(USER_B, TOKEN_B);

    expect(view.getByTestId('stage-pill-2').props.accessibilityState.selected).toBe(true);
    expect(view.queryByTestId('start-here-section')).toBeNull();
    expect(mockSiteResources).toHaveBeenLastCalledWith(TOKEN_B);
    expect(useStartHereStore.getState().status).toBe('ready');
  });

  it('does not reload anything on a same-session credential renewal', async () => {
    const view = render(<CourseScreen />);
    await settle();
    const stageReads = mockStagesList.mock.calls.length;
    const resourceReads = mockSiteResources.mock.calls.length;
    const nextReads = mockNextUnread.mock.calls.length;

    await act(async () => commitToken(TOKEN_A_RENEWED));
    await settle();

    expect(mockStagesList).toHaveBeenCalledTimes(stageReads);
    expect(mockSiteResources).toHaveBeenCalledTimes(resourceReads);
    expect(mockNextUnread).toHaveBeenCalledTimes(nextReads);
    expect(view.getByTestId('start-here-resource-a-philosophy')).toBeTruthy();
  });
});
