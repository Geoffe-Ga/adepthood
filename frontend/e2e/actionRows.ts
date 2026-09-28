/**
 * The action-row sweep: what `action-rows.browser.e2e.test.ts` measures on
 * every screen and the rules it holds those measurements to (#2860; the rules
 * themselves are `## Action rows` in `src/design/DESIGN.md`).
 *
 * Like `textCensus.ts`, this module imports nothing from Playwright and nothing
 * from `src/`. `collectButtons` is handed to `page.evaluate` as source and runs
 * inside Chromium, so it may reference nothing outside its own body and the
 * page functions listed beside it. The rules run in Node on the records it
 * returns, and Jest loads them (`src/design/__tests__/actionRows.test.ts`) --
 * the only way a regression in a rule fails before the browser lane runs.
 */

import { SUBPIXEL_TOLERANCE, type Box } from './textCensus';

export { SUBPIXEL_TOLERANCE };

/**
 * How far apart, in CSS pixels, the tops of two buttons on one row may sit.
 * The issue's own number: "no two buttons in the same row differ in `top` by
 * more than 2px".
 */
export const ROW_TOP_TOLERANCE = 2;

/** One visible element with the button role, as the walker records it. */
export interface ButtonRecord extends Box {
  /** The accessible name as a reader hears it: `aria-label`, else the visible words. */
  name: string;
  /** The element's OWN `data-testid` (RNW's `testID`), or null when it carries none. */
  testId: string | null;
  /**
   * The part of the box a reader can see: the box clipped by the nearest
   * scrolling ancestor, so a row scrolled under a footer does not "overlap" it.
   */
  visible: Box;
  /**
   * The box clipped only by the nearest ancestor that scrolls SIDEWAYS: a
   * rail's pills past the edge are one swipe away, so what this box leaves
   * of them is what counts against the viewport's width. A vertical
   * ScrollView hides its horizontal overflow without scrolling it, so it
   * clips nothing here -- a button it cuts off at the edge stays cut off.
   */
  swipe: Box;
  /** Position in document order, so ancestry can be read without the DOM. */
  index: number;
  /** How many elements the element contains: `index < other <= index + span` is a descendant. */
  span: number;
}

