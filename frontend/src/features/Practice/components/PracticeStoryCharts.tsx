import React from 'react';
import { Text, View } from 'react-native';

import { modeBars, storyColumns, storyPoints, timeOfDayBars } from './PracticeStory.presentation';
import type { PracticeStoryStyles } from './PracticeStory.styles';

import type { PracticeStoryResponse } from '@/api';
import {
  ChartTable,
  Columns,
  DotStrip,
  HBars,
  barTableRows,
  columnTableRows,
  pointTableRows,
} from '@/components/charts';

interface Props {
  story: PracticeStoryResponse;
  stageName: string;
  timezone: string;
  tables: boolean;
  styles: PracticeStoryStyles;
}
export function PracticeStoryCharts({ story, stageName, timezone, tables, styles }: Props) {
  const columns = storyColumns(story);
  const times = timeOfDayBars(story);
  const modes = modeBars(story);

  return (
    <>
      <View testID="practice-story-section-weekly" style={styles.section}>
        <Text style={styles.title}>Your weekly rhythm</Text>
        {tables ? (
          <ChartTable rows={columnTableRows(columns)} headers={['Sits']} />
        ) : (
          <Columns
            testID="practice-story-weekly"
            columns={columns}
            seriesLabels={['Sits']}
            ask={{ value: story.weekly_target, label: `ask · ${story.weekly_target} sits` }}
            summary={`Sits per week for eight weeks. The weekly ask is ${story.weekly_target}; the latest week has ${story.weekly.at(-1)?.count ?? 0} sits.`}
          />
        )}
      </View>
      <PracticeSits {...{ story, stageName, timezone, tables, styles }} />
      <View testID="practice-story-section-time-of-day" style={styles.section}>
        <Text style={styles.title}>When you sit</Text>
        {tables ? (
          <ChartTable rows={barTableRows(times)} headers={['Sits']} />
        ) : (
          <HBars
            bars={times}
            valueHeader="Sits"
            summary={`When you sit: ${times.map((bar) => `${bar.label} ${bar.value} sits`).join(', ')}.`}
          />
        )}
      </View>
      {modes.length >= 2 ? (
        <View testID="practice-story-section-modes" style={styles.section}>
          <Text style={styles.title}>How you sit</Text>
          {tables ? (
            <ChartTable rows={barTableRows(modes)} headers={['Sits']} />
          ) : (
            <HBars
              bars={modes}
              valueHeader="Sits"
              summary={`How you sit: ${modes.map((bar) => `${bar.label} ${bar.value} sits`).join(', ')}.`}
            />
          )}
        </View>
      ) : null}
    </>
  );
}

function PracticeSits({ story, stageName, timezone, tables, styles }: Props) {
  const points = storyPoints(story, timezone);
  const ask =
    story.stage_ask_minutes === null
      ? undefined
      : {
          value: story.stage_ask_minutes,
          label: `${stageName} asks ${story.stage_ask_minutes} min`,
        };
  return (
    <View testID="practice-story-section-sits" style={styles.section}>
      <Text style={styles.title}>Your recent sits</Text>
      {tables ? (
        <ChartTable rows={pointTableRows(points)} headers={['Minutes', 'State']} />
      ) : (
        <DotStrip
          testID="practice-story-sits"
          points={points}
          valueHeader="Minutes"
          ask={ask}
          yTicks={ask && ask.value > 0 ? [0, ask.value] : [0]}
          summary={`The last ${points.length} counted sits in minutes, oldest to newest. Hollow dots ended early.${ask ? ` ${ask.label}.` : ''}`}
        />
      )}
      {story.stage_session_count > 0 ? (
        <Text
          style={styles.caption}
        >{`${story.stage_partial_sessions} of ${story.stage_session_count} sits this stage ended early; every minute counts toward your hours.`}</Text>
      ) : null}
    </View>
  );
}
