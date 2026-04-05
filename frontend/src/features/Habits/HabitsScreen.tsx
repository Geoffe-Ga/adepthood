// HabitsScreen.tsx

import { BarChart2, Check, MoreHorizontal, Pencil, Zap } from 'lucide-react';
import React from 'react';
import { ActivityIndicator, FlatList, Text, TouchableOpacity, View, Modal } from 'react-native';
import EmojiSelector from 'react-native-emoji-selector';
import { SafeAreaView } from 'react-native-safe-area-context';

import { spacing } from '../../design/tokens';
import useResponsive from '../../design/useResponsive';

import GoalModal from './components/GoalModal';
import HabitSettingsModal from './components/HabitSettingsModal';
import MissedDaysModal from './components/MissedDaysModal';
import OnboardingModal from './components/OnboardingModal';
import ReorderHabitsModal from './components/ReorderHabitsModal';
import StatsModal from './components/StatsModal';
import styles from './Habits.styles';
import type { Habit } from './Habits.types';
import HabitTile from './HabitTile';
import { generateStatsForHabit, calculateMissedDays } from './HabitUtils';
import { useHabits } from './hooks/useHabits';
import { useModalCoordinator } from './hooks/useModalCoordinator';

export { DEFAULT_ICONS, TARGET_UNITS, FREQUENCY_UNITS, DAYS_OF_WEEK } from './constants';
export { calculateNetEnergy } from './HabitUtils';

