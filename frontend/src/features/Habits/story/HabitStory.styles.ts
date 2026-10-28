import { StyleSheet } from 'react-native';

import {
  BORDER_RADIUS,
  chart,
  fonts,
  ink,
  rhythm,
  SPACING,
  surface,
  touchTarget,
  type as typeRamp,
  uiType,
} from '@/design/tokens';

/** Below this width the four Glance tiles sit two by two. */
export const GLANCE_ROW_MIN_WIDTH = 560;
/** The opacity a held story is drawn at while its fresh copy is read. */
export const HELD_STORY_OPACITY = 0.5;
/** Lucide glyph size for the sheet's header and footer controls. */
export const STORY_ICON_SIZE = 20;

type TypeRamp = ReturnType<typeof typeRamp>;
/** Figures align in columns so a changing number does not jostle its row. */
const FIGURES = { fontVariant: ['tabular-nums' as const] };
const HAIRLINE = StyleSheet.hairlineWidth;
const control = {
  minHeight: touchTarget.minimum,
  minWidth: touchTarget.minimum,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
};

const chromeStyles = (type: TypeRamp) => ({
  screen: { flex: 1, backgroundColor: surface.canvas },
  header: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: SPACING.sm,
    paddingHorizontal: rhythm.screenPaddingH,
    paddingVertical: SPACING.sm,
    borderBottomWidth: HAIRLINE,
    borderBottomColor: surface.hairline,
  },
  title: { ...type.title, color: ink.primary, flex: 1, flexShrink: 1 },
  iconButton: control,
  menu: {
    alignItems: 'flex-end' as const,
    backgroundColor: surface.sunken,
    paddingHorizontal: rhythm.screenPaddingH,
  },
  control: { ...control, paddingHorizontal: SPACING.md },
  controlText: { ...uiType.button, fontFamily: fonts.sans, color: ink.primary },
  scroll: { flex: 1 },
  body: {
    paddingHorizontal: rhythm.screenPaddingH,
    paddingTop: rhythm.sectionGap,
    paddingBottom: rhythm.bottomFadeHeight,
  },
  stack: { gap: rhythm.sectionGap },
  shrink: { flexShrink: 1 },
  error: { gap: rhythm.blockGap },
});

const figureStyles = (type: TypeRamp, twoByTwo: boolean) => ({
  glance: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: SPACING.md },
  tile: {
    flexBasis: twoByTwo ? ('45%' as const) : 0,
    flexGrow: 1,
    minWidth: 0,
    backgroundColor: surface.raised,
    borderColor: surface.hairline,
    borderWidth: HAIRLINE,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  tileLabel: { ...type.caption, color: ink.muted },
  tileValue: { ...type.heading, ...FIGURES, color: ink.primary },
  rate: { ...type.body, ...FIGURES, color: ink.soft },
  tiers: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: SPACING.md },
  tier: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: SPACING.sm,
    flexGrow: 1,
    flexBasis: twoByTwo ? ('100%' as const) : 0,
    minWidth: 0,
  },
  tierSwatch: { width: SPACING.md, height: SPACING.md, borderRadius: BORDER_RADIUS.xs },
  tierText: { ...type.body, ...FIGURES, color: ink.primary, flexShrink: 1 },
  tierDelta: { ...type.caption, ...FIGURES, color: ink.muted },
});

const proseStyles = (type: TypeRamp) => ({
  section: {
    gap: rhythm.blockGap,
    borderTopWidth: HAIRLINE,
    borderTopColor: surface.hairline,
    paddingTop: rhythm.blockGap,
  },
  sectionTitle: { ...type.body, fontWeight: '600' as const, color: ink.primary },
  caption: { ...type.caption, color: ink.muted },
  prose: { ...type.body, color: ink.soft },
  note: {
    backgroundColor: surface.raised,
    borderLeftWidth: SPACING.xs,
    borderLeftColor: chart.tier[0],
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  milestone: { flexDirection: 'row' as const, gap: SPACING.md, alignItems: 'baseline' as const },
  milestoneDate: { ...type.caption, ...FIGURES, color: ink.muted, minWidth: SPACING.xxl * 2 },
  footer: { flexDirection: 'row' as const, justifyContent: 'flex-end' as const },
  footerAction: {
    ...control,
    flexDirection: 'row' as const,
    gap: SPACING.xs,
    paddingHorizontal: SPACING.sm,
  },
  footerText: { ...uiType.button, fontFamily: fonts.sans, color: ink.primary },
  logRow: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    gap: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: HAIRLINE,
    borderBottomColor: surface.hairline,
  },
  logWhen: { ...type.body, color: ink.primary, flexShrink: 1 },
  logAmount: { ...type.body, ...FIGURES, color: ink.primary },
});

export function createHabitStoryStyles(width: number) {
  const type = typeRamp(width);
  return StyleSheet.create({
    ...chromeStyles(type),
    ...figureStyles(type, width < GLANCE_ROW_MIN_WIDTH),
    ...proseStyles(type),
  });
}
export type HabitStoryStyles = ReturnType<typeof createHabitStoryStyles>;
