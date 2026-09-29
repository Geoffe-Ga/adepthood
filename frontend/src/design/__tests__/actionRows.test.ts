/* global describe, it, expect */
import {
  applyButtonSkips,
  buttonKey,
  declaredScreens,
  misalignedRows,
  outsideViewportWidth,
  overlappingButtons,
  ROW_TOP_TOLERANCE,
  SUBPIXEL_TOLERANCE,
  stackScreenNames,
  tableLine,
  unaccountedScreens,
  type ButtonRecord,
} from '../../../e2e/actionRows';

/**
 * The action-row sweep (#2860) measures every screen's buttons in Chromium; the
 * rules it holds those boxes to are plain functions over records, so they are
 * pinned here on synthetic rows. A rule that quietly reported nothing would
 * certify every screen it never really measured, which is why each rule is
 * shown both catching its violation and leaving the lawful neighbour alone.
 */

const PHONE_WIDTH = 390;

/** A button in no scroller -- every box is its own box -- unless overridden. */
const button = (overrides: Partial<ButtonRecord>): ButtonRecord => {
  const x = overrides.x ?? 16;
  const y = overrides.y ?? 400;
  const w = overrides.w ?? 120;
  const h = overrides.h ?? 44;
  return {
    name: 'Begin a page',
    testId: 'journal-morning-pages-tip',
    x,
    y,
    w,
    h,
    visible: { x, y, w, h },
    swipe: { x, y, w, h },
    scroller: null,
    index: 1,
    span: 0,
    ...overrides,
  };
};

describe('action-row tolerances', () => {
  it('names the sub-pixel and same-row tolerances the issue states', () => {
    expect(SUBPIXEL_TOLERANCE).toBe(1);
    expect(ROW_TOP_TOLERANCE).toBe(2);
  });
});

describe('overlappingButtons', () => {
  it('reports two sibling buttons that share more than a pixel', () => {
    const a = button({ index: 1, x: 16, w: 120 });
    const b = button({ index: 2, x: 100, w: 120, testId: 'journal-review-early' });
    expect(overlappingButtons([a, b], SUBPIXEL_TOLERANCE)).toEqual([[a, b]]);
  });

  it('does not report buttons that touch or graze by a sub-pixel', () => {
    const a = button({ index: 1, x: 16, w: 120 });
    const touching = button({ index: 2, x: 136, w: 120 });
    const grazing = button({ index: 3, x: 16, y: 443.5 });
    expect(overlappingButtons([a, touching, grazing], SUBPIXEL_TOLERANCE)).toEqual([]);
  });

  it('reports an overlap of just over the tolerance', () => {
    const a = button({ index: 1, x: 16, w: 120 });
    const b = button({ index: 2, x: 134.5, w: 120 });
    expect(overlappingButtons([a, b], SUBPIXEL_TOLERANCE)).toEqual([[a, b]]);
  });

  it('never reports a pressable against a control nested inside it', () => {
    const card = button({ index: 1, span: 4, x: 16, y: 400, w: 358, h: 120 });
    const inner = button({ index: 3, span: 0, x: 300, y: 400, w: 44, h: 44 });
    expect(overlappingButtons([card, inner], SUBPIXEL_TOLERANCE)).toEqual([]);
  });

  it('does not mistake the element just past a subtree for one of its descendants', () => {
    const card = button({ index: 1, span: 1, x: 16, w: 120 });
    const after = button({ index: 3, span: 0, x: 16, w: 120 });
    expect(overlappingButtons([card, after], SUBPIXEL_TOLERANCE)).toEqual([[card, after]]);
  });

  it('measures what a scroller left visible, so a clipped row cannot collide with a footer', () => {
    const tile = button({
      index: 1,
      y: 780,
      h: 44,
      visible: { x: 16, y: 780, w: 120, h: 2 },
      scroller: 7,
    });
    const footer = button({ index: 9, y: 782, h: 44 });
    expect(overlappingButtons([tile, footer], SUBPIXEL_TOLERANCE)).toEqual([]);
  });
});

