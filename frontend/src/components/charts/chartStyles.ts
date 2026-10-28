import { StyleSheet } from 'react-native';

import {
  chartLayout,
  fonts,
  ink,
  INTERACTIVE_TEXT_MIN,
  SPACING,
  surface,
  touchTarget,
} from '@/design/tokens';

export const chartStyles = StyleSheet.create({
  frame: { alignSelf: 'stretch', maxWidth: '100%', minWidth: 0, gap: SPACING.sm },
  caption: {
    fontFamily: fonts.sans,
    fontSize: chartLayout.labelSize,
    color: ink.muted,
    flexShrink: 1,
  },
  axis: { flexDirection: 'row', justifyContent: 'space-between', gap: SPACING.sm },
  tick: {
    fontFamily: fonts.sans,
    fontSize: chartLayout.labelSize,
    color: ink.muted,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
  },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.md },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    maxWidth: '100%',
    flexShrink: 1,
  },
  swatch: {
    width: chartLayout.swatchSize,
    height: chartLayout.swatchSize,
    borderWidth: chartLayout.hairlineWidth,
    borderColor: surface.hairline,
  },
  table: { backgroundColor: surface.sunken, padding: SPACING.md, borderRadius: SPACING.sm },
  row: {
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
    borderBottomWidth: chartLayout.hairlineWidth,
    borderBottomColor: surface.hairline,
  },
  rowLabel: {
    fontFamily: fonts.sans,
    fontSize: chartLayout.labelSize,
    color: ink.primary,
    flexShrink: 1,
    maxWidth: '100%',
  },
  tableCell: { flexShrink: 1, minWidth: 0, maxWidth: '100%' },
  rowValues: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.md },
  number: {
    fontFamily: fonts.sans,
    fontSize: chartLayout.labelSize,
    fontVariant: ['tabular-nums'],
    color: ink.soft,
  },
  barLine: { flexDirection: 'row', alignItems: 'center', gap: chartLayout.plotInset, minWidth: 0 },
  barGraphic: { flexShrink: 1 },
  barValue: {
    fontFamily: fonts.sans,
    fontSize: chartLayout.labelSize,
    color: ink.soft,
    flexShrink: 1,
    maxWidth: '100%',
  },
  controls: { alignSelf: 'flex-end' },
  control: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  controlLabel: {
    color: ink.primary,
    fontSize: INTERACTIVE_TEXT_MIN,
    fontFamily: fonts.sans,
  },
  tooltip: {
    backgroundColor: surface.raised,
    borderColor: surface.hairline,
    borderWidth: chartLayout.hairlineWidth,
    padding: SPACING.md,
    borderRadius: SPACING.sm,
  },
});
