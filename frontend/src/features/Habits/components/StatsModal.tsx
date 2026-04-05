import React, { useEffect, useState } from 'react';
import { View, Text, Dimensions, TouchableOpacity, Modal, ScrollView } from 'react-native';
import { Calendar } from 'react-native-calendars';
import { LineChart, BarChart } from 'react-native-chart-kit';

import { habits as habitsApi } from '../../../api';
import type { ApiHabitStats } from '../../../api';
import { STAGE_COLORS } from '../../../design/tokens';
import styles from '../Habits.styles';
import type { HabitStatsData, StatsModalProps } from '../Habits.types';
import { generateStatsForHabit } from '../HabitUtils';

const CHART_CONFIG = {
  backgroundGradientFrom: '#1E2923',
  backgroundGradientTo: '#08130D',
  color: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
  strokeWidth: 2,
  barPercentage: 0.7,
  useShadowColorFromDataset: false,
};

const CHART_WIDTH = Dimensions.get('window').width - 40;
const CHART_HEIGHT = 220;
const FALLBACK_CHART_COLOR = 'rgba(134, 65, 244, 1)';
const FALLBACK_CALENDAR_COLOR = '#50cebb';

const getStageColor = (stage: string, fallback: string): string => STAGE_COLORS[stage] || fallback;

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
  labels: stats.dates.slice(-7),
  datasets: [{ data: stats.values.slice(-7), color: () => color, strokeWidth: 2 }],
  legend: ['Daily Progress'],
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

/**
 * Convert an API stats response to the local HabitStatsData shape.
 */
function apiStatsToLocal(api: ApiHabitStats): HabitStatsData {
  return {
    dates: api.completion_dates,
    values: api.values,
    completionsByDay: api.completions_by_day,
    dayLabels: api.day_labels,
    longestStreak: api.longest_streak,
    currentStreak: api.current_streak,
    totalCompletions: api.total_completions,
    completionRate: api.completion_rate,
    completionDates: api.completion_dates,
  };
}

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
          <ChartTab title="Progress (Last 7 Days)">
            <LineChart
              data={buildLineData(stats, chartColor)}
              width={CHART_WIDTH}
              height={CHART_HEIGHT}
              chartConfig={CHART_CONFIG}
              bezier
              style={styles.chart}
            />
          </ChartTab>
        )}
        {selectedTab === 'byDay' && (
          <ChartTab title="Completions by Day of Week">
            <BarChart
              data={buildBarData(stats, chartColor)}
              width={CHART_WIDTH}
              height={CHART_HEIGHT}
              chartConfig={CHART_CONFIG}
              yAxisLabel=""
              yAxisSuffix=""
              style={styles.chart}
              fromZero
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
        if (!cancelled) setApiStats(apiStatsToLocal(response));
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
