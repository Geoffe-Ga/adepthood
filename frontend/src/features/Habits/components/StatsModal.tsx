import React, { useEffect, useState } from 'react';
import { View, Text, useWindowDimensions, TouchableOpacity, Modal, ScrollView } from 'react-native';
import { Calendar } from 'react-native-calendars';
import { LineChart, BarChart } from 'react-native-chart-kit';

import { habits as habitsApi } from '../../../api';
import { CHART_AXIS_LABEL_COLOR, CHART_STYLE, SPACING, STAGE_COLORS } from '../../../design/tokens';
import styles from '../Habits.styles';
import type { HabitStatsData, StatsModalProps } from '../Habits.types';
import { generateStatsForHabit, toLocalHabitStats } from '../HabitUtils';

const FALLBACK_CHART_COLOR = 'rgba(134, 65, 244, 1)';
const FALLBACK_CALENDAR_COLOR = '#50cebb';

const MODAL_WIDTH_FRACTION = 0.9;
const MAX_CHART_WIDTH = 480;
// Mirrors statsModalContent (SPACING.lg) + statsContainer (SPACING.md) padding
// in Habits.styles.ts -- keep in sync if those rules change.
const CHART_CHROME = SPACING.lg * 2 + SPACING.md * 2;
const CHART_HEIGHT = 220;
const MIN_LABEL_OPACITY = 0.6;

const useChartWidth = (): number => {
  const { width } = useWindowDimensions();
  return Math.min(width * MODAL_WIDTH_FRACTION - CHART_CHROME, MAX_CHART_WIDTH);
};

const getStageColor = (stage: string, fallback: string): string => STAGE_COLORS[stage] || fallback;

const HEX_TRIPLET = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;

const parseHexRgb = (hex: string): [number, number, number] | null => {
  const match = HEX_TRIPLET.exec(hex);
  if (!match) return null;
  return [
    Number.parseInt(match[1]!, 16),
    Number.parseInt(match[2]!, 16),
    Number.parseInt(match[3]!, 16),
  ];
};

const AXIS_LABEL_RGB = parseHexRgb(CHART_AXIS_LABEL_COLOR);
const axisLabelColor = (opacity: number): string => {
  const op = Math.max(opacity, MIN_LABEL_OPACITY);
  if (!AXIS_LABEL_RGB) return CHART_AXIS_LABEL_COLOR;
  const [r, g, b] = AXIS_LABEL_RGB;
  return `rgba(${r}, ${g}, ${b}, ${op})`;
};

