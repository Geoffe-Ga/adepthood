/* global describe, it, expect */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { StyleSheet } from 'react-native';
import type { TextStyle } from 'react-native';

import { legalFontSizes } from '../../../../e2e/textCensus';
import {
  editorialType,
  ink,
  INTERACTIVE_TEXT_MIN,
  onShowcase,
  rhythm,
} from '../../../design/tokens';
import styles, { markdownStyles } from '../Course.styles';

/**
 * Every size the Course landing, the chapter reader's chrome and the chapter
 * Markdown set sits on the Candle & Ink type ramp (#2964).
 *
 * The text census walks the Course LANDING only (`routeWalk.ts` opens /course
 * and never the ChapterReader overlay), so the reader's chrome, its error
 * states and the Markdown style map are held here instead: `off-ramp={}` in
 * the census says nothing about them.
 *
 * A StyleSheet literal cannot know the window width, so a static size must be
 * legal at the phone AND the desktop profile the census measures: the
 * intersection of ``legalFontSizes(390)`` and ``legalFontSizes(1280)``.
 */

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;
/** DESIGN.md "One face per role": no Course region shows more than three sizes. */
const MAX_SIZES_PER_REGION = 3;

const desktopLegal = legalFontSizes(DESKTOP_WIDTH);
const STATIC_LEGAL = new Set([...legalFontSizes(PHONE_WIDTH)].filter((s) => desktopLegal.has(s)));

type Region =
  | 'landingCover'
  | 'stageSelector'
  | 'stageMetadata'
  | 'introCard'
  | 'chapterList'
  | 'resources'
  | 'readerChrome'
  | 'readerSheetHead'
  | 'landingError'
  | 'readerError'
  | 'markdown';

const REGIONS: readonly Region[] = [
  'landingCover',
  'stageSelector',
  'stageMetadata',
  'introCard',
  'chapterList',
  'resources',
  'readerChrome',
  'readerSheetHead',
  'landingError',
  'readerError',
  'markdown',
];

/** Every sized key, keyed to the one region it paints. */
const REGION: Readonly<Record<string, Region>> = {
  // The showcase stage cover.
  'styles.stageCoverEyebrow': 'landingCover',
  'styles.stageCoverTitle': 'landingCover',
  'styles.stageCoverSubtitle': 'landingCover',
  'styles.stageCoverProgressLabel': 'landingCover',
  // The stage pills: a numeral, or a check once the stage is complete.
  'styles.stagePillText': 'stageSelector',
  'styles.stagePillCheck': 'stageSelector',
  // Spiral Dynamics / Growing Up rows and the stage progress bar's label.
  'styles.stageDetailLabel': 'stageMetadata',
  'styles.stageDetailValue': 'stageMetadata',
  'styles.progressBarLabel': 'stageMetadata',
  // The "Start here" introduction card.
  'styles.introCardLabel': 'introCard',
  'styles.introCardTitle': 'introCard',
  'styles.introCardSummary': 'introCard',
  // The "Chapters" spine and each chapter card beneath it.
  'styles.sectionBandLabel': 'chapterList',
  'styles.contentCardIconText': 'chapterList',
  'styles.contentCardTitle': 'chapterList',
  'styles.contentCardSubtitle': 'chapterList',
  'styles.contentCardStatusText': 'chapterList',
  // "From Aptitude Guru" and its chips.
  'styles.resourcesHeading': 'resources',
  'styles.resourceChipText': 'resources',
  // The reader's header row, its footer buttons and the read toast.
  'styles.viewerBackText': 'readerChrome',
  'styles.viewerTitle': 'readerChrome',
  'styles.buttonLabelOnAccent': 'readerChrome',
  'styles.readToastText': 'readerChrome',
  // The reader sheet's eyebrow, title and write-a-note invitation.
  'styles.readerEyebrow': 'readerSheetHead',
  'styles.readerTitle': 'readerSheetHead',
  'styles.readerWriteNoteLink': 'readerSheetHead',
  // The landing's load-error and loading-timeout states.
  'styles.emptyTitle': 'landingError',
  'styles.emptySubtitle': 'landingError',
  // The reader's load-error and empty states.
  'styles.readerErrorTitle': 'readerError',
  'styles.readerErrorSubtitle': 'readerError',
  // Chapter content, rendered by react-native-markdown-display.
  'markdown.body': 'markdown',
  'markdown.heading1': 'markdown',
  'markdown.heading2': 'markdown',
  'markdown.heading3': 'markdown',
};