describe("buttons below a scroller's fold", () => {
  /** A button `y` pixels down a scroller's content (its box starts at page y 700), out of sight. */
  const deep = (index: number, x: number, y: number): ButtonRecord =>
    button({
      index,
      x,
      y: 700 + y,
      visible: { x, y: 700 + y, w: 120, h: -600 },
      scroller: 7,
    });

  it('still reports two overlapping buttons the scroller has not yet shown', () => {
    const a = deep(1, 16, 1200);
    const b = deep(2, 60, 1210);
    expect(overlappingButtons([a, b], SUBPIXEL_TOLERANCE)).toEqual([[a, b]]);
  });

  it('still reports a misaligned row the scroller has not yet shown', () => {
    const left = deep(1, 16, 1500);
    const right = deep(2, 140, 1512);
    expect(misalignedRows([left, right], ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE)).toEqual([
      [left, right],
    ]);
  });

  it('compares buttons in different scrollers only where both can be seen', () => {
    // A list row below its scroller's fold against a footer fixed outside the
    // list. Laid out, the row sits exactly where the footer is drawn -- one
    // box, or a 4px-misaligned row -- yet a reader never sees both: the list
    // clips the row away until it is scrolled, and scrolling moves it.
    const row = deep(1, 16, 54);
    const footer = button({ index: 9, x: 16, y: 754 });
    const beside = button({ index: 9, x: 200, y: 758 });
    expect(overlappingButtons([row, footer], SUBPIXEL_TOLERANCE)).toEqual([]);
    expect(misalignedRows([row, beside], ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE)).toEqual([]);
  });
});

describe('exact boundaries', () => {
  it('does not report two buttons that share exactly the tolerance across', () => {
    // Deep in each other vertically, exactly one pixel shared horizontally.
    const a = button({ index: 1, x: 16, y: 400, w: 120, h: 44 });
    const b = button({ index: 2, x: 135, y: 410, w: 120, h: 44 });
    expect(overlappingButtons([a, b], SUBPIXEL_TOLERANCE)).toEqual([]);
  });

  it('does not report two buttons that share exactly the tolerance down', () => {
    // Deep in each other horizontally, exactly one pixel shared vertically.
    const a = button({ index: 1, x: 16, y: 400, w: 120, h: 44 });
    const b = button({ index: 2, x: 40, y: 443, w: 120, h: 44 });
    expect(overlappingButtons([a, b], SUBPIXEL_TOLERANCE)).toEqual([]);
  });

  it('does not report a button whose edges sit exactly at the tolerance outside the viewport', () => {
    const right = button({ x: 291, w: 100 });
    const left = button({ x: -1, w: 100 });
    expect(outsideViewportWidth([right, left], PHONE_WIDTH, SUBPIXEL_TOLERANCE)).toEqual([]);
  });

  it('still reads a side-by-side pair sharing exactly the tolerance as one row', () => {
    const left = button({ index: 1, x: 16, y: 400, w: 120 });
    const right = button({ index: 2, x: 135, y: 405, w: 120 });
    expect(misalignedRows([left, right], ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE)).toEqual([
      [left, right],
    ]);
  });
});

describe('outsideViewportWidth', () => {
  it('reports a button that runs past the right edge', () => {
    const spill = button({ x: 300, w: 100 });
    expect(outsideViewportWidth([spill], PHONE_WIDTH, SUBPIXEL_TOLERANCE)).toEqual([spill]);
  });

  it('reports a button that starts left of the page', () => {
    const early = button({ x: -2, w: 100 });
    expect(outsideViewportWidth([early], PHONE_WIDTH, SUBPIXEL_TOLERANCE)).toEqual([early]);
  });

  it('leaves a rail a horizontal scroller holds past the edge to the scroller', () => {
    // Course's stage pills 9 and 10 at 390: laid out past the edge, clipped by
    // their horizontal ScrollView, one swipe away -- not spilling out of the page.
    const clipped = button({ x: 396, w: 40, swipe: { x: 396, y: 400, w: -6, h: 44 } });
    const half = button({ x: 370, w: 40, swipe: { x: 370, y: 400, w: 20, h: 44 } });
    expect(outsideViewportWidth([clipped, half], PHONE_WIDTH, SUBPIXEL_TOLERANCE)).toEqual([]);
  });

  it('still catches a button a vertical scroller cuts off at the edge', () => {
    // A vertical ScrollView hides its horizontal overflow: the visible box ends
    // at the edge, but nothing will ever scroll the rest of the button into view.
    const cut = button({ x: 330, w: 100, visible: { x: 330, y: 400, w: 60, h: 44 } });
    expect(outsideViewportWidth([cut], PHONE_WIDTH, SUBPIXEL_TOLERANCE)).toEqual([cut]);
  });

  it('catches a spill of just over the tolerance', () => {
    const spill = button({ x: 290, w: 101.5 });
    expect(outsideViewportWidth([spill], PHONE_WIDTH, SUBPIXEL_TOLERANCE)).toEqual([spill]);
  });

  it('tolerates a sub-pixel spill on either edge', () => {
    const flushRight = button({ x: 290, w: 100.5 });
    const flushLeft = button({ x: -0.5, w: 100 });
    expect(outsideViewportWidth([flushRight, flushLeft], PHONE_WIDTH, SUBPIXEL_TOLERANCE)).toEqual(
      [],
    );
  });
});

