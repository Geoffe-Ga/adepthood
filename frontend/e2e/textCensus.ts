/**
 * The text census: what `text-order.browser.e2e.test.ts` measures on every
 * screen and the rules it holds that measurement to (#2948, epic #2946).
 *
 * This module imports nothing from Playwright and nothing from `src/`, on
 * purpose. `collectTextCensus` is handed to `page.evaluate`, which serialises
 * the function's SOURCE and runs it inside Chromium -- so it may reference
 * nothing outside its own body; every helper it needs is an inner function.
 * The rules below run in Node on the records it returns, and Jest can load
 * them (`src/design/__tests__/textCensus.test.ts`), which is the only way a
 * regression in a rule fails before the lane runs.
 *
 * The type ramp is duplicated here rather than imported: `design/tokens.ts`
 * pulls in react-native's `Platform`, which the Playwright process cannot
 * load. The Jest bridge test pins `legalFontSizes` to `type(width)`,
 * `editorialType` and `uiType`, so the two cannot drift silently.
 */

/** A laid-out rectangle in CSS pixels, viewport-relative. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What lies over a text's centre; see `TextRecord.cover`. */
export type Cover = 'none' | 'text' | 'surface';

/** One visible run of an element's own text, as the walker records it. */
export interface TextRecord extends Box {
  text: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: string;
  color: string;
  /**
   * The part of the box a reader can see: the box clipped by the nearest
   * scrolling ancestor, so a row scrolled under a footer is not "overlapping"
   * it. Equal to the box when nothing scrolls between the text and the page.
   */
  visible: Box;
  /**
   * What is drawn over the text's centre: nothing (it is the topmost thing
   * there), another string (`text`), or an opaque surface without text of its
   * own (`surface`) -- the Map's magnifier glass over a stage watermark, a
   * sheet over the screen beneath. Text under a surface cannot collide with
   * anything a reader sees; text under text can.
   */
  cover: Cover;
  /** The closest `[data-testid]` ancestor (RNW renders `testID` as `data-testid`). */
  testId: string | null;
  /**
   * That ancestor's extent: its box, or its scroll extent when it scrolls, so
   * text below the fold of a list is inside its list rather than outside it.
   */
  parent: Box | null;
  /** Position in document order, so ancestry can be read without the DOM. */
  index: number;
  /** How many elements the element contains: `index < other <= index + span` is a descendant. */
  span: number;
}

/** What one screen's census boils down to for the summary line. */
export interface CensusSummary {
  textNodes: number;
  leftEdges: readonly number[];
  faces: number;
  rawMarkup: number;
  outsideParent: number;
  overlaps: number;
  offRamp: readonly number[];
}

/** Bounding boxes are sub-pixel; a fraction of a pixel is not a finding. */
export const SUBPIXEL_TOLERANCE = 1;

// ---------------------------------------------------------------------------
// The walker. Every function from here to `collectTextCensus` runs in Chromium:
// `textCensusScript` injects their SOURCE together, so they may call one
// another and nothing else -- no import, no module-level constant.
// ---------------------------------------------------------------------------

/** Whether an element's overflow scrolls on either axis. */
function scrolls(el: Element): boolean {
  const { overflowX, overflowY } = getComputedStyle(el);
  return (
    overflowX === 'auto' || overflowX === 'scroll' || overflowY === 'auto' || overflowY === 'scroll'
  );
}

/** A DOMRect as a `Box`. */
function box(rect: DOMRect): Box {
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

/** The intersection of a box with a rect; zero or negative sides when disjoint. */
function meet(a: Box, b: DOMRect): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.min(a.x + a.w, b.right) - x, h: Math.min(a.y + a.h, b.bottom) - y };
}

/** The nearest ancestor whose overflow scrolls, or null. */
function scrollerOf(el: Element): Element | null {
  let node = el.parentElement;
  while (node !== null && !scrolls(node)) node = node.parentElement;
  return node;
}

/** An element's box, or its scroll extent when it scrolls. */
function extentOf(el: Element): Box {
  const rect = box(el.getBoundingClientRect());
  if (!scrolls(el)) return rect;
  const w = Math.max(rect.w, el.scrollWidth);
  const h = Math.max(rect.h, el.scrollHeight);
  return { x: rect.x - el.scrollLeft, y: rect.y - el.scrollTop, w, h };
}

/** Visible in the CSS sense and not under an `aria-hidden` ancestor. */
function shown(el: HTMLElement): boolean {
  return (
    el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
    el.closest('[aria-hidden="true"]') === null
  );
}

/** The element's own non-blank text nodes, children's excluded. */
function ownNodes(el: Element): Text[] {
  return [...el.childNodes].filter(
    (node): node is Text => node instanceof Text && node.data.trim() !== '',
  );
}