const HabitsScreen = () => {
  const { habits, loading, error, selectedHabit, setSelectedHabit, mode, setMode, actions, ui } =
    useHabits();

  const modals = useModalCoordinator();
  const { columns, gridGutter, scale, isLG, isXL } = useResponsive();
  const screenPadding = spacing(isLG || isXL ? 2 : 1, scale);

  const renderHabitTile = ({ item, index }: { item: Habit; index: number }) => (
    <HabitTile
      habit={item}
      onOpenGoals={() => {
        setSelectedHabit(item);
        if (mode === 'stats') {
          modals.open('stats');
        } else if (mode === 'edit') {
          modals.open('settings');
        } else if (mode === 'quickLog') {
          actions.logUnit(item.id!, 1);
        } else {
          modals.open('goal');
        }
      }}
      onLongPress={() => {
        setSelectedHabit(item);
        modals.open('settings');
      }}
      onIconPress={() => {
        actions.iconPress(index);
        modals.open('emojiPicker');
      }}
    />
  );

  return (
    <SafeAreaView style={[styles.container, { padding: screenPadding }]}>
      <View style={styles.topBar}>
        <View style={styles.overflowMenuContainer} testID="overflow-menu-wrapper">
          <TouchableOpacity
            testID="overflow-menu-toggle"
            onPress={modals.toggleMenu}
            style={{ padding: spacing(1, scale) }}
          >
            <MoreHorizontal size={spacing(3, scale)} />
          </TouchableOpacity>
          {modals.menu && (
            <View
              testID="overflow-menu"
              style={[styles.mobileMenu, { top: spacing(4, scale), right: 0 }]}
            >
              <TouchableOpacity
                onPress={() => {
                  setMode('quickLog');
                  modals.closeAll();
                }}
                style={{ paddingVertical: spacing(0.5, scale) }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Check size={spacing(2, scale)} style={{ marginRight: spacing(1, scale) }} />
                  <Text>Quick Log</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setMode('stats');
                  modals.closeAll();
                }}
                style={{ paddingVertical: spacing(0.5, scale) }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <BarChart2 size={spacing(2, scale)} style={{ marginRight: spacing(1, scale) }} />
                  <Text>Stats</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setMode('edit');
                  modals.closeAll();
                }}
                style={{ paddingVertical: spacing(0.5, scale) }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Pencil size={spacing(2, scale)} style={{ marginRight: spacing(1, scale) }} />
                  <Text>Edit</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  modals.open('onboarding');
                }}
                style={{ paddingVertical: spacing(0.5, scale) }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Zap size={spacing(2, scale)} style={{ marginRight: spacing(1, scale) }} />
                  <Text>Energy Scaffolding</Text>
                </View>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      {error && (
        <View style={styles.energyScaffoldingContainer}>
          <Text style={{ color: '#c00', marginBottom: 8 }}>{error}</Text>
          <TouchableOpacity
            testID="retry-button"
            onPress={() => void actions.loadHabits()}
            style={styles.energyScaffoldingButton}
          >
            <Text style={styles.energyScaffoldingButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator testID="loading-spinner" size="large" />
        </View>
      ) : (
        <FlatList
          key={`cols-${columns}`}
          testID="habits-list"
          data={habits.filter((h) => h.revealed)}
          keyExtractor={(item) => item.id?.toString() ?? item.name}
          renderItem={renderHabitTile}
          numColumns={columns}
          columnWrapperStyle={columns > 1 ? { gap: gridGutter } : undefined}
          contentContainerStyle={[
            styles.habitsGrid,
            {
              padding: gridGutter / 2,
              paddingBottom: gridGutter / 2,
            },
          ]}
        />
      )}

      {ui.showEnergyCTA && mode === 'normal' ? (
        <View style={styles.energyScaffoldingContainer}>
          <TouchableOpacity
            style={styles.energyScaffoldingButton}
            onPress={() => modals.open('onboarding')}
          >
            <Text style={styles.energyScaffoldingButtonText}>Perform Energy Scaffolding</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="archive-energy-cta"
            onPress={ui.archiveEnergyCTA}
            style={styles.archiveEnergyButton}
          >
            <Text>Archive This</Text>
          </TouchableOpacity>
        </View>
      ) : ui.showArchiveMessage ? (
        <Text style={styles.archivedMessage}>Energy Scaffolding button moved to menu.</Text>
      ) : null}

      {mode !== 'normal' && (
        <View style={styles.energyScaffoldingContainer}>
          <View style={styles.energyScaffoldingButton}>
            <Text style={styles.energyScaffoldingButtonText}>
              {mode === 'stats' ? 'Stats Mode' : mode === 'edit' ? 'Edit Mode' : 'Quick Log Mode'}
            </Text>
          </View>
          <TouchableOpacity
            testID="exit-mode"
            onPress={() => setMode('normal')}
            style={styles.archiveEnergyButton}
          >
            <Text>Exit</Text>
          </TouchableOpacity>
        </View>
      )}

      <GoalModal
        visible={modals.goal}
        habit={selectedHabit}
        onClose={() => modals.close('goal')}
        onUpdateGoal={actions.updateGoal}
        onLogUnit={actions.logUnit}
        onUpdateHabit={actions.updateHabit}
      />
      <StatsModal
        visible={modals.stats}
        habit={selectedHabit}
        stats={selectedHabit ? generateStatsForHabit(selectedHabit) : null}
        onClose={() => modals.close('stats')}
      />
      <HabitSettingsModal
        visible={modals.settings}
        habit={selectedHabit}
        onClose={() => modals.close('settings')}
        onUpdate={actions.updateHabit}
        onDelete={actions.deleteHabit}
        onOpenReorderModal={() => {
          modals.close('settings');
          modals.open('reorder');
        }}
        allHabits={habits}
      />
      <ReorderHabitsModal
        visible={modals.reorder}
        habits={habits}
        onClose={() => modals.close('reorder')}
        onSaveOrder={actions.saveHabitOrder}
      />
      <MissedDaysModal
        visible={modals.missedDays}
        habit={selectedHabit}
        missedDays={selectedHabit ? calculateMissedDays(selectedHabit) : []}
        onClose={() => modals.close('missedDays')}
        onBackfill={actions.backfillMissedDays}
        onNewStartDate={actions.setNewStartDate}
      />
      <OnboardingModal
        visible={modals.onboarding}
        onClose={() => modals.close('onboarding')}
        onSaveHabits={actions.onboardingSave}
      />
      {modals.emojiPicker && (
        <Modal transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={styles.emojiPickerModal}>
              <View style={styles.emojiPickerHeader}>
                <Text style={styles.emojiPickerTitle}>Select Icon</Text>
                <TouchableOpacity
                  style={styles.closeEmojiPicker}
                  onPress={() => modals.close('emojiPicker')}
                >
                  <Text style={styles.closeEmojiPickerText}>×</Text>
                </TouchableOpacity>
              </View>
              <EmojiSelector
                onEmojiSelected={actions.emojiSelect}
                showSearchBar
                columns={6}
                // @ts-ignore typing issue
                emojiSize={28}
              />
            </View>
          </View>
        </Modal>
      )}
    </SafeAreaView>
  );
};

export default HabitsScreen;