describe('misalignedRows', () => {
  it('reports two side-by-side buttons whose tops differ by more than the row tolerance', () => {
    const confirm = button({ index: 1, x: 200, y: 400, w: 80 });
    const decline = button({ index: 2, x: 290, y: 403, w: 80, testId: 'decline' });
    expect(misalignedRows([confirm, decline], ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE)).toEqual([
      [confirm, decline],
    ]);
  });

  it('accepts a row whose tops differ by exactly the row tolerance', () => {
    const confirm = button({ index: 1, x: 200, y: 400, w: 80 });
    const decline = button({ index: 2, x: 290, y: 402, w: 80 });
    expect(misalignedRows([confirm, decline], ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE)).toEqual([]);
  });

  it('does not read a corner control beside a tall pressable block as a row', () => {
    // The morning-pages band: the corner X is level with the block's top
    // lines, but the block's centre is far below the X -- a corner, not a row.
    const block = button({ index: 1, x: 35, y: 490, w: 295, h: 162 });
    const corner = button({ index: 2, x: 330, y: 474, w: 44, h: 44 });
    expect(misalignedRows([block, corner], ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE)).toEqual([]);
    // And in either document order: the X may come first in the tree.
    const first = { ...corner, index: 0 };
    expect(misalignedRows([first, block], ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE)).toEqual([]);
  });

  it('still reads two controls of different heights centred on one line as a row', () => {
    const tall = button({ index: 1, x: 16, y: 400, w: 80, h: 48 });
    const short = button({ index: 2, x: 120, y: 406, w: 80, h: 36 });
    expect(misalignedRows([tall, short], ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE)).toEqual([
      [tall, short],
    ]);
  });

  it('measures rows by what a scroller left visible, so a clipped tile is no row of the footer', () => {
    // A habit tile's marker below the grid's fold, level with the pagination bar.
    const marker = button({
      index: 1,
      x: 16,
      y: 732,
      h: 32,
      visible: { x: 16, y: 732, w: 120, h: -7 },
      scroller: 7,
    });
    const pager = button({ index: 9, x: 200, y: 729, h: 44 });
    expect(misalignedRows([marker, pager], ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE)).toEqual([]);
  });

  it('does not treat stacked buttons as one row', () => {
    const upper = button({ index: 1, y: 400, h: 44 });
    const lower = button({ index: 2, x: 200, y: 444, h: 44 });
    expect(misalignedRows([upper, lower], ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE)).toEqual([]);
  });

  it('leaves overlapping buttons to the overlap rule rather than reading them as a row', () => {
    const a = button({ index: 1, x: 16, y: 400, w: 120 });
    const b = button({ index: 2, x: 60, y: 420, w: 120 });
    expect(misalignedRows([a, b], ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE)).toEqual([]);
  });

  it('never compares a pressable with a control nested inside it', () => {
    const card = button({ index: 1, span: 4, x: 16, y: 400, w: 200, h: 120 });
    // Drawn beside the card's box (a negative margin, say) but inside its subtree.
    const inner = button({ index: 3, x: 300, y: 440, w: 44, h: 44 });
    expect(misalignedRows([card, inner], ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE)).toEqual([]);
  });
});