/** A range spanning the element's own text nodes, or null when it has none. */
function textRange(el: Element): Range | null {
  const nodes = ownNodes(el);
  const first = nodes[0];
  if (first === undefined) return null;
  const range = document.createRange();
  range.setStartBefore(first);
  range.setEndAfter(nodes.at(-1) ?? first);
  return range;
}

/** The part of `rect` inside the nearest scrolling ancestor; `rect` when none scrolls. */
function visibleOf(el: Element, rect: Box): Box {
  const scroller = scrollerOf(el);
  return scroller === null ? rect : meet(rect, scroller.getBoundingClientRect());
}

/**
 * What a reader hits at the box's centre: the element itself (or its own span,
 * or the box it sits in) is `none`; an unrelated element with text of its own
 * somewhere up its chain is `text`; anything else is `surface`. Off the
 * viewport nothing can be hit-tested and nothing is drawn, so `none`.
 */
function coverOf(el: Element, rect: Box): Cover {
  const hit = document.elementFromPoint(rect.x + rect.w / 2, rect.y + rect.h / 2);
  if (hit === null || el.contains(hit) || hit.contains(el)) return 'none';
  for (let node: Element | null = hit; node !== null; node = node.parentElement) {
    if (ownNodes(node).length > 0) return 'text';
  }
  return 'surface';
}

/** The closest `[data-testid]` ancestor's id and extent, both null when there is none. */
function anchorOf(el: Element): { testId: string | null; parent: Box | null } {
  const anchor = el.closest('[data-testid]');
  if (anchor === null) return { testId: null, parent: null };
  return { testId: anchor.getAttribute('data-testid'), parent: extentOf(anchor) };
}

/**
 * Walk the document and record every element whose own text (its direct text
 * nodes, not its children's) is non-empty and visible.
 *
 * The text's box is its glyph run clamped to its own element: Chrome's range
 * rect includes the collapsed space at each soft wrap, which reaches a few
 * pixels past the element and would read as text outside its component.
 */
function collectTextCensus(): TextRecord[] {
  const records: TextRecord[] = [];
  const all = [...document.body.querySelectorAll<HTMLElement>('*')];
  for (const [index, el] of all.entries()) {
    const range = textRange(el);
    if (range === null || !shown(el)) continue;
    const rect = meet(box(range.getBoundingClientRect()), el.getBoundingClientRect());
    if (rect.w <= 0 || rect.h <= 0) continue;
    const { fontSize, fontFamily, fontWeight, color } = getComputedStyle(el);
    records.push({
      text: ownNodes(el)
        .map((node) => node.data)
        .join('')
        .trim(),
      fontSize: Number.parseFloat(fontSize),
      fontFamily,
      fontWeight,
      color,
      ...rect,
      visible: visibleOf(el, rect),
      cover: coverOf(el, rect),
      ...anchorOf(el),
      index,
      span: el.querySelectorAll('*').length,
    });
  }
  return records;
}

/** Every function the walker needs on the page, `collectTextCensus` last. */
const PAGE_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  scrolls,
  box,
  meet,
  scrollerOf,
  extentOf,
  shown,
  ownNodes,
  textRange,
  visibleOf,
  coverOf,
  anchorOf,
  collectTextCensus,
];

/**
 * The whole walker as one expression for `page.evaluate`, which evaluates to
 * the census of the current document.
 *
 * `page.evaluate` given a function serialises only that function's source, so
 * a walker written as one function could reference no helper, and the DOM
 * work above does not fit in one function the lint budget allows. Given a
 * string it evaluates an expression instead, so this declares every page
 * function inside one IIFE -- where they resolve one another -- and returns
 * the walk. Each function is still ordinary TypeScript the compiler and ESLint
 * check on its own.
 */
export function textCensusScript(): string {
  const declarations = PAGE_FUNCTIONS.map((fn) => fn.toString()).join('\n');
  return `(() => {\n${declarations}\nreturn collectTextCensus();\n})()`;
}

// ---------------------------------------------------------------------------
// The type ramp, as design/tokens.ts defines it (pinned by the Jest bridge).
// ---------------------------------------------------------------------------

/** `breakpoints` in tokens.ts; `xs: 0` is implied by the first branch. */
const BREAKPOINTS = { sm: 360, md: 600, lg: 900, xl: 1200 } as const;
/** `type(width)`'s base size at each breakpoint, smallest first. */
const TYPE_BASES = [15, 16, 17, 18, 19] as const;
/** `type(width)`'s multipliers: display, title, heading, body, label, caption. */
const TYPE_SCALE = [2.1, 1.6, 1.25, 1, 0.9, 0.8] as const;
/** `editorialType`: display, title, heading, body, note, caption, action, marginNote. */
const EDITORIAL_SIZES = [34, 26, 20, 18, 15, 13, 16, 14] as const;
/** `uiType.button.fontSize`, which is `INTERACTIVE_TEXT_MIN`. */
const UI_BUTTON_SIZE = 16;

