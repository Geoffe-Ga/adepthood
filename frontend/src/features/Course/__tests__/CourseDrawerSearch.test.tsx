/* eslint-env jest */
// Fuzzy chapter-title search inside the Course drawer, plus its confirm-gated
// body (chapter text) search: a debounced DrawerSearch field filters each
// loaded stage's chapters while a query is active, offers a deep-search
// confirm row whenever a query is active, and pressing that row sweeps every
// unlocked, loaded, uncached chapter's body text into the match.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React, { useState } from 'react';
import { TouchableOpacity, View } from 'react-native';

import type { ContentBody, ContentItem, Stage } from '../../../api';

const DEEP_SEARCH_LABEL = 'Search inside chapters? This downloads chapter text.';
const DEBOUNCE_MS = 300;

const mockStageContent = jest.fn<(stageNumber: number, token?: string) => Promise<ContentItem[]>>();
const mockContentBody = jest.fn<(contentId: number, token?: string) => Promise<ContentBody>>();

jest.mock('../../../api', () => ({
  course: {
    stageContentAll: (stageNumber: number) => mockStageContent(stageNumber),
    contentBody: (contentId: number) => mockContentBody(contentId),
  },
}));

// These modules are required after the jest.mock call above so the mock is in
// place before the module-under-test loads.
const {
  default: CourseDrawer,
  useCourseDrawerContent,
  useCourseDrawerBodies,
} = require('../CourseDrawer');

