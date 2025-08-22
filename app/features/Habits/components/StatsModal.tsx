import React, { useState } from 'react';
import { View, Text, Dimensions, TouchableOpacity, Modal, ScrollView } from 'react-native';
import { Calendar, type MarkingProps } from 'react-native-calendars';
import { LineChart, BarChart } from 'react-native-chart-kit';

import { STAGE_COLORS } from '../../../constants/stageColors';
import styles from '../Habits.styles';
import type { StatsModalProps } from '../Habits.types';

export const StatsModal = ({ visible, habit, stats, onClose }: StatsModalProps) => {
  const [selectedTab, setSelectedTab] = useState('calendar');
  if (!habit || !stats) return null;

  const chartConfig = {
    backgroundGradientFrom: '#1E2923',
    backgroundGradientTo: '#08130D',
    color: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
    strokeWidth: 2,
    barPercentage: 0.7,
    useShadowColorFromDataset: false,
  };

  const lineData = {
    labels: stats.dates.slice(-7),
    datasets: [
      {
        data: stats.values.slice(-7),
        color: (opacity = 1) => STAGE_COLORS[habit.stage] || `rgba(134, 65, 244, ${opacity})`,
        strokeWidth: 2,
      },
    ],
    legend: ['Daily Progress'],
  };

  const barData = {
    labels: stats.dayLabels,
    datasets: [
      {
        data: stats.completionsByDay,
        color: (opacity = 1) => STAGE_COLORS[habit.stage] || `rgba(134, 65, 244, ${opacity})`,
      },
    ],
  };

  const getMarkedDates = () => {
    const marked: Record<string, MarkingProps> = {};
    if (!habit.completions) return marked;
    habit.completions.forEach((completion) => {
      const dateStr = new Date(completion.timestamp).toISOString().split('T')[0];
      marked[dateStr] = {
        selected: true,
        selectedColor: STAGE_COLORS[habit.stage] || '#50cebb',
      };
    });
    return marked;
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={[styles.statsModalContent, { borderTopColor: STAGE_COLORS[habit.stage] }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              {habit.name} Stats <Text style={styles.iconLarge}>{habit.icon}</Text>
            </Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>×</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.tabContainer}>
            <TouchableOpacity
              style={[styles.tabButton, selectedTab === 'calendar' && styles.activeTab]}
              onPress={() => setSelectedTab('calendar')}
            >
              <Text style={styles.tabButtonText}>Calendar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tabButton, selectedTab === 'progress' && styles.activeTab]}
              onPress={() => setSelectedTab('progress')}
            >
              <Text style={styles.tabButtonText}>Progress</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tabButton, selectedTab === 'byDay' && styles.activeTab]}
              onPress={() => setSelectedTab('byDay')}
            >
              <Text style={styles.tabButtonText}>By Day</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.statsContainer}>
            {selectedTab === 'calendar' && (
              <View style={styles.calendarContainer}>
                <Calendar
                  markedDates={getMarkedDates()}
                  theme={{
                    todayTextColor: '#00adf5',
                    selectedDayBackgroundColor: STAGE_COLORS[habit.stage],
                    arrowColor: STAGE_COLORS[habit.stage],
                  }}
                />
                <View style={styles.statsInfoContainer}>
                  <View style={styles.statsRow}>
                    <Text style={styles.statLabel}>Longest Streak:</Text>
                    <Text style={styles.statValue}>{stats.longestStreak} days</Text>
                  </View>
                  <View style={styles.statsRow}>
                    <Text style={styles.statLabel}>Current Streak:</Text>
                    <Text style={styles.statValue}>{habit.streak} days</Text>
                  </View>
                  <View style={styles.statsRow}>
                    <Text style={styles.statLabel}>Completion Rate:</Text>
                    <Text style={styles.statValue}>{Math.round(stats.completionRate * 100)}%</Text>
                  </View>
                  <View style={styles.statsRow}>
                    <Text style={styles.statLabel}>Total Completions:</Text>
                    <Text style={styles.statValue}>{stats.totalCompletions}</Text>
                  </View>
                </View>
              </View>
            )}
            {selectedTab === 'progress' && (
              <View style={styles.chartContainer}>
                <Text style={styles.chartTitle}>Progress (Last 7 Days)</Text>
                <LineChart
                  data={lineData}
                  width={Dimensions.get('window').width - 40}
                  height={220}
                  chartConfig={chartConfig}
                  bezier
                  style={styles.chart}
                />
              </View>
            )}
            {selectedTab === 'byDay' && (
              <View style={styles.chartContainer}>
                <Text style={styles.chartTitle}>Completions by Day of Week</Text>
                <BarChart
                  data={barData}
                  width={Dimensions.get('window').width - 40}
                  height={220}
                  chartConfig={chartConfig}
                  yAxisLabel=""
                  yAxisSuffix=""
                  style={styles.chart}
                  fromZero
                />
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

export default StatsModal;