const buildChartConfig = (chartColor: string) => {
  const rgb = parseHexRgb(chartColor);
  const colorFn = rgb
    ? (opacity = 1) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${opacity})`
    : () => chartColor;

  return {
    ...CHART_STYLE,
    decimalPlaces: 0,
    color: colorFn,
    labelColor: axisLabelColor,
    propsForBackgroundLines: {
      stroke: CHART_AXIS_LABEL_COLOR,
      strokeOpacity: CHART_STYLE.axisLineOpacity,
      strokeDasharray: '4 6',
    },
    propsForLabels: { fontSize: 11 },
    barPercentage: 0.6,
    strokeWidth: 2,
    useShadowColorFromDataset: false,
  };
};

const buildMarkedDates = (
  completionDates: string[],
  stage: string,
): Record<string, { selected: boolean; selectedColor: string }> => {
  const marked: Record<string, { selected: boolean; selectedColor: string }> = {};
  const selectedColor = getStageColor(stage, FALLBACK_CALENDAR_COLOR);
  for (const dateStr of completionDates) {
    marked[dateStr] = { selected: true, selectedColor };
  }
  return marked;
};

interface StatRowProps {
  label: string;
  value: string;
}

const StatRow = ({ label, value }: StatRowProps) => (
  <View style={styles.statsRow}>
    <Text style={styles.statLabel}>{label}</Text>
    <Text style={styles.statValue}>{value}</Text>
  </View>
);

const TAB_NAMES = ['calendar', 'progress', 'byDay'] as const;
const TAB_LABELS: Record<string, string> = {
  calendar: 'Calendar',
  progress: 'Progress',
  byDay: 'By Day',
};

const buildLineData = (stats: HabitStatsData, color: string) => ({
  labels: stats.dayLabels,
  datasets: [{ data: stats.values, color: () => color, strokeWidth: 2 }],
  legend: ['Units logged'],
});

const buildBarData = (stats: HabitStatsData, color: string) => ({
  labels: stats.dayLabels,
  datasets: [{ data: stats.completionsByDay, color: () => color }],
});

interface TabBarProps {
  selectedTab: string;
  onSelect: (_tab: string) => void;
}

const TabBar = ({ selectedTab, onSelect }: TabBarProps) => (
  <View style={styles.tabContainer}>
    {TAB_NAMES.map((tab) => (
      <TouchableOpacity
        key={tab}
        style={[styles.tabButton, selectedTab === tab && styles.activeTab]}
        onPress={() => onSelect(tab)}
      >
        <Text style={styles.tabButtonText}>{TAB_LABELS[tab]}</Text>
      </TouchableOpacity>
    ))}
  </View>
);

interface CalendarTabProps {
  habit: { stage: string };
  stats: HabitStatsData;
}

const CalendarTab = ({ habit, stats }: CalendarTabProps) => (
  <View style={styles.calendarContainer}>
    <Calendar
      markedDates={buildMarkedDates(stats.completionDates, habit.stage)}
      theme={{
        todayTextColor: '#00adf5',
        selectedDayBackgroundColor: STAGE_COLORS[habit.stage],
        arrowColor: STAGE_COLORS[habit.stage],
      }}
    />
    <View style={styles.statsInfoContainer}>
      <StatRow label="Longest Streak:" value={`${stats.longestStreak} days`} />
      <StatRow label="Current Streak:" value={`${stats.currentStreak} days`} />
      <StatRow label="Completion Rate:" value={`${Math.round(stats.completionRate * 100)}%`} />
      <StatRow label="Total Completions:" value={`${stats.totalCompletions}`} />
    </View>
  </View>
);

interface ChartTabProps {
  title: string;
  children: React.ReactNode;
}

const ChartTab = ({ title, children }: ChartTabProps) => (
  <View style={styles.chartContainer}>
    <Text style={styles.chartTitle}>{title}</Text>
    {children}
  </View>
);

const StatsModalHeader = ({
  habit,
  onClose,
}: {
  habit: { name: string; icon: string };
  onClose: () => void;
}) => (
  <View style={styles.modalHeader}>
    <Text style={styles.modalTitle}>
      {habit.name} Stats <Text style={styles.iconLarge}>{habit.icon}</Text>
    </Text>
    <TouchableOpacity onPress={onClose} style={styles.closeButton}>
      <Text style={styles.closeButtonText}>×</Text>
    </TouchableOpacity>
  </View>
);

interface StatsContentProps {
  habit: NonNullable<StatsModalProps['habit']>;
  stats: HabitStatsData;
  selectedTab: string;
  onSelectTab: (_tab: string) => void;
  onClose: () => void;
  loading: boolean;
}

const StatsContent = (props: StatsContentProps) => {
  const { habit, stats, selectedTab, onSelectTab, onClose, loading } = props;
  const chartColor = getStageColor(habit.stage, FALLBACK_CHART_COLOR);
  const chartWidth = useChartWidth();
  const chartConfig = buildChartConfig(chartColor);

  return (
    <View style={[styles.statsModalContent, { borderTopColor: STAGE_COLORS[habit.stage] }]}>
      <StatsModalHeader habit={habit} onClose={onClose} />
      <TabBar selectedTab={selectedTab} onSelect={onSelectTab} />
      <ScrollView style={styles.statsContainer}>
        {loading && (
          <View style={styles.statsInfoContainer}>
            <Text style={styles.statLabel}>Loading stats...</Text>
          </View>
        )}
        {selectedTab === 'calendar' && <CalendarTab habit={habit} stats={stats} />}
        {selectedTab === 'progress' && (
          <ChartTab title="Units by Weekday">
            <LineChart
              data={buildLineData(stats, chartColor)}
              width={chartWidth}
              height={CHART_HEIGHT}
              chartConfig={chartConfig}
              bezier
              fromZero
              style={styles.chart}
            />
          </ChartTab>
        )}
        {selectedTab === 'byDay' && (
          <ChartTab title="Completions by Day of Week">
            <BarChart
              data={buildBarData(stats, chartColor)}
              width={chartWidth}
              height={CHART_HEIGHT}
              chartConfig={chartConfig}
              yAxisLabel=""
              yAxisSuffix=""
              style={styles.chart}
              fromZero
              showValuesOnTopOfBars
            />
          </ChartTab>
        )}
      </ScrollView>
    </View>
  );
};

export const StatsModal = ({ visible, habit, stats: localStats, onClose }: StatsModalProps) => {
  const [selectedTab, setSelectedTab] = useState('calendar');
  const [apiStats, setApiStats] = useState<HabitStatsData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !habit) {
      setApiStats(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    habitsApi
      .getStats(habit.id)
      .then((response) => {
        if (!cancelled) setApiStats(toLocalHabitStats(response));
      })
      .catch(() => {
        if (!cancelled) setApiStats(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [visible, habit]);

  if (!habit) return null;

  const stats = apiStats ?? localStats ?? generateStatsForHabit(habit);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <StatsContent
          habit={habit}
          stats={stats}
          selectedTab={selectedTab}
          onSelectTab={setSelectedTab}
          onClose={onClose}
          loading={loading}
        />
      </View>
    </Modal>
  );
};

export default StatsModal;
