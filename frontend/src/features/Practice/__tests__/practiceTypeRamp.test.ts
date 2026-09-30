/* global describe, it, expect */
import { StyleSheet } from 'react-native';

import { legalFontSizes } from '../../../../e2e/textCensus';
import { fonts, INTERACTIVE_TEXT_MIN } from '../../../design/tokens';
import { modePickerStyles } from '../components/ModePicker';
import { practiceStatsBlockStyles } from '../components/PracticeStatsBlock';
import { stageSelectorStyles } from '../components/StageSelector';
import { catalogListStyles } from '../screens/PracticeCatalogList';
import { practiceDetailStyles } from '../screens/PracticeDetailScreen';
import {
  groundingCompleteStyles,
  groundingHeaderStyles,
  MEDITATION_TIMER_LABEL,
} from '../views/shared';

/**
 * Every size the Practice player, catalog, details and mode picker set sits on the
 * Candle & Ink type ramp (#2963).
 *
 * A StyleSheet literal cannot know the window width, so a static size must be
 * legal at the phone AND the desktop profile the text census measures: the
 * intersection of ``legalFontSizes(390)`` and ``legalFontSizes(1280)``, the
 * same set ``src/design/__tests__/textCensus.test.ts`` pins to the tokens.
 */

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;
/** DESIGN.md "One face per role": no Practice region shows more than three sizes. */
const MAX_SIZES_PER_REGION = 3;

const desktopLegal = legalFontSizes(DESKTOP_WIDTH);
const STATIC_LEGAL = new Set([...legalFontSizes(PHONE_WIDTH)].filter((s) => desktopLegal.has(s)));

type Region =
  | 'player'
  | 'catalogChips'
  | 'catalogRows'
  | 'catalogChrome'
  | 'stagePicker'
  | 'detailHeader'
  | 'detailSections'
  | 'detailActions'
  | 'modePicker';

const REGIONS: readonly Region[] = [
  'player',
  'catalogChips',
  'catalogRows',
  'catalogChrome',
  'stagePicker',
  'detailHeader',
  'detailSections',
  'detailActions',
  'modePicker',
];

/** Every key the reader taps, sized or not, keyed to the one region it paints. */
const REGION: Readonly<Record<string, Region>> = {
  // The grounding player's header and its completion card, plus the session timer.
  'grounding.badge': 'player',
  'complete.completeTitle': 'player',
  'complete.completeBody': 'player',
  'session.timer': 'player',
  // The catalog's filter chips: the stage row and the mode-category row.
  'catalog.chipText': 'catalogChips',
  'stage.filterText': 'catalogChips',
  // A catalog row: name, subtitle and its Use button (its mode icon is drawn, not text).
  'catalog.rowName': 'catalogRows',
  'catalog.rowSubtitle': 'catalogRows',
  'catalog.rowUseText': 'catalogRows',
  // Catalog chrome: search, section titles, the load error and its retry.
  'catalog.search': 'catalogChrome',
  'catalog.sectionTitle': 'catalogChrome',
  'catalog.errorText': 'catalogChrome',
  'catalog.retryButtonText': 'catalogChrome',
  // The radio variant of the stage selector.
  'stage.radioText': 'stagePicker',
  // The details header: eyebrow, practice name, mode and duration badges.
  'detail.eyebrow': 'detailHeader',
  'detail.heading': 'detailHeader',
  'detail.badgeText': 'detailHeader',
  // The details body: section labels, their copy, the stats block.
  'detail.sectionLabel': 'detailSections',
  'detail.sectionText': 'detailSections',
  'detail.bullet': 'detailSections',
  'stats.heading': 'detailSections',
  // The details actions, the stage picker card and the load error.
  'detail.actionButtonText': 'detailActions',
  'detail.pickerHeading': 'detailActions',
  'detail.pickerCancelText': 'detailActions',
  'detail.errorText': 'detailActions',
  // The Create Practice wizard's mode picker: category, mode rows and New tag.
  'picker.categoryTitle': 'modePicker',
  'picker.categoryBlurb': 'modePicker',
  'picker.rowLabel': 'modePicker',
  'picker.rowDescription': 'modePicker',
  'picker.newBadgeText': 'modePicker',
};

