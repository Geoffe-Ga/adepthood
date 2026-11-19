/**
 * Week-by-week reading of a ribbon whose blocks each carry a note (#3746): a
 * Metta Return segment's five weeks, each read by touch, hover and keyboard as
 * a pass row's numbered habits are.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Rect } from 'react-native-svg';

import { chartStyles } from './chartStyles';
import { ribbonGeometry } from './geometry';
import { webInspection } from './RibbonPassMarks';
import type { RibbonBlock } from './types';

import { accent, chartLayout, ink, SPACING } from '@/design/tokens';

export const BLOCK_HINT =
  'Tap a week to read it. Use left and right arrow keys to move between weeks.';

/** `Week 3 · A face you barely know · this week`. */
export const blockDetail = (block: RibbonBlock, note: string | undefined): string =>
  note ? `${block.label} · ${note}` : block.label;

/** The block under `x`, in the plot's own coordinates; the nearest end beyond either edge. */
function blockAt(rects: readonly { x: number; width: number }[], x: number): number {
  const index = rects.findIndex((rect) => x < rect.x + rect.width);
  return index === -1 ? rects.length - 1 : index;
}

/** Which week is being read; travel is clamped to the first and last block. */
export function useBlockInspection(
  blocks: readonly RibbonBlock[],
  notes: readonly string[],
  width: number,
) {
  const [selected, setSelected] = useState<number | null>(null);
  const last = blocks.length - 1;
  const rects = ribbonGeometry(blocks, width);
  const selectAt = (x: number, _y: number) => {
    if (!Number.isFinite(x) || last < 0) return;
    setSelected(blockAt(rects, x - chartLayout.plotInset));
  };
  const move = (offset: number) =>
    setSelected(selected === null ? 0 : Math.max(0, Math.min(last, selected + offset)));
  const block = selected === null ? undefined : blocks[selected];
  return {
    selected,
    detail: block && selected !== null ? blockDetail(block, notes[selected]) : null,
    selectAt,
    move,
    web: webInspection(selectAt, move, setSelected, blocks.length),
  };
}

/** An outline round the week being read, whether it is drawn or still track. */
export function BlockFocus({
  blocks,
  width,
  selected,
}: {
  blocks: readonly RibbonBlock[];
  width: number;
  selected: number | null;
}) {
  const rect = selected === null ? undefined : ribbonGeometry(blocks, width)[selected];
  if (!rect) return null;
  return (
    <Rect
      testID="ribbon-block-focus"
      x={rect.x}
      y={0}
      width={rect.width}
      height={chartLayout.ribbonHeight}
      fill="none"
      stroke={accent.strong}
      strokeWidth={chartLayout.lineWidth}
    />
  );
}

/** The week being read, under the plot, where a pass row's habit readout sits. */
export function BlockReadout({ detail, testID }: { detail: string | null; testID?: string }) {
  if (!detail) return null;
  return (
    <View testID={`${testID}-notes`} style={styles.notes}>
      <Text testID={`${testID}-value`} style={[chartStyles.tick, styles.detail]}>
        {detail}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  detail: { color: ink.primary },
  notes: { marginTop: SPACING.sm, paddingLeft: chartLayout.plotInset },
});
