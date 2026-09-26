/* global describe, it, expect */
import {
  faces,
  leftEdges,
  legalFontSizes,
  offRampSizes,
  outsideParent,
  overlappingPairs,
  rawMarkup,
  summaryLine,
  type TextRecord,
} from '../../../e2e/textCensus';
import { editorialType, type, uiType } from '../tokens';

/**
 * The text census (#2948) measures screens in Chromium, where `tokens.ts`
 * cannot be imported (it pulls in react-native's `Platform`), so the census
 * carries its own copy of the type ramp. This suite is the bridge that keeps
 * the copy honest: the legal font-size set the census reports "off-ramp"
 * against is pinned to `type(width)`, `editorialType` and `uiType` themselves,
 * so a change to the tokens reds this test before it silently mis-reports.
 *
 * The three geometric rules are pinned on synthetic records because the walker
 * itself needs a laid-out DOM: a rule that quietly reported zero findings would
 * certify screens it never measured.
 */

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;
const TOLERANCE = 1;

const rampSizes = (width: number): number[] => {
  const ramp = type(width);
  return [
    ramp.display.fontSize,
    ramp.title.fontSize,
    ramp.heading.fontSize,
    ramp.body.fontSize,
    ramp.label.fontSize,
    ramp.caption.fontSize,
  ];
};

const editorialSizes = (): number[] => [
  editorialType.display.fontSize,
  editorialType.title.fontSize,
  editorialType.heading.fontSize,
  editorialType.body.fontSize,
  editorialType.note.fontSize,
  editorialType.caption.fontSize,
  editorialType.action.fontSize,
  editorialType.marginNote.fontSize,
];

/** A record whose visible box is its whole box, unless the override says otherwise. */
const record = (overrides: Partial<TextRecord>): TextRecord => ({
  text: 'Yellow prompts',
  fontSize: 16,
  fontFamily: 'system-ui',
  fontWeight: '400',
  color: 'rgb(26, 25, 16)',
  x: 35,
  y: 10,
  w: 100,
  h: 20,
  cover: 'none',
  visible: {
    x: overrides.x ?? 35,
    y: overrides.y ?? 10,
    w: overrides.w ?? 100,
    h: overrides.h ?? 20,
  },
  testId: 'journal-shelf',
  parent: { x: 0, y: 0, w: 390, h: 844 },
  index: 1,
  span: 0,
  ...overrides,
});

describe('text census ramp', () => {
  it('derives the legal font sizes at 390 from the tokens themselves', () => {
    expect(legalFontSizes(PHONE_WIDTH)).toEqual(
      new Set([...rampSizes(PHONE_WIDTH), ...editorialSizes(), uiType.button.fontSize]),
    );
  });

  it('derives the legal font sizes at 1280 from the tokens themselves', () => {
    expect(legalFontSizes(DESKTOP_WIDTH)).toEqual(
      new Set([...rampSizes(DESKTOP_WIDTH), ...editorialSizes(), uiType.button.fontSize]),
    );
  });

  it('reports only the sizes that are off the ramp, sorted and deduplicated', () => {
    const legal = legalFontSizes(PHONE_WIDTH);
    const records = [
      record({ fontSize: 16 }),
      record({ fontSize: 12 }),
      record({ fontSize: 48 }),
      record({ fontSize: 12 }),
    ];
    expect(offRampSizes(records, legal)).toEqual([12, 48]);
  });
});

