import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  continuityLines,
  LEDGER_LOG_PAGE,
  ledgerCsv,
  ledgerFilename,
  ledgerJson,
  logDays,
  pageLogDays,
  rateLines,
  stageStrips,
  tierLabels,
  tierTotalLines,
  timeOfDayRows,
  untimedLine,
  weekdayLines,
  weeklyTierRows,
  type LedgerLine,
  type LedgerLogDay,
} from './ledgerPresentation';

import type { ApiHabitStory } from '@/api';
import { decorativeHidden } from '@/components/a11yHidden';
import { ChartTable, HeatGrid } from '@/components/charts';
import { chartLayout } from '@/design/tokens';
import type { HabitStoryStyles } from '@/features/Habits/story/HabitStory.styles';
import { TIME_OF_DAY_LABELS } from '@/features/Habits/story/habitStoryPresentation';
import { saveTextFile } from '@/features/Settings/saveDataExport';
import { formatTimeInTZ } from '@/utils/dateUtils';

/** One stage strip is a single row of day cells. */
const STRIP_HEIGHT = chartLayout.axisSpace + chartLayout.swatchSize * 2;
const MEDIA_TYPES = { csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8' };

export interface HabitLedgerProps {
  story: ApiHabitStory;
  habitName: string;
  timezone: string;
  styles: HabitStoryStyles;
}

function Section({
  title,
  testID,
  styles,
  children,
}: {
  title: string;
  testID: string;
  styles: HabitStoryStyles;
  children: React.ReactNode;
}) {
  return (
    <View testID={testID} style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Lines({ lines, styles }: { lines: LedgerLine[]; styles: HabitStoryStyles }) {
  return (
    <>
      {lines.map((line) => (
        <View key={line.label} style={styles.logRow} accessible>
          <Text style={styles.lineLabel}>{line.label}</Text>
          <Text style={styles.lineValue}>{line.value}</Text>
        </View>
      ))}
    </>
  );
}

function ByStage({ story, styles }: { story: ApiHabitStory; styles: HabitStoryStyles }) {
  const strips = stageStrips(story);
  return (
    <Section title="By stage" testID="habit-ledger-stages" styles={styles}>
      {strips.length === 0 ? <Text style={styles.caption}>No stage has opened yet.</Text> : null}
      {strips.map((strip) => (
        <View key={strip.stageNumber} style={styles.stack}>
          <View style={styles.milestone}>
            <View
              style={[styles.tierSwatch, { backgroundColor: strip.color }]}
              {...decorativeHidden()}
            />
            <Text style={styles.prose}>{strip.name}</Text>
          </View>
          <HeatGrid
            weeks={strip.cells.map((cell) => [cell])}
            rowLabels={['']}
            height={STRIP_HEIGHT}
            summary={`${strip.name}: ${strip.cells.length} days, one cell each.`}
          />
        </View>
      ))}
    </Section>
  );
}

function Tiers({ story, styles }: { story: ApiHabitStory; styles: HabitStoryStyles }) {
  const labels = tierLabels(story);
  const headers = [labels.low, labels.clear, labels.stretch, labels.under, labels.quiet];
  return (
    <Section title="Tiers" testID="habit-ledger-tiers" styles={styles}>
      <Lines lines={tierTotalLines(story)} styles={styles} />
      <Text style={styles.caption}>Week by week</Text>
      <ChartTable rows={weeklyTierRows(story)} headers={headers} />
    </Section>
  );
}

function Patterns({ story, styles }: { story: ApiHabitStory; styles: HabitStoryStyles }) {
  return (
    <Section title="Patterns" testID="habit-ledger-patterns" styles={styles}>
      <Text style={styles.caption}>By weekday</Text>
      <Lines lines={weekdayLines(story)} styles={styles} />
      <Text style={styles.caption}>By weekday and time of day</Text>
      <ChartTable rows={timeOfDayRows(story)} headers={TIME_OF_DAY_LABELS} />
      <Lines lines={[untimedLine(story)]} styles={styles} />
    </Section>
  );
}

function LogDay({ day, styles }: { day: LedgerLogDay; styles: HabitStoryStyles }) {
  return (
    <View testID={`habit-ledger-day-${day.date}`}>
      <Text style={styles.sectionTitle}>{day.heading}</Text>
      {day.rows.map((row) => (
        <View key={row.key} testID="habit-ledger-log" style={styles.logRow} accessible>
          <View style={styles.shrink}>
            <Text style={styles.logWhen}>{row.time}</Text>
            <Text style={styles.caption}>{row.source}</Text>
          </View>
          <Text style={styles.logAmount}>{row.amount}</Text>
        </View>
      ))}
      {day.untimed === null ? null : (
        <View style={styles.logRow} accessible>
          <Text style={styles.logWhen}>Time not recorded</Text>
          <Text style={styles.logAmount}>{day.untimed}</Text>
        </View>
      )}
    </View>
  );
}

function Logs({ story, timezone, styles }: Omit<HabitLedgerProps, 'habitName'>) {
  const [shown, setShown] = useState(LEDGER_LOG_PAGE);
  const all = logDays(story, (timestamp) => formatTimeInTZ(new Date(timestamp), timezone));
  const page = pageLogDays(all, shown);
  return (
    <Section title="Logs" testID="habit-ledger-logs" styles={styles}>
      {all.length === 0 ? <Text style={styles.caption}>No logs yet.</Text> : null}
      {page.days.map((day) => (
        <LogDay key={day.date} day={day} styles={styles} />
      ))}
      {page.more ? (
        <View style={styles.footer}>
          <Pressable
            testID="habit-ledger-more"
            accessibilityRole="button"
            onPress={() => setShown(shown + LEDGER_LOG_PAGE)}
            style={styles.footerAction}
          >
            <Text style={styles.footerText}>Show more</Text>
          </Pressable>
        </View>
      ) : null}
    </Section>
  );
}

type ExportState = { kind: 'idle' } | { kind: 'saved'; filename: string } | { kind: 'failed' };

function Export({ story, habitName, styles }: Omit<HabitLedgerProps, 'timezone'>) {
  const [state, setState] = useState<ExportState>({ kind: 'idle' });
  const save = (extension: 'csv' | 'json') => {
    const contents = extension === 'csv' ? ledgerCsv(story) : ledgerJson(story, habitName);
    const filename = ledgerFilename(habitName, story.today, extension);
    saveTextFile(filename, contents, MEDIA_TYPES[extension])
      .then((saved) => setState({ kind: 'saved', filename: saved.filename }))
      .catch(() => setState({ kind: 'failed' }));
  };
  return (
    <Section title="Export" testID="habit-ledger-export" styles={styles}>
      <Text style={styles.caption}>
        The days, the logs and the weekly tiers, as a file on this device.
      </Text>
      <View style={styles.footer}>
        {(['csv', 'json'] as const).map((extension) => (
          <Pressable
            key={extension}
            testID={`habit-ledger-export-${extension}`}
            accessibilityRole="button"
            onPress={() => save(extension)}
            style={styles.footerAction}
          >
            <Text style={styles.footerText}>{`Export ${extension.toUpperCase()}`}</Text>
          </Pressable>
        ))}
      </View>
      {state.kind === 'saved' ? (
        <Text
          testID="habit-ledger-export-saved"
          accessibilityLiveRegion="polite"
          style={styles.prose}
        >
          {`Saved ${state.filename}`}
        </Text>
      ) : null}
      {state.kind === 'failed' ? (
        <Text accessibilityLiveRegion="polite" style={styles.prose}>
          The file could not be saved. Try again.
        </Text>
      ) : null}
    </Section>
  );
}

/**
 * The Habit Ledger (#3529, epic #3519): behind the Story's "Everything" door,
 * every figure with its window and denominator, a table for every chart, the
 * raw logs grouped by day, and the series as a file of the person's own.
 */
export function HabitLedger({ story, habitName, timezone, styles }: HabitLedgerProps) {
  return (
    <View testID="habit-ledger" style={styles.stack}>
      <ByStage story={story} styles={styles} />
      <Section title="Continuity" testID="habit-ledger-continuity" styles={styles}>
        <Lines lines={continuityLines(story)} styles={styles} />
        <Lines lines={rateLines(story)} styles={styles} />
      </Section>
      <Tiers story={story} styles={styles} />
      <Patterns story={story} styles={styles} />
      <Logs story={story} timezone={timezone} styles={styles} />
      <Export story={story} habitName={habitName} styles={styles} />
    </View>
  );
}

export default HabitLedger;