/** Text the reader taps: held to the interactive floor, never a caption. */
const TAPPABLE = [
  'catalog.chipText',
  'stage.filterText',
  'catalog.rowUseText',
  'catalog.retryButtonText',
  'detail.actionButtonText',
  'detail.pickerCancelText',
] as const;

/** Digits and counts read at a glance: sans, with tabular figures so they never jitter. */
const READOUT = ['grounding.badge', 'session.timer'] as const;

const namespaced = (prefix: string, sheet: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(sheet).map(([key, style]) => [`${prefix}.${key}`, style]));

/** Every touched sheet under one namespace, so no key can mask another. */
const sheets: Readonly<Record<string, unknown>> = {
  ...namespaced('grounding', groundingHeaderStyles),
  ...namespaced('complete', groundingCompleteStyles),
  'session.timer': MEDITATION_TIMER_LABEL,
  ...namespaced('catalog', catalogListStyles),
  ...namespaced('stage', stageSelectorStyles),
  ...namespaced('stats', practiceStatsBlockStyles),
  ...namespaced('detail', practiceDetailStyles),
  ...namespaced('picker', modePickerStyles),
};

interface FlatText {
  fontSize?: number;
  fontFamily?: string;
  fontVariant?: readonly string[];
}

const flat = (key: string): FlatText =>
  (StyleSheet.flatten(sheets[key] as object) as FlatText | undefined) ?? {};

const sizeOf = (key: string): number | undefined => flat(key).fontSize;

const sized = Object.keys(sheets).filter((key) => typeof sizeOf(key) === 'number');

const keysIn = (regions: readonly Region[]): string[] =>
  sized.filter((key) => regions.includes(REGION[key] as Region));

const offRamp = (keys: readonly string[]): string[] =>
  keys
    .filter((key) => !STATIC_LEGAL.has(sizeOf(key) as number))
    .map((key) => `${key}=${sizeOf(key)}`)
    .sort();

describe('Practice player, catalog and details text is on the type ramp (#2963)', () => {
  it('derives the static-legal sizes as the 390 and 1280 ramps intersected', () => {
    expect([...STATIC_LEGAL].sort((a, b) => a - b)).toEqual([13, 14, 15, 16, 18, 20, 26, 34]);
  });

  it('files every sized style under exactly one region, so none escapes the rules below', () => {
    expect(sized.filter((key) => REGION[key] === undefined)).toEqual([]);
    expect(Object.keys(REGION).filter((key) => !sized.includes(key))).toEqual([]);
  });

  it('sets every static size on a step legal at both 390 and 1280', () => {
    expect(offRamp(keysIn(REGIONS))).toEqual([]);
  });

  it.each(READOUT)('sets the %s readout on a ramp step, in sans with tabular figures', (key) => {
    const style = flat(key);
    expect(STATIC_LEGAL.has(style.fontSize as number)).toBe(true);
    expect(style.fontVariant).toContain('tabular-nums');
    expect(style.fontFamily).toBe(fonts.sans);
    expect(style.fontFamily).not.toBe(fonts.serif);
  });

  it('holds tappable text to the interactive floor', () => {
    const unsized = TAPPABLE.filter((key) => sizeOf(key) === undefined);
    expect(unsized).toEqual([]);
    const below = TAPPABLE.filter((key) => (sizeOf(key) ?? 0) < INTERACTIVE_TEXT_MIN);
    expect(below).toEqual([]);
  });

  it.each(REGIONS)('shows at most three sizes in the %s region', (region) => {
    const sizes = new Set(keysIn([region]).map(sizeOf));
    expect(sizes.size).toBeLessThanOrEqual(MAX_SIZES_PER_REGION);
  });
});
