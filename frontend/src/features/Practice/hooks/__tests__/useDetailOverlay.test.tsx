/* eslint-env jest */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

// jest.mock below is hoisted above this import, so the hook sees the stub.
import { useDetailOverlay } from '../useDetailOverlay';

import type { PracticeTab } from '@/features/Practice/components/PracticeCatalogSwitcher';
import type { CustomizeCopyParams } from '@/features/Practice/screens/PracticeDetailScreen';

const mockNavigate = jest.fn<(route: string, params?: unknown) => void>();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const PREFILL: CustomizeCopyParams = {
  prefill: {
    config: { mode: 'meditation_timer', duration_minutes: 10 },
    name: 'Breath Awareness',
    description: 'd',
    instructions: 'i',
    duration: 10,
    stageNumber: 1,
  },
};

function renderOverlay(initialTab: PracticeTab = 'catalog') {
  const onCatalogActivated = jest.fn<() => void>();
  const view = renderHook(
    ({ tab }: { tab: PracticeTab }) => useDetailOverlay(tab, onCatalogActivated),
    {
      initialProps: { tab: initialTab },
    },
  );
  return { ...view, onCatalogActivated };
}

describe('useDetailOverlay', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
  });

  it('opens and closes on the practice it was given, keeping the opener for focus return', () => {
    const { result } = renderOverlay();
    const opener = { focus: jest.fn() };
    result.current.openerRef.current = opener;

    act(() => result.current.openDetail(7));
    expect(result.current.practiceId).toBe(7);

    act(() => result.current.closeDetail());
    expect(result.current.practiceId).toBeNull();
    // A plain dismiss leaves the opener in place for the sheet to focus.
    expect(result.current.openerRef.current).toBe(opener);
  });

  it('an activation closes the overlay, forgets the opener, and flips exactly once', () => {
    const { result, onCatalogActivated } = renderOverlay();
    result.current.openerRef.current = { focus: jest.fn() };
    act(() => result.current.openDetail(7));

    act(() => result.current.onActivated());

    expect(result.current.practiceId).toBeNull();
    expect(result.current.openerRef.current).toBeNull();
    expect(onCatalogActivated).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('"Duplicate & edit" closes the overlay, forgets the opener, and opens the wizard', () => {
    const { result, onCatalogActivated } = renderOverlay();
    result.current.openerRef.current = { focus: jest.fn() };
    act(() => result.current.openDetail(7));

    act(() => result.current.onCustomizeCopy(PREFILL));

    expect(result.current.practiceId).toBeNull();
    expect(result.current.openerRef.current).toBeNull();
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('CreatePractice', PREFILL);
    expect(onCatalogActivated).not.toHaveBeenCalled();
  });

  it('leaving the Catalog tab closes the overlay and forgets the opener', () => {
    const { result, rerender, onCatalogActivated } = renderOverlay();
    result.current.openerRef.current = { focus: jest.fn() };
    act(() => result.current.openDetail(7));

    rerender({ tab: 'practice' });

    expect(result.current.practiceId).toBeNull();
    expect(result.current.openerRef.current).toBeNull();
    // Closing because the tab moved is not an activation.
    expect(onCatalogActivated).not.toHaveBeenCalled();

    rerender({ tab: 'catalog' });
    expect(result.current.practiceId).toBeNull();
  });

  it('keeps an open overlay across re-renders on the Catalog tab', () => {
    const { result, rerender } = renderOverlay();
    act(() => result.current.openDetail(7));
    rerender({ tab: 'catalog' });
    expect(result.current.practiceId).toBe(7);
  });
});