const makeStage = (overrides: Partial<Stage> = {}): Stage => ({
  id: 1,
  title: 'Stage',
  subtitle: 'Subtitle',
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

const chapterItem = (
  id: number,
  title: string,
  overrides: Partial<ContentItem> = {},
): ContentItem => ({
  id,
  title,
  content_type: 'chapter',
  release_day: 0,
  url: null,
  is_locked: false,
  is_read: false,
  ...overrides,
});

type GetByTestId = ReturnType<typeof render>['getByTestId'];

/** Type a query into the drawer search field and flush its 300ms debounce. */
async function typeQuery(getByTestId: GetByTestId, query: string): Promise<void> {
  await act(async () => {
    fireEvent.changeText(getByTestId('drawer-search-input'), query);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

// Three loaded, unlocked stages with distinct titles. Stage 1 also carries a
// locked chapter (title-matchable but never a body-search target) and an
// unlocked chapter with no title match, used by the body-only-match tests.
const STAGES: Stage[] = [
  makeStage({ id: 1, stage_number: 1, title: 'Stage One' }),
  makeStage({ id: 2, stage_number: 2, title: 'Stage Two' }),
  makeStage({ id: 3, stage_number: 3, title: 'Stage Three' }),
];

const SECTIONS = {
  1: {
    status: 'loaded' as const,
    items: [
      chapterItem(101, 'Gratitude Practice'),
      chapterItem(102, 'Deep Focus', { is_locked: true }),
      chapterItem(103, 'Unrelated Notes'),
    ],
  },
  2: {
    status: 'loaded' as const,
    items: [chapterItem(201, 'Morning Pages')],
  },
  3: {
    status: 'loaded' as const,
    items: [chapterItem(301, 'Gratitude Journal')],
  },
};

interface DrawerHarnessProps {
  sections: typeof SECTIONS;
  bodies: Readonly<Record<number, string>>;
  sweepStatus: 'idle' | 'loading' | 'error';
  onConfirmBodySearch?: () => void;
}

function renderDrawer(props: Partial<DrawerHarnessProps> = {}) {
  const onConfirmBodySearch = props.onConfirmBodySearch ?? jest.fn();
  const result = render(
    <CourseDrawer
      stages={STAGES}
      selectedStage={1}
      sections={props.sections ?? SECTIONS}
      bodies={props.bodies ?? {}}
      sweepStatus={props.sweepStatus ?? 'idle'}
      onChapterPress={jest.fn()}
      onRetry={jest.fn()}
      onConfirmBodySearch={onConfirmBodySearch}
    />,
  );
  return { ...result, onConfirmBodySearch };
}

describe('CourseDrawer search field placement and identity', () => {
  it('renders the search field at the top of the drawer, above the first stage header', () => {
    const { getAllByTestId } = renderDrawer();
    const ids = getAllByTestId(/^(course-drawer-search|course-drawer-stage-\d+)$/).map(
      (n) => n.props.testID as string,
    );
    expect(ids[0]).toBe('course-drawer-search');
    expect(ids[1]).toBe('course-drawer-stage-1');
  });

  it('uses the course-specific placeholder and accessibility label', () => {
    const { getByTestId } = renderDrawer();
    const input = getByTestId('drawer-search-input');
    expect(input.props.placeholder).toBe('Search chapters...');
    expect(input.props.accessibilityLabel).toBe('Search chapters');
  });
});

describe('CourseDrawer fuzzy title search', () => {
  it('keeps matching stage headers and chapters, and collapses a stage with no title match', async () => {
    const { getByTestId, queryByTestId } = renderDrawer();

    await typeQuery(getByTestId, 'gratitude');

    expect(getByTestId('course-drawer-stage-1')).toBeTruthy();
    expect(getByTestId('course-drawer-chapter-101')).toBeTruthy();
    expect(getByTestId('course-drawer-stage-3')).toBeTruthy();
    expect(getByTestId('course-drawer-chapter-301')).toBeTruthy();

    expect(queryByTestId('course-drawer-stage-2')).toBeNull();
    expect(queryByTestId('course-drawer-chapter-201')).toBeNull();
  });

  it('matches a title with a one-character typo', async () => {
    const { getByTestId } = renderDrawer();

    await typeQuery(getByTestId, 'gratitde');

    expect(getByTestId('course-drawer-chapter-101')).toBeTruthy();
  });

  it('shows the singular result caption for exactly one title match', async () => {
    const { getByTestId } = renderDrawer();

    await typeQuery(getByTestId, 'journal');

    expect(getByTestId('drawer-search-result-count')).toHaveTextContent('1 result');
  });

  it('shows the plural result caption for multiple title matches', async () => {
    const { getByTestId } = renderDrawer();

    await typeQuery(getByTestId, 'gratitude');

    expect(getByTestId('drawer-search-result-count')).toHaveTextContent('2 results');
  });

  it('shows "No results" when nothing matches by title', async () => {
    const { getByTestId } = renderDrawer();

    await typeQuery(getByTestId, 'xylophone');

    expect(getByTestId('drawer-search-result-count')).toHaveTextContent('No results');
  });

  it('restores every stage section and hides the caption once the query is cleared', async () => {
    const { getByTestId, queryByTestId } = renderDrawer();

    await typeQuery(getByTestId, 'gratitude');
    expect(queryByTestId('course-drawer-stage-2')).toBeNull();

    await typeQuery(getByTestId, '');

    expect(getByTestId('course-drawer-stage-1')).toBeTruthy();
    expect(getByTestId('course-drawer-stage-2')).toBeTruthy();
    expect(getByTestId('course-drawer-stage-3')).toBeTruthy();
    expect(queryByTestId('drawer-search-result-count')).toBeNull();
  });

  it('renders a locked chapter whose title matches, still disabled and never a body-search target', async () => {
    const { getByTestId } = renderDrawer();

    await typeQuery(getByTestId, 'focus');

    const row = getByTestId('course-drawer-chapter-102');
    expect(row).toBeTruthy();
    expect(row.props.accessibilityState.disabled).toBe(true);
  });
});

describe('CourseDrawer confirm-gated body search', () => {
  it('offers the deep-search confirm row with the exact copy while a query is active, and removes it once confirmed', async () => {
    const { getByTestId, queryByTestId, getByText, onConfirmBodySearch } = renderDrawer();

    await typeQuery(getByTestId, 'gratitude');

    expect(getByTestId('drawer-search-deep-search')).toBeTruthy();
    expect(getByText(DEEP_SEARCH_LABEL)).toBeTruthy();

    fireEvent.press(getByTestId('drawer-search-deep-search'));

    expect(onConfirmBodySearch).toHaveBeenCalledTimes(1);
    expect(queryByTestId('drawer-search-deep-search')).toBeNull();
  });

  it('reveals a body-only match after the deep-search row is confirmed', async () => {
    const { getByTestId, queryByTestId } = renderDrawer({
      bodies: { 103: 'a hidden lighthouse keeps watch' },
    });

    await typeQuery(getByTestId, 'lighthouse');
    expect(queryByTestId('course-drawer-chapter-103')).toBeNull();

    fireEvent.press(getByTestId('drawer-search-deep-search'));

    expect(getByTestId('course-drawer-chapter-103')).toBeTruthy();
  });

  it('shows the loading indicator once body search is active and the sweep is loading', async () => {
    const { getByTestId } = renderDrawer({ sweepStatus: 'loading' });

    await typeQuery(getByTestId, 'gratitude');
    fireEvent.press(getByTestId('drawer-search-deep-search'));

    expect(getByTestId('course-drawer-search-loading')).toBeTruthy();
  });

  it('shows the error row with a retry once body search is active and the sweep failed, and retry re-invokes the confirm handler', async () => {
    const { getByTestId, onConfirmBodySearch } = renderDrawer({ sweepStatus: 'error' });

    await typeQuery(getByTestId, 'gratitude');
    fireEvent.press(getByTestId('drawer-search-deep-search'));

    expect(getByTestId('course-drawer-search-error')).toBeTruthy();
    expect(getByTestId('course-drawer-search-retry')).toBeTruthy();

    fireEvent.press(getByTestId('course-drawer-search-retry'));

    expect(onConfirmBodySearch).toHaveBeenCalledTimes(2);
  });
});

// Wiring: the hook drives the confirm-gated sequential sweep of every
// unlocked, loaded, uncached chapter's body, mounted the same way the
// presentational-harness tests above mount it (isOpen gates the panel), so
// the cache/sweep semantics are exercised end-to-end without navigation.
const WIRING_STAGES: Stage[] = [
  makeStage({ id: 1, stage_number: 1, title: 'Stage One' }),
  makeStage({ id: 2, stage_number: 2, title: 'Stage Two' }),
];

function Harness(): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const { sections } = useCourseDrawerContent(WIRING_STAGES, isOpen);
  const { bodies, status, confirmBodySearch } = useCourseDrawerBodies(sections);
  return (
    <View>
      <TouchableOpacity testID="harness-open" onPress={() => setIsOpen(true)} />
      {isOpen ? (
        <CourseDrawer
          stages={WIRING_STAGES}
          selectedStage={1}
          sections={sections}
          bodies={bodies}
          sweepStatus={status}
          onChapterPress={() => undefined}
          onRetry={() => undefined}
          onConfirmBodySearch={confirmBodySearch}
        />
      ) : null}
    </View>
  );
}

async function openHarness(getByTestId: GetByTestId): Promise<void> {
  await act(async () => {
    fireEvent.press(getByTestId('harness-open'));
    await jest.advanceTimersByTimeAsync(0);
  });
}

/** A resolved body payload with the given markdown text. */
function bodyOf(markdown: string): ContentBody {
  return { title: 'Chapter', content_type: 'chapter', body_markdown: markdown };
}

describe('useCourseDrawerBodies confirm-gated body search (wiring)', () => {
  beforeEach(() => {
    mockStageContent.mockReset();
    mockContentBody.mockReset();
    mockStageContent.mockImplementation((stageNumber: number) => {
      if (stageNumber === 1) {
        return Promise.resolve([
          chapterItem(11, 'Alpha Notes'),
          chapterItem(12, 'Locked Notes', { is_locked: true }),
        ]);
      }
      return Promise.resolve([chapterItem(21, 'Gamma Notes')]);
    });
  });

  it('fetches no chapter body while the user is only typing a title query', async () => {
    mockContentBody.mockResolvedValue(bodyOf('irrelevant'));
    const { getByTestId } = render(<Harness />);
    await openHarness(getByTestId);

    await typeQuery(getByTestId, 'alpha');

    expect(mockContentBody).not.toHaveBeenCalled();
  });

  it('fetches only unlocked, loaded chapters on confirm, sequentially and never the locked one', async () => {
    mockContentBody.mockResolvedValue(bodyOf('irrelevant'));
    const { getByTestId } = render(<Harness />);
    await openHarness(getByTestId);
    await typeQuery(getByTestId, 'lighthouse');

    await act(async () => {
      fireEvent.press(getByTestId('drawer-search-deep-search'));
      await jest.advanceTimersByTimeAsync(0);
    });

    const ids = mockContentBody.mock.calls.map((call) => call[0]);
    expect(ids).toEqual([11, 21]);
  });

  it('reveals a body-only match once the sweep resolves', async () => {
    mockContentBody.mockImplementation((contentId: number) =>
      Promise.resolve(
        bodyOf(contentId === 21 ? 'a hidden lighthouse keeps watch' : 'nothing special here'),
      ),
    );
    const { getByTestId, queryByTestId } = render(<Harness />);
    await openHarness(getByTestId);
    await typeQuery(getByTestId, 'lighthouse');
    expect(queryByTestId('course-drawer-chapter-21')).toBeNull();

    await act(async () => {
      fireEvent.press(getByTestId('drawer-search-deep-search'));
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(getByTestId('course-drawer-chapter-21')).toBeTruthy();
    expect(queryByTestId('course-drawer-chapter-11')).toBeNull();
  });

  it('does not refetch already-cached ids on a second confirm', async () => {
    mockContentBody.mockImplementation((contentId: number) =>
      Promise.resolve(
        bodyOf(contentId === 21 ? 'a hidden lighthouse keeps watch' : 'nothing special here'),
      ),
    );
    const { getByTestId } = render(<Harness />);
    await openHarness(getByTestId);
    await typeQuery(getByTestId, 'lighthouse');

    await act(async () => {
      fireEvent.press(getByTestId('drawer-search-deep-search'));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(mockContentBody).toHaveBeenCalledTimes(2);

    await typeQuery(getByTestId, '');
    await typeQuery(getByTestId, 'lighthouse');

    await act(async () => {
      fireEvent.press(getByTestId('drawer-search-deep-search'));
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(mockContentBody).toHaveBeenCalledTimes(2);
  });

  it('shows the inline searching indicator while the sweep is still in flight, then clears once it settles', async () => {
    let resolveFirst: (_value: ContentBody) => void = () => undefined;
    const firstPending = new Promise<ContentBody>((resolve) => {
      resolveFirst = resolve;
    });
    mockContentBody.mockReturnValueOnce(firstPending);
    mockContentBody.mockResolvedValueOnce(bodyOf('irrelevant'));

    const { getByTestId, queryByTestId } = render(<Harness />);
    await openHarness(getByTestId);
    await typeQuery(getByTestId, 'lighthouse');

    await act(async () => {
      fireEvent.press(getByTestId('drawer-search-deep-search'));
      await jest.advanceTimersByTimeAsync(0);
    });

    // The first id's body has not settled: the sweep is sequential, so the
    // second id is not yet requested and the loading caption is visible.
    expect(mockContentBody).toHaveBeenCalledTimes(1);
    expect(getByTestId('course-drawer-search-loading')).toBeTruthy();

    await act(async () => {
      resolveFirst(bodyOf('irrelevant'));
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(queryByTestId('course-drawer-search-loading')).toBeNull();
  });

  it('surfaces a systemic failure when every attempted body fetch rejects, and retry recovers', async () => {
    mockContentBody.mockRejectedValueOnce(new Error('network down'));
    mockContentBody.mockRejectedValueOnce(new Error('network down'));

    const { getByTestId, queryByTestId } = render(<Harness />);
    await openHarness(getByTestId);
    await typeQuery(getByTestId, 'lighthouse');

    await act(async () => {
      fireEvent.press(getByTestId('drawer-search-deep-search'));
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(getByTestId('course-drawer-search-error')).toBeTruthy();
    expect(getByTestId('course-drawer-search-retry')).toBeTruthy();

    mockContentBody.mockReset();
    mockContentBody.mockImplementation((contentId: number) =>
      Promise.resolve(
        bodyOf(contentId === 21 ? 'a hidden lighthouse keeps watch' : 'nothing special here'),
      ),
    );

    await act(async () => {
      fireEvent.press(getByTestId('course-drawer-search-retry'));
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(queryByTestId('course-drawer-search-error')).toBeNull();
    expect(getByTestId('course-drawer-chapter-21')).toBeTruthy();
  });

  it('shows no error UI on a partial failure (one chapter rejects, one resolves)', async () => {
    mockContentBody.mockImplementation((contentId: number) => {
      if (contentId === 11) return Promise.reject(new Error('one chapter failed'));
      return Promise.resolve(bodyOf('a hidden lighthouse keeps watch'));
    });

    const { getByTestId, queryByTestId } = render(<Harness />);
    await openHarness(getByTestId);
    await typeQuery(getByTestId, 'lighthouse');

    await act(async () => {
      fireEvent.press(getByTestId('drawer-search-deep-search'));
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(queryByTestId('course-drawer-search-error')).toBeNull();
    expect(getByTestId('course-drawer-chapter-21')).toBeTruthy();
  });
});
