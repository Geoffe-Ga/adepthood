import { describe, expect, it } from '@jest/globals';
import { getPathFromState, getStateFromPath } from '@react-navigation/native';

import { MAX_STAGE, MIN_STAGE } from '@/features/Practice/constants';
import { tabParamsFromPath } from '@/navigation/__tests__/deepLinkTestKit';
import { linking } from '@/navigation/linking';

type StageTab = 'Practice' | 'Course';

const STAGE_TABS: ReadonlyArray<readonly [StageTab, string]> = [
  ['Practice', 'practice'],
  ['Course', 'course'],
];

const INVALID_STAGE_SEGMENTS = ['abc', String(MIN_STAGE - 1), String(MAX_STAGE + 1), '1.5'];

/** The route params a leaf tab gets for ``path``, read straight off the parsed state. */
function leafParams(path: string): { name?: string; params?: object } {
  const tabs = getStateFromPath(path, linking.config)?.routes[0];
  const leaf = tabs?.state?.routes[0];
  return { name: leaf?.name, params: leaf?.params };
}

/** Build the navigation state the Tabs navigator holds for one focused tab. */
function tabState(tab: StageTab, params: object) {
  return { routes: [{ name: 'Tabs', state: { routes: [{ name: tab, params }] } }] };
}

describe('stage deep links (#2958)', () => {
  it('parses the practice/:stageNumber deep link into a numeric stage', () => {
    const state = getStateFromPath('practice/1', linking.config);
    const tabs = state?.routes[0];
    const leaf = tabs?.state?.routes[0];
    expect(tabs?.name).toBe('Tabs');
    expect(leaf?.name).toBe('Practice');
    expect(leaf?.params).toEqual({ stageNumber: 1 });
  });

  it('parses the course/:stageNumber deep link into a numeric stage', () => {
    expect(leafParams('course/1')).toEqual({ name: 'Course', params: { stageNumber: 1 } });
  });

  describe.each(STAGE_TABS)('%s', (tab, segment) => {
    it.each(INVALID_STAGE_SEGMENTS)(`treats ${segment}/%s as no stage asked for`, (raw) => {
      const { name, params } = leafParams(`${segment}/${raw}`);
      const stageNumber = (params as { stageNumber?: unknown } | undefined)?.stageNumber;
      expect(name).toBe(tab);
      expect(stageNumber).toBeUndefined();
    });

    it('leaves the bare path without a stage', () => {
      const { name, params } = leafParams(segment);
      expect(name).toBe(tab);
      expect((params as { stageNumber?: unknown } | undefined)?.stageNumber).toBeUndefined();
    });

    it('round-trips a numeric stage through getPathFromState', () => {
      const path = getPathFromState(tabState(tab, { stageNumber: 3 }), linking.config);
      expect(path).toBe(`/${segment}/3`);
      expect(leafParams(path).params).toEqual({ stageNumber: 3 });
    });
  });

  it('parses the Course reading-restore query params into numbers', () => {
    expect(leafParams('course/2?contentId=5&scrollOffset=120').params).toEqual({
      stageNumber: 2,
      contentId: 5,
      scrollOffset: 120,
    });
  });

  it('drops malformed Course reading-restore query params', () => {
    const { params } = leafParams('course/2?contentId=0&scrollOffset=-1');
    expect(params).toEqual({ stageNumber: 2, contentId: undefined, scrollOffset: undefined });
  });
});

describe('string-by-design deep-link params', () => {
  it('keeps the share-link token a string', () => {
    const route = getStateFromPath('practices/share/abc', linking.config)?.routes[0];
    expect(route?.name).toBe('SharePreview');
    expect(route?.params).toEqual({ token: 'abc' });
  });

  it('keeps the reset-password token a string', () => {
    const route = getStateFromPath('reset-password?token=123', linking.config)?.routes[0];
    expect(route?.name).toBe('ResetPassword');
    expect(route?.params).toEqual({ token: '123' });
  });
});

describe('tabParamsFromPath', () => {
  it('returns the params the linking config delivers to the tab', () => {
    expect(tabParamsFromPath('practice/2', 'Practice')).toEqual({ stageNumber: 2 });
  });

  it('throws when the path lands on a different tab', () => {
    expect(() => tabParamsFromPath('journal', 'Practice')).toThrow(
      "deep link 'journal' resolved to 'Journal', not the Practice tab",
    );
  });

  it('throws when the path lands outside the tabs', () => {
    expect(() => tabParamsFromPath('settings', 'Practice')).toThrow(
      "deep link 'settings' resolved to 'Settings', not the Practice tab",
    );
  });
});
