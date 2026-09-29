/**
 * The Map legibility measurement (#2657): what
 * `map-legibility.browser.e2e.test.ts` reads off a settled Map and the rules
 * it holds those numbers to.
 *
 * Like `textCensus.ts`, whose walker it runs in the same frame, this module
 * imports nothing from Playwright and nothing from `src/`. The page functions
 * are serialised by SOURCE into one `page.evaluate` expression, so they may
 * call one another and nothing else; the rules run in Node on what they return
 * and are pinned by `src/design/__tests__/mapGeometry.test.ts`, which is the
 * only way a predicate that quietly reports nothing fails before the lane runs.
 */

import { SUBPIXEL_TOLERANCE, textCensusScript, type Box, type TextRecord } from './textCensus';

/** A point in CSS pixels, viewport-relative, as `getBoundingClientRect` reports boxes. */
export interface Point {
  x: number;
  y: number;
}

/** A viewport's size in CSS pixels. */
export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Arc length between two wave samples. Smaller than the 3px stroke, so a
 * straight stretch between samples cannot carry the stroke's paint across a
 * box corner the samples on either side of it both miss.
 */
export const WAVE_SAMPLE_STEP_PX = 2;

/**
 * How far the stroke's paint may reach into an annotation's box before it is a
 * finding: the census's own sub-pixel allowance, so anti-aliasing at an edge is
 * forgiven exactly as it is for two text boxes.
 */
export const STROKE_CLEARANCE_TOLERANCE_PX = SUBPIXEL_TOLERANCE;

/** A laid-out element's place in document order, so ancestry can be read without the DOM. */
export interface Subtree {
  box: Box;
  /** Position among `document.body.querySelectorAll('*')`, as `TextRecord.index` counts. */
  index: number;
  /** How many elements it contains. */
  span: number;
}

/** The map-scroll viewport: its box plus the numbers that say whether it scrolls. */
export interface ScrollFrame extends Subtree {
  scrollHeight: number;
  clientHeight: number;
}

/** One `stage-hotspot-N-C` tap target: its place, its box and the extent of what it holds. */
export interface Hotspot extends Subtree {
  id: string;
  /** The union of every box inside it, or null when it holds nothing visible. */
  content: Box | null;
}

/** A `map-row-<label>` band and the stage numbers its hotspots carry. */
export interface Band {
  id: string;
  box: Box;
  stages: number[];
}

/** The sampled centreline of every visible wave segment. */
export interface WaveSample {
  pathCount: number;
  totalLength: number;
  /** Half the widest stroke among the paths, which is how far paint reaches off the centreline. */
  halfStroke: number;
  points: Point[];
}

/** Everything the spec needs from one settled frame of the Map. */
export interface MapMeasurement {
  viewport: ViewportSize;
  census: TextRecord[];
  wave: WaveSample;
  grid: Subtree | null;
  lens: Subtree | null;
  /** The lens pill's rim width, read from its computed border. */
  lensRim: number;
  /** The "YOU ARE HERE" chip's painted box, or null when the lens wears none. */
  chip: Box | null;
  scroll: ScrollFrame | null;
  hotspots: Hotspot[];
  bands: Band[];
  badges: Array<{ id: string; box: Box }>;
}

// ---------------------------------------------------------------------------
// The page side. Every function from here to `collectMap` runs in Chromium.
// ---------------------------------------------------------------------------