/** Text the reader taps: held to the interactive floor, never a caption. */
const TAPPABLE = [
  'styles.resourceChipText',
  'styles.stagePillText',
  'styles.stagePillCheck',
  'styles.introCardTitle',
  'styles.contentCardTitle',
  'styles.buttonLabelOnAccent',
  'styles.viewerBackText',
  'styles.readerWriteNoteLink',
] as const;

/** The landing's sub-section labels: sentence-case muted captions (DESIGN.md "Eyebrows are eyebrows"). */
const SUB_LABELS = [
  'styles.stageDetailLabel',
  'styles.introCardLabel',
  'styles.resourcesHeading',
] as const;

/** Landing blocks whose text hangs from the screen gutter. */
const GUTTERED = [
  'headerBand',
  'stageSelectorContent',
  'stageCover',
  'resourcesPanel',
  'stageMetadata',
  'progressBarContainer',
  'introBand',
  'sectionBand',
] as const;

const namespaced = (prefix: string, sheet: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(sheet).map(([key, style]) => [`${prefix}.${key}`, style]));

/** Both sheets under one namespace, so no key can mask another. */
const sheets: Readonly<Record<string, unknown>> = {
  ...namespaced('styles', styles),
  ...namespaced('markdown', markdownStyles),
};

const flat = (key: string): TextStyle =>
  (StyleSheet.flatten(sheets[key] as object) as TextStyle | undefined) ?? {};

const sizeOf = (key: string): number | undefined => flat(key).fontSize;

const sized = Object.keys(sheets).filter((key) => typeof sizeOf(key) === 'number');

const keysIn = (regions: readonly Region[]): string[] =>
  sized.filter((key) => regions.includes(REGION[key] as Region));

const offRamp = (keys: readonly string[]): string[] =>
  keys
    .filter((key) => !STATIC_LEGAL.has(sizeOf(key) as number))
    .map((key) => `${key}=${sizeOf(key)}`)
    .sort();

// __dirname -> frontend/src/features/Course/__tests__; climb to the feature.
const FEATURE_ROOT = path.join(__dirname, '..');

