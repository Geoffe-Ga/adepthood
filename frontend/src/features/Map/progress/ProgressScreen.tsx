import React from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import {
  arcSummary,
  birthMarkers,
  carryovers,
  cycleCaption,
  cycleLabels,
  cycleRows,
  energyColumns,
  energySummary,
  ENERGY_COLORS,
  ENERGY_SERIES,
  percent,
  ribbonBlocks,
  rhythmCaption,
  rhythmEnd,
  rhythmPoints,
  rhythmSummary,
  rhythmSwatches,
  rhythmTicks,
  rhythmVisible,
  RHYTHM_EARLY_LINE,
  youAreHere,
} from './progressPresentation';
import { useProgressOverview } from './useProgressOverview';

import type { ApiProgressOverview } from '@/api';
import { Columns, Dumbbells, Ribbon, Wave } from '@/components/charts';
import { ErrorFallback } from '@/components/ErrorFallback';
import { EditorialSection } from '@/components/layout/EditorialSection';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { ink, rhythm, type as typeRamp } from '@/design/tokens';

/** The opacity held figures are drawn at while their fresh copy is read. */
export const HELD_OVERVIEW_OPACITY = 0.5;
const PERCENT_MAX = 100;

type Overview = ApiProgressOverview;

function useText() {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return {
    body: [t.body, styles.body],
    caption: [t.caption, styles.caption],
  };
}

function ArcSection({ overview }: { overview: Overview }) {
  const text = useText();
  const here = youAreHere(overview);
  const brought = carryovers(overview);
  return (
    <EditorialSection title="The arc" testID="progress-arc">
      {here ? (
        <Text testID="progress-here" style={text.body}>
          {here}
        </Text>
      ) : null}
      <Ribbon
        testID="progress-ribbon"
        blocks={ribbonBlocks(overview)}
        currentWeek={overview.arc.current_week ?? undefined}
        markers={birthMarkers(overview)}
        summary={arcSummary(overview)}
      />
      {brought.length > 0 ? (
        <Text testID="progress-carryovers" style={text.caption}>
          {`Brought with you: ${brought.join(', ')}`}
        </Text>
      ) : null}
    </EditorialSection>
  );
}

function RhythmSection({ overview }: { overview: Overview }) {
  const text = useText();
  const caption = rhythmCaption(overview);
  const end = rhythmEnd(overview);
  return (
    <EditorialSection title="Your rhythm" testID="progress-rhythm">
      {rhythmVisible(overview) ? (
        <>
          <Wave
            testID="progress-wave"
            points={rhythmPoints(overview)}
            max={PERCENT_MAX}
            monthTicks={rhythmTicks(overview)}
            swatches={rhythmSwatches(overview)}
            summary={rhythmSummary(overview)}
          />
          {end ? <Text style={text.caption}>{end}</Text> : null}
          {caption ? (
            <Text testID="progress-rhythm-caption" style={text.body}>
              {caption}
            </Text>
          ) : null}
        </>
      ) : (
        <Text testID="progress-rhythm-early" style={text.body}>
          {RHYTHM_EARLY_LINE}
        </Text>
      )}
    </EditorialSection>
  );
}

function CycleSection({ overview }: { overview: Overview }) {
  const text = useText();
  const rows = cycleRows(overview);
  if (rows.length === 0) return null;
  const labels = cycleLabels(overview);
  return (
    <EditorialSection title="This pass and the last" testID="progress-cycles">
      <Dumbbells
        testID="progress-dumbbells"
        rows={rows}
        fromLabel={labels.from}
        toLabel={labels.to}
        format={percent}
        summary={`Per stage, the share of scheduled days kept in ${labels.from.toLowerCase()} and ${labels.to.toLowerCase()}.`}
      />
      <Text style={text.caption}>{cycleCaption(overview)}</Text>
    </EditorialSection>
  );
}

function EnergySection({ overview }: { overview: Overview }) {
  const text = useText();
  return (
    <EditorialSection title="Net energy per week" testID="progress-energy">
      <Text testID="progress-energy-formula" style={text.caption}>
        {overview.energy.formula}
      </Text>
      <Columns
        testID="progress-energy-columns"
        columns={energyColumns(overview)}
        seriesLabels={ENERGY_SERIES}
        seriesColors={ENERGY_COLORS}
        summary={energySummary(overview)}
      />
    </EditorialSection>
  );
}

function ProgressBody({ overview, held }: { overview: Overview; held: boolean }) {
  return (
    <View testID="progress-content" style={held ? { opacity: HELD_OVERVIEW_OPACITY } : undefined}>
      <ArcSection overview={overview} />
      <RhythmSection overview={overview} />
      <CycleSection overview={overview} />
      <EnergySection overview={overview} />
    </View>
  );
}

/**
 * The Map's Progress screen (#3528, epic #3519): the 36-week arc, the unnamed
 * rhythm wave, the comparison with the last pass and the energy ledger, all
 * drawn from ``GET /progress/overview``. Balance and trajectory, never altitude.
 */
export function ProgressScreen(): React.JSX.Element {
  const read = useProgressOverview();
  return (
    <ScreenScaffold testID="progress-screen">
      <ScreenHeader
        title="Your progress"
        titleHidden
        lead="Where you are in the arc, and the shape of your own rising and resting."
      />
      {read.error !== null ? (
        <View testID="progress-error" style={styles.error}>
          <ErrorFallback
            heading="Your progress could not load."
            onRetry={() => void read.refresh()}
            retryAccessibilityLabel="Try loading your progress again"
            retryTestID="progress-retry"
          />
        </View>
      ) : null}
      {read.overview ? <ProgressBody overview={read.overview} held={read.loading} /> : null}
    </ScreenScaffold>
  );
}

export default ProgressScreen;

const styles = StyleSheet.create({
  body: { color: ink.soft },
  caption: { color: ink.muted },
  error: { marginTop: rhythm.sectionGap },
});