/** A DOMRect as a plain box. */
function rectBox(rect: DOMRect): Box {
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

/** The element with this exact `testID`; react-native-svg forwards it undashed. */
function byTestId(id: string): Element | null {
  return document.querySelector(`[data-testid="${id}"], [testid="${id}"]`);
}

/** An element's `testID`, as react-native-web renders it; empty when it has none. */
function idOf(el: Element): string {
  return el.getAttribute('data-testid') ?? '';
}

/** An element's box and its place in document order, or null when it is not mounted. */
function subtreeOf(id: string): Subtree | null {
  const el = byTestId(id);
  if (el === null) return null;
  const all = [...document.body.querySelectorAll('*')];
  return {
    box: rectBox(el.getBoundingClientRect()),
    index: all.indexOf(el),
    span: el.querySelectorAll('*').length,
  };
}

/**
 * The union of everything laid out inside an element -- its glyph runs and its
 * descendants' boxes, as a range over its contents reports them -- or null when
 * it holds nothing visible.
 */
function contentOf(el: Element): Box | null {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rectBox(rect) : null;
}

/** Sample the on-page wave (not the magnifier's copy) every `step` px of arc length. */
function sampleWave(step: number): WaveSample {
  const svg = byTestId('map-wave');
  const paths = svg === null ? [] : [...svg.querySelectorAll('path')];
  const points: Point[] = [];
  let totalLength = 0;
  let halfStroke = 0;
  for (const path of paths) {
    const ctm = path.getScreenCTM();
    const length = path.getTotalLength();
    if (ctm === null) continue;
    totalLength += length;
    halfStroke = Math.max(halfStroke, Number.parseFloat(getComputedStyle(path).strokeWidth) / 2);
    for (let at = 0; at <= length; at += step) {
      const local = path.getPointAtLength(at);
      const onPage = new DOMPoint(local.x, local.y).matrixTransform(ctm);
      points.push({ x: onPage.x, y: onPage.y });
    }
  }
  return { pathCount: paths.length, totalLength, halfStroke, points };
}

/** Every `stage-hotspot-*` with its place in document order and the extent of what it holds. */
function collectHotspots(): Hotspot[] {
  const all = [...document.body.querySelectorAll('*')];
  return [...document.querySelectorAll('[data-testid^="stage-hotspot-"]')].map((el) => ({
    id: idOf(el),
    box: rectBox(el.getBoundingClientRect()),
    index: all.indexOf(el),
    span: el.querySelectorAll('*').length,
    content: contentOf(el),
  }));
}

/** Every `map-row-*` band with the stage numbers of the hotspots inside it. */
function collectBands(): Band[] {
  return [...document.querySelectorAll('[data-testid^="map-row-"]')].map((el) => ({
    id: idOf(el),
    box: rectBox(el.getBoundingClientRect()),
    stages: [
      ...new Set(
        [...el.querySelectorAll('[data-testid$="-1"][data-testid^="stage-hotspot-"]')].map((cell) =>
          Number.parseInt(idOf(cell).split('-')[2] ?? '', 10),
        ),
      ),
    ],
  }));
}

/** Measure the Map. Called after `collectTextCensus`, in the same frame. */
function collectMap(census: TextRecord[], step: number): MapMeasurement {
  const scrollEl = byTestId('map-scroll');
  // Only an element whose overflow actually scrolls is a scroller: a View
  // wearing the testID overflows too, and its scrollHeight says so, but a
  // reader cannot reach what it paints past the window.
  const overflowY = scrollEl === null ? '' : getComputedStyle(scrollEl).overflowY;
  const scrollSubtree =
    overflowY === 'auto' || overflowY === 'scroll' ? subtreeOf('map-scroll') : null;
  const lensEl = byTestId('map-magnifier');
  const chipEl = byTestId('you-are-here');
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    census,
    wave: sampleWave(step),
    grid: subtreeOf('map-grid'),
    lens: subtreeOf('map-magnifier'),
    lensRim: lensEl === null ? 0 : Number.parseFloat(getComputedStyle(lensEl).borderTopWidth),
    chip: chipEl === null ? null : rectBox(chipEl.getBoundingClientRect()),
    scroll:
      scrollEl === null || scrollSubtree === null
        ? null
        : {
            ...scrollSubtree,
            scrollHeight: scrollEl.scrollHeight,
            clientHeight: scrollEl.clientHeight,
          },
    hotspots: collectHotspots(),
    bands: collectBands(),
    badges: [...document.querySelectorAll('[data-testid^="stage-complete-"]')].map((el) => ({
      id: idOf(el),
      box: rectBox(el.getBoundingClientRect()),
    })),
  };
}