/** Every non-test source file in the Course feature. */
const courseSources = (): string[] =>
  readdirSync(FEATURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .filter((entry) => !entry.name.includes('.test.'))
    .map((entry) => entry.name)
    .sort();

const SAME_LINE_KEY = /([A-Za-z_$][\w$]*)\s*:\s*\{/;
const PRECEDING_KEY = /^\s*([A-Za-z_$][\w$]*)\s*:\s*\{/;

/** The enclosing style-object key for a matched line, or null if none is found. */
function resolveKey(lines: string[], lineIndex: number): string | null {
  const sameLine = SAME_LINE_KEY.exec(lines[lineIndex] ?? '');
  if (sameLine) return sameLine[1] ?? null;
  for (let i = lineIndex - 1; i >= 0; i -= 1) {
    const preceding = PRECEDING_KEY.exec(lines[i] ?? '');
    if (preceding) return preceding[1] ?? null;
  }
  return null;
}

/** `file::styleKey` for every line of the given Course sources matching `pattern`. */
function usagesMatching(pattern: RegExp, files: readonly string[] = courseSources()): string[] {
  const found: string[] = [];
  for (const file of files) {
    const lines = readFileSync(path.join(FEATURE_ROOT, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!pattern.test(line)) return;
      found.push(`${file}::${resolveKey(lines, index) ?? '(unknown)'}`);
    });
  }
  return found.sort();
}

const UPPERCASE_USAGE = /textTransform:\s*'uppercase'/;
const FONT_SIZE_LITERAL = /fontSize:\s*\d/;
/**
 * Any ``fontSize`` a component could set: a key (``fontSize: SIZE``), a shorthand
 * (``{ fontSize }``) or a prop (``fontSize={SIZE}``). Prose that merely names the
 * property, as a comment may, is not followed by one of these.
 */
const FONT_SIZE_ANY = /\bfontSize\b\s*[:,}=]/;
/** The one Course source allowed to set a face: every size it sets is checked above. */
const STYLE_SHEET = 'Course.styles.ts';

describe('Course landing, reader chrome and chapter Markdown are on the type ramp (#2964)', () => {
  it('derives the static-legal sizes as the 390 and 1280 ramps intersected', () => {
    expect([...STATIC_LEGAL].sort((a, b) => a - b)).toEqual([13, 14, 15, 16, 18, 20, 26, 34]);
  });

  it('files every sized style under exactly one region, so none escapes the rules below', () => {
    expect(sized.filter((key) => REGION[key] === undefined)).toEqual([]);
    expect(Object.keys(REGION).filter((key) => !sized.includes(key))).toEqual([]);
  });

  it('every font size the Course landing, reader chrome and chapter markdown set sits on the static type ramp (legal at 390 and 1280)', () => {
    expect(offRamp(sized)).toEqual([]);
  });

  it.each(REGIONS)('shows at most three sizes in the %s region', (region) => {
    const sizes = new Set(keysIn([region]).map(sizeOf));
    expect(sizes.size).toBeLessThanOrEqual(MAX_SIZES_PER_REGION);
  });

  it('holds tappable text to the interactive floor', () => {
    expect(TAPPABLE.filter((key) => sizeOf(key) === undefined)).toEqual([]);
    expect(TAPPABLE.filter((key) => (sizeOf(key) ?? 0) < INTERACTIVE_TEXT_MIN)).toEqual([]);
  });

  it('sets chapter Markdown in the long-form editorial faces, not the chrome ramp', () => {
    expect(flat('markdown.heading2')).toMatchObject(editorialType.heading);
    const { fontFamily, fontSize, lineHeight } = editorialType.body;
    expect(flat('markdown.body')).toMatchObject({ fontFamily, fontSize, lineHeight });
    expect(flat('markdown.body').color).toBe(ink.primary);
    expect(flat('markdown.heading1').fontSize).toBe(editorialType.title.fontSize);
    expect(flat('markdown.heading3')).toMatchObject({ fontFamily, fontSize, fontWeight: '600' });
  });

  it('sets no font size as a numeric literal anywhere in the Course feature', () => {
    expect(usagesMatching(FONT_SIZE_LITERAL)).toEqual([]);
  });

  // The sheet is flattened and checked size by size above, but a component that set
  // its own size, even through a named constant, would reach no check here and, in
  // the reader, no census either. So components take their faces from the sheet.
  it('sets no font size in any Course component: faces come from Course.styles.ts', () => {
    const components = courseSources().filter((file) => file !== STYLE_SHEET);
    expect(components).toContain('ChapterReader.tsx');
    expect(usagesMatching(FONT_SIZE_ANY, components)).toEqual([]);
  });

  it('spends small caps only on the Chapters spine and the reader sheet eyebrow', () => {
    expect(usagesMatching(UPPERCASE_USAGE)).toEqual([
      'Course.styles.ts::readerEyebrow',
      'Course.styles.ts::sectionBandLabel',
    ]);
  });

  it.each(SUB_LABELS)('sets the %s sub-section label as a sentence-case muted caption', (key) => {
    const style = flat(key);
    expect(style).toMatchObject({
      fontFamily: editorialType.caption.fontFamily,
      fontSize: editorialType.caption.fontSize,
      color: ink.muted,
    });
    expect(style.textTransform).toBeUndefined();
    expect(style.letterSpacing).toBeUndefined();
  });

  it('keeps the cover eyebrow a sentence-case caption in the showcase muted ink', () => {
    const eyebrow = flat('styles.stageCoverEyebrow');
    expect(eyebrow.color).toBe(onShowcase.muted);
    expect(eyebrow.textTransform).toBeUndefined();
    expect(eyebrow.letterSpacing).toBeUndefined();
  });

  it.each(GUTTERED)('hangs the %s block from the screen gutter', (key) => {
    const style = StyleSheet.flatten(styles[key]) as {
      paddingHorizontal?: number;
      marginHorizontal?: number;
    };
    expect(style.paddingHorizontal ?? style.marginHorizontal).toBe(rhythm.screenPaddingH);
  });

  it('lets the intro card take the band gutter rather than adding an inset of its own', () => {
    const card = StyleSheet.flatten(styles.introCard) as { marginHorizontal?: number };
    expect(card.marginHorizontal).toBeUndefined();
  });

  it('stacks each stage detail value under its label and left-aligns the progress label', () => {
    const row = StyleSheet.flatten(styles.stageDetailRow) as { flexDirection?: string };
    expect(row.flexDirection).not.toBe('row');
    expect(flat('styles.progressBarLabel').textAlign).not.toBe('right');
  });

  it('keeps the chapter list clear of the bottom fade', () => {
    const list = StyleSheet.flatten(styles.contentListContent) as { paddingBottom?: number };
    expect(list.paddingBottom).toBe(rhythm.bottomFadeHeight);
  });
});
