import { ChartLine, Table2 } from 'lucide-react-native';
import React, { useState } from 'react';
import { Text, Pressable, View, type LayoutChangeEvent } from 'react-native';

import { chartStyles } from './chartStyles';
import type { ChartBaseProps, ChartTableRow, LabelledSwatch } from './types';

import { decorativeHidden } from '@/components/a11yHidden';
import { accent, chartLayout, ink } from '@/design/tokens';
import { useResponsive } from '@/design/useResponsive';

/** Measures the actual parent, including sheets narrower than the viewport. */
export function useChartSize(width?: number, height: number = chartLayout.height) {
  const { contentWidth } = useResponsive();
  const [measuredWidth, setMeasuredWidth] = useState(contentWidth);
  const onLayout = (event: LayoutChangeEvent) => setMeasuredWidth(event.nativeEvent.layout.width);
  return { width: Math.max(1, Math.min(width ?? measuredWidth, measuredWidth)), height, onLayout };
}

export function ChartTable({
  rows,
  headers = [],
}: {
  rows: readonly ChartTableRow[];
  headers?: readonly string[];
}) {
  return (
    <View style={chartStyles.table}>
      {rows.length === 0 ? <Text style={chartStyles.caption}>No entries yet.</Text> : null}
      {rows.map((row, index) => (
        <View key={`${index}-${row.label}`} style={chartStyles.row}>
          <Text style={chartStyles.rowLabel}>{row.label}</Text>
          <View style={chartStyles.rowValues}>
            {row.values.map((value, column) => (
              <View key={column} style={chartStyles.tableCell}>
                {headers[column] ? (
                  <Text style={chartStyles.caption}>{headers[column]}</Text>
                ) : null}
                <Text style={chartStyles.number}>{value}</Text>
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

export function ChartLegend({ items }: { items: readonly LabelledSwatch[] }) {
  return (
    <View style={chartStyles.legend}>
      {items.map((item, index) => (
        <View key={`${index}-${item.label}`} style={chartStyles.legendItem}>
          <View style={[chartStyles.swatch, { backgroundColor: item.color }]} />
          <Text style={chartStyles.caption}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

interface ChartFrameProps extends ChartBaseProps {
  rows: readonly ChartTableRow[];
  headers?: readonly string[];
  children: React.ReactNode;
  interactive?: boolean;
  onLayout: (_event: LayoutChangeEvent) => void;
  /** What the chart shows, on the header row beside the table toggle. */
  title?: string;
  /** The chart's current figure, right-aligned before the toggle. */
  aside?: string;
}

/** Glyph size for the chart/table toggle, inside a full touch target. */
const TOGGLE_ICON_SIZE = 18;

/** The table twin's door: a glyph, named for what it opens (glyph over word). */
function TableToggle({ showTable, onPress }: { showTable: boolean; onPress: () => void }) {
  const label = showTable ? 'Show chart' : 'Show as table';
  const Glyph = showTable ? ChartLine : Table2;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: showTable }}
      onPress={onPress}
      style={chartStyles.control}
    >
      {({ pressed }) => (
        <Glyph
          size={TOGGLE_ICON_SIZE}
          color={pressed ? accent.primary : ink.soft}
          {...decorativeHidden()}
        />
      )}
    </Pressable>
  );
}

/** Static charts never introduce entrance motion, including under reduced motion. */
export function ChartFrame({
  summary,
  width,
  testID,
  rows,
  headers,
  children,
  onLayout,
  interactive = false,
  title,
  aside,
}: ChartFrameProps) {
  const [showTable, setShowTable] = useState(false);
  return (
    <View
      testID={testID}
      onLayout={onLayout}
      style={[chartStyles.frame, width === undefined ? undefined : { width }]}
    >
      <View style={chartStyles.header}>
        <Text style={[chartStyles.caption, chartStyles.headerTitle]}>{title ?? ''}</Text>
        {aside ? <Text style={chartStyles.aside}>{aside}</Text> : null}
        <TableToggle showTable={showTable} onPress={() => setShowTable(!showTable)} />
      </View>
      <View
        accessibilityRole={interactive ? undefined : 'image'}
        accessibilityLabel={summary}
        accessible={!interactive}
      >
        {showTable ? null : children}
      </View>
      {showTable ? <ChartTable rows={rows} headers={headers} /> : null}
    </View>
  );
}