describe('button skips', () => {
  const tip = button({ index: 1, testId: 'journal-morning-pages-tip' });
  const early = button({ index: 2, testId: 'journal-review-early', name: 'Start a review early' });
  const skip = {
    route: 'Journal',
    button: 'journal-review-early',
    reason: 'rule (d) finding',
  } as const;

  it('keys a button by its testID, or by its quoted name when it has none', () => {
    expect(buttonKey(early)).toBe('journal-review-early');
    expect(buttonKey(button({ testId: null, name: 'Open Journal menu' }))).toBe(
      '"Open Journal menu"',
    );
  });

  it('drops a skipped button on its own route only', () => {
    expect(applyButtonSkips([tip, early], 'Journal', [skip])).toEqual({
      kept: [tip],
      stale: [],
    });
    expect(applyButtonSkips([tip, early], 'Habits', [skip])).toEqual({
      kept: [tip, early],
      stale: [],
    });
  });

  it('reports a skip whose button is no longer on its route, so the list cannot rot', () => {
    expect(applyButtonSkips([tip], 'Journal', [skip])).toEqual({ kept: [tip], stale: [skip] });
  });
});

describe('route inventory', () => {
  const rootStack = [
    'export type RootStackParamList = {',
    '  Tabs: NavigatorScreenParams<RootTabParamList>;',
    '  Settings: undefined;',
    '  /** The operator inbox. Server-gated; no params. */',
    '  AdminFeedback: undefined;',
    '  JournalEntry:',
    '    | {',
    '        entryId?: number;',
    "        returnTo?: { screen: 'Course'; params: { contentId: number } };",
    '      }',
    '    | undefined;',
    '};',
    'const ADMIN = "AdminFeedback" as const;',
    '<Stack.Screen name="Tabs" component={BottomTabs} />',
    '<Stack.Screen',
    '  name="Settings"',
    '  component={SettingsHubScreen}',
    '/>',
    '<Stack.Screen name={ADMIN} component={AdminFeedbackScreen} />',
    '<Stack.Screen name="JournalEntry" component={JournalEntryScreen} />',
  ].join('\n');
  const tabs = [
    'export type RootTabParamList = {',
    '  Habits: undefined;',
    '  // contentId is a restore hint.',
    '  Course: { stageNumber?: number } | undefined;',
    '  Journal: undefined;',
    '};',
    'const Tab = createBottomTabNavigator<RootTabParamList>();',
  ].join('\n');

  it('reads every param-list key but the tab shell, however its JSX spells the name', () => {
    // `AdminFeedback` is registered as `name={ADMIN}`: a string-literal scan
    // of the JSX would lose it; the param list cannot.
    expect(declaredScreens(rootStack, tabs)).toEqual([
      'Settings',
      'AdminFeedback',
      'JournalEntry',
      'Habits',
      'Course',
      'Journal',
    ]);
  });

  it('reads the literal JSX names, so the spec can hold them to the param list', () => {
    expect(stackScreenNames(rootStack)).toEqual(['Tabs', 'Settings', 'JournalEntry']);
  });

  it('declares nothing from a source with no param list, rather than guessing', () => {
    expect(declaredScreens('const x = 1;', 'const y = 2;')).toEqual([]);
  });

  it('reports a declared screen neither walked nor skipped', () => {
    const declared = ['Settings', 'AdminFeedback', 'Journal'];
    expect(unaccountedScreens(declared, ['Journal'], ['AdminFeedback'])).toEqual(['Settings']);
    expect(unaccountedScreens(declared, ['Journal', 'Settings'], ['AdminFeedback'])).toEqual([]);
  });
});

describe('tableLine', () => {
  it('prints one button the way the issue spells a sweep line', () => {
    const line = tableLine(
      '390x844',
      'Journal shelf',
      button({ x: 16.4, y: 411.6, w: 358, h: 44 }),
    );
    expect(line).toBe(
      '390x844  Journal shelf  journal-morning-pages-tip  x=16 y=412 w=358 h=44  "Begin a page"',
    );
  });
});