const MAP_PAGE_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  rectBox,
  byTestId,
  idOf,
  subtreeOf,
  contentOf,
  sampleWave,
  collectHotspots,
  collectBands,
  collectMap,
];

/**
 * One `page.evaluate` expression that waits two animation frames -- so layout
 * and the wave's re-anchoring have both painted -- and then censuses the text
 * and measures the Map in that one settled frame, so no number is read from a
 * different layout than another.
 */
export function mapMeasureScript(): string {
  const declarations = MAP_PAGE_FUNCTIONS.map((fn) => fn.toString()).join('\n');
  return (
    `(async () => {\n${declarations}\n` +
    'await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));\n' +
    `const census = ${textCensusScript()};\n` +
    `return collectMap(census, ${String(WAVE_SAMPLE_STEP_PX)});\n})()`
  );
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** Euclidean distance from a point to a box; zero inside it. */
function distanceToBox(point: Point, box: Box): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.w));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.h));
  return Math.hypot(dx, dy);
}

/**
 * The wave samples whose painted stroke reaches into `box` by more than
 * `tolerance`: a sample paints a disc of radius `halfStroke`, so it intrudes by
 * `halfStroke - distance`.
 */
export function strokeHits(
  box: Box,
  points: readonly Point[],
  halfStroke: number,
  tolerance: number,
): Point[] {
  return points.filter((point) => halfStroke - distanceToBox(point, box) > tolerance);
}

/** True when `inner` lies inside `outer`, forgiving `tolerance` at each edge. */
export function insideBox(inner: Box, outer: Box, tolerance: number): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.w <= outer.x + outer.w + tolerance &&
    inner.y + inner.h <= outer.y + outer.h + tolerance
  );
}

/**
 * True when every corner of `box` lies on the glass of a horizontal pill: the
 * `pill` box inset by its `rim`, whose ends are half-discs of half its inner
 * height. A corner past a rounded end is measured to that end's centre, so a
 * box can fill the straight run but not the pill's full bounding box.
 */
export function insidePill(box: Box, pill: Box, rim: number, tolerance: number): boolean {
  const radius = (pill.h - 2 * rim) / 2;
  const centreY = pill.y + pill.h / 2;
  const leftCentreX = pill.x + rim + radius;
  const rightCentreX = pill.x + pill.w - rim - radius;
  const corners: Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x, y: box.y + box.h },
    { x: box.x + box.w, y: box.y + box.h },
  ];
  return corners.every((corner) => {
    const nearestX = Math.min(Math.max(corner.x, leftCentreX), rightCentreX);
    return Math.hypot(corner.x - nearestX, corner.y - centreY) <= radius + tolerance;
  });
}

/** True when `box` is wholly on screen, forgiving `tolerance` at each edge. */
export function insideViewport(box: Box, viewport: ViewportSize, tolerance: number): boolean {
  return insideBox(box, { x: 0, y: 0, w: viewport.width, h: viewport.height }, tolerance);
}

/** True when the two boxes share a positive area. */
function intersects(a: Box, b: Box): boolean {
  const sharedWidth = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const sharedHeight = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return sharedWidth > 0 && sharedHeight > 0;
}

/** The boxes no intended cover (the magnifier pill) lies over. */
export function withoutCovers<T extends Box>(boxes: readonly T[], covers: readonly Box[]): T[] {
  return boxes.filter((box) => !covers.some((cover) => intersects(box, cover)));
}

/** True when a census record's element sits inside `subtree`'s element. */
export function within(record: TextRecord, subtree: Subtree): boolean {
  return record.index > subtree.index && record.index <= subtree.index + subtree.span;
}
