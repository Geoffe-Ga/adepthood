/* global describe, it, expect */
import { StyleSheet } from 'react-native';

import { legalFontSizes } from '../../../../e2e/textCensus';
import { editorialType, INTERACTIVE_TEXT_MIN } from '../../../design/tokens';
import styles from '../Map.styles';
import { stageExpressionsStyles } from '../StageExpressionsSection';

/**
 * Every size the Map sets sits on the Candle & Ink type ramp (#2960).
 *
 * A StyleSheet literal cannot know the window width, so a static size must be
 * legal at the phone AND the desktop profile the text census measures: the
 * intersection of ``legalFontSizes(390)`` and ``legalFontSizes(1280)``, the
 * same set ``src/design/__tests__/textCensus.test.ts`` pins to the tokens.
 */

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;
/**
 * The one static size still off the ramp, owned by the fitted-grid follow-up to
 * #2960: at 13px the unlock estimate outgrows its half-lane at 390 and meets the
 * wave (map-legibility), so it moves with the fitted grid text, not here.
 */
const PENDING_KEY = 'unlockTimeline';
const PENDING_SIZE = 9;
/** DESIGN.md "One face per role": no Map region shows more than three sizes. */
const MAX_SIZES_PER_REGION = 3;

const desktopLegal = legalFontSizes(DESKTOP_WIDTH);
const STATIC_LEGAL = new Set([...legalFontSizes(PHONE_WIDTH)].filter((s) => desktopLegal.has(s)));

type Region = 'grid' | 'lens' | 'chrome' | 'modal';

/** Every style that sets a size, keyed to the one Map region it paints. */
const REGION: Readonly<Record<string, Region>> = {
  // The grid ring: stage copy, aspect labels, the watermark and its chips.
  personaText: 'grid',
  lineText: 'grid',
  arrowLabelText: 'grid',
  titleText: 'grid',
  lockText: 'grid',
  lockLeft: 'grid',
  unlockTimeline: 'grid',
  completedBadgeText: 'grid',
  // The glass magnifier riding the center column.
  magnifierHeadline: 'lens',
  magnifierDetail: 'lens',
  youAreHereText: 'lens',
  // Screen chrome: loading/error, refresh banner, journey header, Begin again.
  loadingText: 'chrome',
  errorText: 'chrome',
  emptyText: 'chrome',
  errorHint: 'chrome',
  errorRetryText: 'chrome',
  celebrationText: 'chrome',
  journeyReadText: 'chrome',
  cycleIndicator: 'chrome',
  beginAgainHeading: 'chrome',
  beginAgainBody: 'chrome',
  refreshBannerText: 'chrome',
  refreshRetryText: 'chrome',
  // The stage-detail modal, its history and its expressions section.
  closeText: 'modal',
  modalTitle: 'modal',
  modalSubtitle: 'modal',
  progressionSentence: 'modal',
  rankedStatValue: 'modal',
  rankedStatLabel: 'modal',
  progressLabel: 'modal',
  metadataLabel: 'modal',
  metadataValue: 'modal',
  freeWillDescription: 'modal',
  primaryActionText: 'modal',
  secondaryActionText: 'modal',
  historyTitle: 'modal',
  historyToggle: 'modal',
  historyEmpty: 'modal',
  historyErrorText: 'modal',
  historyRetryText: 'modal',
  historySubheading: 'modal',
  historyItemIcon: 'modal',
  historyItemName: 'modal',
  historyItemDetail: 'modal',
  goalBadgeText: 'modal',
  'expr.phaseEyebrow': 'modal',
  'expr.expressionHeading': 'modal',
  'expr.expressionName': 'modal',
  'expr.expressionDescription': 'modal',
};

/** Text the reader taps: held to the interactive floor, never a caption. */
const TAPPABLE = [
  'errorRetryText',
  'refreshRetryText',
  'closeText',
  'primaryActionText',
  'secondaryActionText',
  'historyTitle',
  'historyToggle',
  'historyRetryText',
] as const;

/** Both sheets under one namespace, the modal section's keys prefixed so none can mask another. */
const sheets: Readonly<Record<string, unknown>> = {
  ...styles,
  ...Object.fromEntries(
    Object.entries(stageExpressionsStyles).map(([key, style]) => [`expr.${key}`, style]),
  ),
};

const sizeOf = (key: string): number | undefined =>
  (StyleSheet.flatten(sheets[key] as object) as { fontSize?: number } | undefined)?.fontSize;

const sized = Object.keys(sheets).filter((key) => typeof sizeOf(key) === 'number');

const keysIn = (regions: readonly Region[]): string[] =>
  sized.filter((key) => regions.includes(REGION[key] as Region));

const offRamp = (keys: readonly string[]): string[] =>
  keys
    .filter((key) => !STATIC_LEGAL.has(sizeOf(key) as number))
    .map((key) => `${key}=${sizeOf(key)}`)
    .sort();

describe('Map text is on the type ramp (#2960)', () => {
  it('derives the static-legal sizes as the 390 and 1280 ramps intersected', () => {
    expect([...STATIC_LEGAL].sort((a, b) => a - b)).toEqual([13, 14, 15, 16, 18, 20, 26, 34]);
  });

  it('files every sized style under exactly one region, so none escapes the rules below', () => {
    expect(sized.filter((key) => REGION[key] === undefined)).toEqual([]);
    expect(Object.keys(REGION).filter((key) => !sized.includes(key))).toEqual([]);
  });

  it('sets every static size, the grid ring included, on a step legal at both 390 and 1280', () => {
    // Pinned to exactly the pending unlock estimate, so no other size can join it.
    expect(offRamp(keysIn(['grid', 'lens', 'chrome', 'modal']))).toEqual([
      `${PENDING_KEY}=${PENDING_SIZE}`,
    ]);
  });

  it('sets the grid ring stage copy in the sans ramp, the serif kept for the watermark alone', () => {
    const serif = keysIn(['grid']).filter(
      (key) =>
        (StyleSheet.flatten(sheets[key] as object) as { fontFamily?: string }).fontFamily ===
        editorialType.serif,
    );
    expect(serif).toEqual(['titleText']);
  });

  it('holds tappable text to the interactive floor', () => {
    const below = TAPPABLE.filter((key) => (sizeOf(key) ?? 0) < INTERACTIVE_TEXT_MIN);
    expect(below).toEqual([]);
  });

  it.each(['grid', 'lens', 'chrome', 'modal'] as const)(
    'shows at most three sizes in the %s region',
    (region) => {
      // The pending unlock estimate joins the grid's caption step once it is fitted.
      const counted = keysIn([region]).filter((key) => key !== PENDING_KEY);
      const sizes = new Set(counted.map(sizeOf));
      expect(sizes.size).toBeLessThanOrEqual(MAX_SIZES_PER_REGION);
    },
  );
});
