import React from 'react';
import { Text, View } from 'react-native';

import type { HabitStoryStyles } from './HabitStory.styles';
import {
  heatGrid,
  gridRange,
  heatSummary,
  patternGrid,
  patternSummary,
  rateLine,
  storyDepth,
  tierColumns,
  tierStackSummary,
  tierTiles,
  TIME_OF_DAY_LABELS,
  unknownTimeNote,
} from './habitStoryPresentation';

import type { ApiHabitStory } from '@/api';
import { decorativeHidden } from '@/components/a11yHidden';
import { ChartTable, Columns, HeatGrid, columnTableRows, heatTableRows } from '@/components/charts';
import { chart } from '@/design/tokens';

const TIER_SERIES = ['Low', 'Clear', 'Stretch'] as const;
const WEEKDAY_ROWS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

interface ChartsProps {
  story: ApiHabitStory;
  habitName: string;
  tables: boolean;
  styles: HabitStoryStyles;
}

function DayGrid({ story, habitName, tables, styles }: ChartsProps) {
  const grid = heatGrid(story);
  return (
    <View testID="habit-story-section-days" style={styles.section}>
      <Text style={styles.sectionTitle}>Day by day</Text>
      {tables ? (
        <ChartTable rows={heatTableRows(grid.weeks)} headers={['Tier level', 'State']} />
      ) : (
        <HeatGrid
          testID="habit-story-heat-grid"
          weeks={grid.weeks}
          markers={grid.markers}
          summary={heatSummary(story, habitName)}
        />
      )}
      {grid.columnLabels.length > 0 ? <Text style={styles.caption}>{gridRange(grid)}</Text> : null}
    </View>
  );
}

export function RateLine({ story, styles }: { story: ApiHabitStory; styles: HabitStoryStyles }) {
  return (
    <Text testID="habit-story-rate" style={styles.rate}>
      {rateLine(story)}
    </Text>
  );
}

function TierTiles({ story, styles }: { story: ApiHabitStory; styles: HabitStoryStyles }) {
  return (
    <View testID="habit-story-tiers" style={styles.tiers}>
      {tierTiles(story).map((tile, index) => (
        <View
          key={tile.key}
          style={styles.tier}
          accessible
          accessibilityLabel={`${tile.label} ${tile.value}, ${tile.delta} on the thirty days before`}
        >
          <View
            style={[styles.tierSwatch, { backgroundColor: chart.tier[index] }]}
            {...decorativeHidden()}
          />
          <Text style={styles.tierText}>
            {`${tile.label} ${tile.value} `}
            <Text style={styles.tierDelta}>{`(${tile.delta})`}</Text>
          </Text>
        </View>
      ))}
    </View>
  );
}

function TierStack({
  story,
  tables,
  styles,
  stacked,
}: Omit<ChartsProps, 'habitName'> & { stacked: boolean }) {
  const columns = tierColumns(story);
  return (
    <View testID="habit-story-section-tiers" style={styles.section}>
      <Text style={styles.sectionTitle}>How deep, week by week</Text>
      <TierTiles story={story} styles={styles} />
      {stacked && tables ? (
        <ChartTable rows={columnTableRows(columns)} headers={[...TIER_SERIES, 'Quiet']} />
      ) : null}
      {stacked && !tables ? (
        <Columns
          testID="habit-story-tier-stack"
          columns={columns}
          seriesLabels={TIER_SERIES}
          summary={tierStackSummary(story)}
        />
      ) : null}
    </View>
  );
}

function Patterns({ story, tables, styles }: Omit<ChartsProps, 'habitName'>) {
  const grid = patternGrid(story);
  const note = unknownTimeNote(story);
  return (
    <View testID="habit-story-section-patterns" style={styles.section}>
      <Text style={styles.sectionTitle}>When you log it</Text>
      {tables ? (
        <ChartTable rows={heatTableRows(grid)} headers={['Level']} />
      ) : (
        <HeatGrid
          testID="habit-story-patterns"
          weeks={grid}
          rowLabels={WEEKDAY_ROWS}
          columnLabels={[...TIME_OF_DAY_LABELS]}
          summary={patternSummary(story)}
        />
      )}
      {note ? (
        <Text testID="habit-story-time-note" style={styles.caption}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** The Story's charts, each drawn only once the habit has the shape it needs (D09). */
export function HabitStoryCharts(props: ChartsProps) {
  const depth = storyDepth(props.story);
  return (
    <>
      {depth.charts ? <DayGrid {...props} /> : null}
      <RateLine story={props.story} styles={props.styles} />
      {depth.charts ? <TierStack {...props} stacked={depth.tierStack} /> : null}
      {depth.patterns ? <Patterns {...props} /> : null}
    </>
  );
}