function typeBase(width: number): number {
  const ladder = [BREAKPOINTS.sm, BREAKPOINTS.md, BREAKPOINTS.lg, BREAKPOINTS.xl];
  const step = ladder.findIndex((limit) => width < limit);
  return TYPE_BASES[step === -1 ? ladder.length : step] ?? TYPE_BASES[0];
}

/**
 * Every font size a screen of `width` CSS pixels may legitimately set:
 * `type(width)`'s six sizes, `editorialType`'s eight, and the button face.
 */
export function legalFontSizes(width: number): Set<number> {
  const base = typeBase(width);
  return new Set([
    ...TYPE_SCALE.map((factor) => Math.round(base * factor)),
    ...EDITORIAL_SIZES,
    UI_BUTTON_SIZE,
  ]);
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** Text whose box leaves its closest `testID` ancestor's extent by more than `tolerance`. */
export function outsideParent(records: readonly TextRecord[], tolerance: number): TextRecord[] {
  return records.filter((record) => {
    const { parent } = record;
    if (parent === null) return false;
    return (
      record.x < parent.x - tolerance ||
      record.y < parent.y - tolerance ||
      record.x + record.w > parent.x + parent.w + tolerance ||
      record.y + record.h > parent.y + parent.h + tolerance
    );
  });
}

/** True when the two boxes share more than `tolerance` pixels on both axes. */
function boxesOverlap(a: Box, b: Box, tolerance: number): boolean {
  const sharedWidth = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const sharedHeight = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return sharedWidth > tolerance && sharedHeight > tolerance;
}

/** True when one record's element contains the other's (nested `Text` spans). */
function related(a: TextRecord, b: TextRecord): boolean {
  const contains = (outer: TextRecord, inner: TextRecord): boolean =>
    inner.index > outer.index && inner.index <= outer.index + outer.span;
  return contains(a, b) || contains(b, a);
}

/**
 * Every pair of unrelated text boxes whose VISIBLE parts overlap by more than
 * `tolerance`. What a scroller has clipped cannot collide with anything, and
 * a string under an opaque surface is that surface's business, not another
 * string's; a string drawn over another is still reported, because the lower
 * one's cover is text.
 */
export function overlappingPairs(
  records: readonly TextRecord[],
  tolerance: number,
): Array<[TextRecord, TextRecord]> {
  const pairs: Array<[TextRecord, TextRecord]> = [];
  for (const [index, a] of records.entries()) {
    for (const b of records.slice(index + 1)) {
      if (a.cover === 'surface' || b.cover === 'surface' || related(a, b)) continue;
      if (boxesOverlap(a.visible, b.visible, tolerance)) pairs.push([a, b]);
    }
  }
  return pairs;
}

/** Markdown that reached the screen as characters: bold, underscores, a heading, a link. */
const RAW_MARKUP = /\*\*|__|##|\[[^\]]+\]\(/;

/** Records whose visible string still carries raw Markdown. */
export function rawMarkup(records: readonly TextRecord[]): TextRecord[] {
  return records.filter((record) => RAW_MARKUP.test(record.text));
}

const ascending = (a: number, b: number): number => a - b;

/** The font sizes on screen that are not in the legal set, sorted. */
export function offRampSizes(records: readonly TextRecord[], legal: ReadonlySet<number>): number[] {
  const sizes = new Set(records.map((r) => r.fontSize).filter((size) => !legal.has(size)));
  return [...sizes].sort(ascending);
}

/** The distinct left edges on screen, to the pixel, sorted. */
export function leftEdges(records: readonly TextRecord[]): number[] {
  return [...new Set(records.map((r) => Math.round(r.x)))].sort(ascending);
}

/** The distinct `family|size` faces on screen, sorted. */
export function faces(records: readonly TextRecord[]): string[] {
  return [...new Set(records.map((r) => `${r.fontFamily}|${String(r.fontSize)}`))].sort();
}

const braces = (values: readonly number[]): string => `{${values.join(',')}}`;

/** One line per screen, so a reviewer sees edges and faces at a glance. */
export function summaryLine(viewport: string, route: string, census: CensusSummary): string {
  return (
    `${viewport}  ${route}  text nodes=${String(census.textNodes)}  ` +
    `left edges=${braces(census.leftEdges)}  faces=${String(census.faces)}  ` +
    `raw-markup=${String(census.rawMarkup)}  outside-parent=${String(census.outsideParent)}  ` +
    `overlaps=${String(census.overlaps)}  off-ramp=${braces(census.offRamp)}`
  );
}