describe('text census rules', () => {
  it('does not count text below the fold of a scrolling ancestor as outside its parent', () => {
    const below = record({ y: 900, h: 20, parent: { x: 0, y: 0, w: 390, h: 2400 } });
    expect(outsideParent([below], TOLERANCE)).toEqual([]);
  });

  it('flags text that leaves a non-scrolling ancestor by more than a pixel', () => {
    const spill = record({ x: 380, w: 40, parent: { x: 0, y: 0, w: 390, h: 100 } });
    expect(outsideParent([spill], TOLERANCE)).toHaveLength(1);
  });

  it('tolerates a sub-pixel spill and leaves anchorless text alone', () => {
    const half = record({ x: 0, w: 390.5, parent: { x: 0, y: 0, w: 390, h: 100 } });
    const loose = record({ x: 1000, testId: null, parent: null });
    expect(outsideParent([half, loose], TOLERANCE)).toEqual([]);
  });

  it('never reports a nested span against its own parent text', () => {
    const parent = record({ index: 3, span: 2, x: 10, y: 10, w: 100, h: 20 });
    const child = record({ index: 5, span: 0, x: 10, y: 10, w: 40, h: 20 });
    expect(overlappingPairs([parent, child], TOLERANCE)).toEqual([]);
  });

  it('reports two sibling boxes that share more than a pixel', () => {
    const a = record({ index: 3, span: 0, x: 10, y: 10, w: 100, h: 20 });
    const b = record({ index: 4, span: 0, x: 50, y: 15, w: 100, h: 20 });
    expect(overlappingPairs([a, b], TOLERANCE)).toEqual([[a, b]]);
  });

  it('does not report boxes that only touch or share a sub-pixel edge', () => {
    const a = record({ index: 3, span: 0, x: 10, y: 10, w: 100, h: 20 });
    const touching = record({ index: 4, span: 0, x: 110, y: 10, w: 100, h: 20 });
    const grazing = record({ index: 5, span: 0, x: 10, y: 29.5, w: 100, h: 20 });
    expect(overlappingPairs([a, touching, grazing], TOLERANCE)).toEqual([]);
  });

  it('does not report a row a scroller has clipped against the footer drawn over it', () => {
    // A tile scrolled under the grid's bottom edge: its box reaches the footer,
    // its visible strip is the two pixels still inside the grid.
    const tile = record({
      index: 3,
      span: 0,
      x: 52,
      y: 785,
      w: 89,
      h: 16,
      visible: { x: 52, y: 785, w: 89, h: 2 },
    });
    const footer = record({ index: 9, span: 0, x: 35, y: 787, w: 212, h: 17 });
    expect(overlappingPairs([tile, footer], TOLERANCE)).toEqual([]);
  });

  it('leaves a string under an opaque surface to that surface, whatever sits on it', () => {
    // The Map's magnifier glass over a stage watermark: the watermark's centre
    // hits the glass, the caption on the glass is the topmost thing at its own.
    const watermark = record({
      index: 3,
      span: 0,
      x: 162,
      y: 120,
      w: 125,
      h: 22,
      cover: 'surface',
    });
    const caption = record({ index: 9, span: 0, x: 197, y: 116, w: 74, h: 10, cover: 'none' });
    const sibling = record({ index: 12, span: 0, x: 180, y: 130, w: 108, h: 17, cover: 'surface' });
    expect(overlappingPairs([watermark, caption, sibling], TOLERANCE)).toEqual([]);
  });

  it('still reports a string drawn straight over another', () => {
    const under = record({ index: 3, span: 0, x: 10, y: 10, w: 100, h: 20, cover: 'text' });
    const over = record({ index: 9, span: 0, x: 10, y: 10, w: 100, h: 20, cover: 'none' });
    expect(overlappingPairs([under, over], TOLERANCE)).toEqual([[under, over]]);
  });

  it('does not mistake the element just past a subtree for one of its descendants', () => {
    const a = record({ index: 1, span: 1, x: 10, y: 10, w: 100, h: 20 });
    const inside = record({ index: 2, span: 0, x: 10, y: 10, w: 100, h: 20 });
    const after = record({ index: 3, span: 0, x: 10, y: 10, w: 100, h: 20 });
    expect(overlappingPairs([a, inside, after], TOLERANCE)).toEqual([
      [a, after],
      [inside, after],
    ]);
  });

  it('catches raw markup and leaves prose alone', () => {
    const records = [
      record({ text: '**bold**' }),
      record({ text: '[read](x)' }),
      record({ text: '## Heading' }),
      record({ text: 'snake__case' }),
      record({ text: 'a * b' }),
      record({ text: 'see [the map] for detail' }),
    ];
    expect(rawMarkup(records).map((r) => r.text)).toEqual([
      '**bold**',
      '[read](x)',
      '## Heading',
      'snake__case',
    ]);
  });

  it('counts distinct left edges and faces for the reviewer', () => {
    const records = [
      record({ x: 35.4, fontFamily: 'serif', fontSize: 13 }),
      record({ x: 62, fontFamily: 'serif', fontSize: 16 }),
      record({ x: 62.2, fontFamily: 'sans', fontSize: 16 }),
      record({ x: 35, fontFamily: 'serif', fontSize: 13 }),
    ];
    expect(leftEdges(records)).toEqual([35, 62]);
    expect(faces(records)).toEqual(['sans|16', 'serif|13', 'serif|16']);
  });

  it('prints the reviewer summary in the agreed shape', () => {
    const line = summaryLine('390x844', 'Journal shelf', {
      textNodes: 41,
      leftEdges: [35, 62, 75, 102],
      faces: 5,
      rawMarkup: 0,
      outsideParent: 0,
      overlaps: 2,
      offRamp: [12, 48],
    });
    expect(line).toBe(
      '390x844  Journal shelf  text nodes=41  left edges={35,62,75,102}  faces=5  ' +
        'raw-markup=0  outside-parent=0  overlaps=2  off-ramp={12,48}',
    );
  });
});