/** A button the sweep knowingly leaves out of its assertions, and why. */
export interface ButtonSkip {
  /** The `Route.name` the button is on. */
  route: string;
  /** The button's `buttonKey`. */
  button: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// The walker. Every function from here to `collectButtons` runs in Chromium:
// `actionRowScript` injects their SOURCE together, so they may call one
// another and nothing else -- no import, no module-level constant.
// ---------------------------------------------------------------------------

/** Whether an element's overflow scrolls: sideways only, or on either axis. */
function scrollsOnPage(el: Element, sidewaysOnly: boolean): boolean {
  const { overflowX, overflowY } = getComputedStyle(el);
  const axes = sidewaysOnly ? [overflowX] : [overflowX, overflowY];
  return axes.some((value) => value === 'auto' || value === 'scroll');
}

/** A DOMRect as a `Box`. */
function boxOnPage(rect: DOMRect): Box {
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

/**
 * The part of `rect` inside the nearest scrolling ancestor (sideways-scrolling
 * only, when asked); `rect` when none scrolls. A side is zero or negative when
 * the scroller has clipped the whole button away.
 */
function clippedOnPage(el: Element, rect: Box, sidewaysOnly: boolean): Box {
  let scroller = el.parentElement;
  while (scroller !== null && !scrollsOnPage(scroller, sidewaysOnly)) {
    scroller = scroller.parentElement;
  }
  if (scroller === null) return rect;
  const clip = scroller.getBoundingClientRect();
  const x = Math.max(rect.x, clip.x);
  const y = Math.max(rect.y, clip.y);
  return {
    x,
    y,
    w: Math.min(rect.x + rect.w, clip.right) - x,
    h: Math.min(rect.y + rect.h, clip.bottom) - y,
  };
}

/** Visible in the CSS sense and not under an `aria-hidden` ancestor. */
function shownOnPage(el: HTMLElement): boolean {
  return (
    el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
    el.closest('[aria-hidden="true"]') === null
  );
}

/** What a reader hears the control called: its label, else its words, on one line. */
function nameOnPage(el: HTMLElement): string {
  const label = el.getAttribute('aria-label');
  const words = label === null || label.trim() === '' ? el.innerText : label;
  return words.replaceAll(/\s+/g, ' ').trim();
}

/** Every laid-out, visible element a reader meets as a button, in document order. */
function collectButtons(): ButtonRecord[] {
  const records: ButtonRecord[] = [];
  const all = [...document.body.querySelectorAll<HTMLElement>('*')];
  for (const [index, el] of all.entries()) {
    const isButton = el.getAttribute('role') === 'button' || el.tagName === 'BUTTON';
    if (!isButton || !shownOnPage(el)) continue;
    const rect = boxOnPage(el.getBoundingClientRect());
    if (rect.w <= 0 || rect.h <= 0) continue;
    records.push({
      name: nameOnPage(el),
      testId: el.getAttribute('data-testid'),
      ...rect,
      visible: clippedOnPage(el, rect, false),
      swipe: clippedOnPage(el, rect, true),
      index,
      span: el.querySelectorAll('*').length,
    });
  }
  return records;
}

/** Every function the walker needs on the page, `collectButtons` last. */
const PAGE_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  scrollsOnPage,
  boxOnPage,
  clippedOnPage,
  shownOnPage,
  nameOnPage,
  collectButtons,
];

/**
 * The walker as one expression for `page.evaluate`, resolving to the buttons
 * of ONE settled frame.
 *
 * Two `requestAnimationFrame`s inside the same evaluate: the first callback
 * runs before the next paint, the second after it, so every style and layout
 * change queued when the sweep asked has been committed -- and every box is
 * then read synchronously in that one callback. Reading boxes one
 * `boundingBox()` call at a time is the race the morning-pages spec recorded:
 * the shelf settles between reads, and two boxes taken either side of a shift
 * measure the shift, not the screen.
 */
export function actionRowScript(): string {
  const declarations = PAGE_FUNCTIONS.map((fn) => fn.toString()).join('\n');
  return (
    `(() => {\n${declarations}\n` +
    'return new Promise((resolve) => requestAnimationFrame(() => ' +
    'requestAnimationFrame(() => resolve(collectButtons()))));\n})()'
  );
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** How far two boxes share an axis: positive when they overlap on it. */
function sharedX(a: Box, b: Box): number {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
}

function sharedY(a: Box, b: Box): number {
  return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
}

/**
 * True when one record's element contains the other's: a pressable card with
 * a control inside it is a composition, not two controls colliding.
 */
function related(a: ButtonRecord, b: ButtonRecord): boolean {
  const contains = (outer: ButtonRecord, inner: ButtonRecord): boolean =>
    inner.index > outer.index && inner.index <= outer.index + outer.span;
  return contains(a, b) || contains(b, a);
}

/**
 * Every unrelated pair of buttons, in document order.
 *
 * A button its scroller has clipped away entirely -- a tile below the grid's
 * fold -- has a visible box with a zero or negative side, and such a box can
 * neither overlap nor share a row with anything under the predicates below,
 * so no separate "is it on screen" filter is needed (or could be observed).
 */
function unrelatedPairs(records: readonly ButtonRecord[]): Array<[ButtonRecord, ButtonRecord]> {
  const pairs: Array<[ButtonRecord, ButtonRecord]> = [];
  for (const [index, a] of records.entries()) {
    for (const b of records.slice(index + 1)) {
      if (!related(a, b)) pairs.push([a, b]);
    }
  }
  return pairs;
}

/**
 * Every pair of unrelated buttons whose VISIBLE parts overlap by more than
 * `tolerance` on both axes -- two controls a finger cannot tell apart.
 */
export function overlappingButtons(
  records: readonly ButtonRecord[],
  tolerance: number,
): Array<[ButtonRecord, ButtonRecord]> {
  return unrelatedPairs(records).filter(
    ([a, b]) =>
      sharedX(a.visible, b.visible) > tolerance && sharedY(a.visible, b.visible) > tolerance,
  );
}

/**
 * Buttons whose swipe box leaves the viewport's width by more than
 * `tolerance`: a control the page lets spill or cuts off at the edge, where
 * nothing will scroll it back. A rail's pills past the edge are exempt by
 * construction -- their swipe box ends where the rail does.
 */
export function outsideViewportWidth(
  records: readonly ButtonRecord[],
  width: number,
  tolerance: number,
): ButtonRecord[] {
  return records.filter(
    ({ swipe }) => swipe.x < -tolerance || swipe.x + swipe.w > width + tolerance,
  );
}

/** Whether `b`'s vertical centre falls inside `a`'s vertical extent. */
function centreWithin(a: Box, b: Box): boolean {
  const centre = b.y + b.h / 2;
  return centre >= a.y && centre <= a.y + a.h;
}

/**
 * Every pair of unrelated buttons that share a row but not a top.
 *
 * Two buttons share a row when they sit side by side: their visible boxes do
 * not overlap horizontally (boxes overlapping on both axes are the overlap
 * rule's finding) and each one's vertical centre lies within the other's
 * vertical extent. Mutual centres, not mere vertical overlap: a 44px corner X
 * beside the top lines of a 160px pressable block overlaps it vertically but
 * is a corner, not a row -- the block's centre is far below the X. On a row,
 * tops further apart than `rowTolerance` are two baselines where the rule
 * allows one.
 */
export function misalignedRows(
  records: readonly ButtonRecord[],
  rowTolerance: number,
  tolerance: number,
): Array<[ButtonRecord, ButtonRecord]> {
  return unrelatedPairs(records).filter(([a, b]) => {
    const [boxA, boxB] = [a.visible, b.visible];
    const sameRow =
      sharedX(boxA, boxB) <= tolerance && centreWithin(boxA, boxB) && centreWithin(boxB, boxA);
    return sameRow && Math.abs(boxA.y - boxB.y) > rowTolerance;
  });
}

/** How the sweep names a button: its testID, else its accessible name in quotes. */
export function buttonKey(record: ButtonRecord): string {
  return record.testId ?? `"${record.name}"`;
}

/**
 * Split a screen's buttons into those the rules hold and those a skip names,
 * and report every skip for this route whose button is not on the screen --
 * a skip that outlived its finding would otherwise exempt whatever takes the
 * name next.
 */
export function applyButtonSkips(
  records: readonly ButtonRecord[],
  route: string,
  skips: readonly ButtonSkip[],
): { kept: ButtonRecord[]; stale: ButtonSkip[] } {
  const here = skips.filter((skip) => skip.route === route);
  const skipped = new Set(here.map((skip) => skip.button));
  const present = new Set(records.map(buttonKey));
  return {
    kept: records.filter((record) => !skipped.has(buttonKey(record))),
    stale: here.filter((skip) => !present.has(skip.button)),
  };
}

/** `name="X"` on a `Stack.Screen`, attribute on its own line or not. */
const STACK_SCREEN_NAME = /\bname="(\w+)"/g;
/** Where `RootTabParamList`'s body opens, and the column-zero line that closes it. */
const TAB_PARAM_LIST_OPEN = 'export type RootTabParamList = {';
const TAB_PARAM_LIST_CLOSE = '\n};';
/** One `Name:` key at the start of a line inside that body. */
const TAB_KEY = /^\s*([A-Z]\w*)\s*:/gm;

/**
 * Every screen the app declares: each `RootStack.tsx` screen except the tab
 * shell `Tabs` itself, then each key of `RootTabParamList` in `BottomTabs.tsx`.
 * Read from source so a new screen cannot join the app without the sweep
 * either walking it or saying why not.
 */
export function declaredScreens(rootStackSource: string, tabsSource: string): string[] {
  const stack = [...rootStackSource.matchAll(STACK_SCREEN_NAME)]
    .map((match) => match[1] ?? '')
    .filter((name) => name !== '' && name !== 'Tabs');
  const start = tabsSource.indexOf(TAB_PARAM_LIST_OPEN);
  const end = start === -1 ? -1 : tabsSource.indexOf(TAB_PARAM_LIST_CLOSE, start);
  const body = end === -1 ? '' : tabsSource.slice(start + TAB_PARAM_LIST_OPEN.length, end);
  const tabs = [...body.matchAll(TAB_KEY)].map((match) => match[1] ?? '').filter(Boolean);
  return [...stack, ...tabs];
}

/** Declared screens the sweep neither walks nor skips with a reason. */
export function unaccountedScreens(
  declared: readonly string[],
  walked: readonly string[],
  skipped: readonly string[],
): string[] {
  const accounted = new Set([...walked, ...skipped]);
  return declared.filter((name) => !accounted.has(name));
}

/** One button, the way the issue spells a sweep line. */
export function tableLine(viewport: string, route: string, record: ButtonRecord): string {
  const [x, y, w, h] = [record.x, record.y, record.w, record.h].map((n) => String(Math.round(n)));
  return `${viewport}  ${route}  ${buttonKey(record)}  x=${x} y=${y} w=${w} h=${h}  "${record.name}"`;
}
