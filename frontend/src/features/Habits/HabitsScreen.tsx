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

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  scale: number;
}

const MenuItem = ({ icon, label, onPress, scale }: MenuItemProps) => (
  <TouchableOpacity onPress={onPress} style={{ paddingVertical: spacing(0.5, scale) }}>
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {icon}
      <Text>{label}</Text>
    </View>
  </TouchableOpacity>
);

const MODE_LABELS: Record<string, string> = {
  stats: 'Stats Mode',
  edit: 'Edit Mode',
  quickLog: 'Quick Log Mode',
};

const ModeBar = ({ mode, onExit }: { mode: string; onExit: () => void }) => (
  <View style={styles.energyScaffoldingContainer}>
    <View style={styles.energyScaffoldingButton}>
      <Text style={styles.energyScaffoldingButtonText}>{MODE_LABELS[mode] ?? mode}</Text>
    </View>
    <TouchableOpacity testID="exit-mode" onPress={onExit} style={styles.archiveEnergyButton}>
      <Text>Exit</Text>
    </TouchableOpacity>
  </View>
);

const openModalForMode = (
  mode: string,
  modals: ReturnType<typeof useModalCoordinator>,
  actions: ReturnType<typeof useHabits>['actions'],
  itemId: number,
) => {
  if (mode === 'stats') modals.open('stats');
  else if (mode === 'edit') modals.open('settings');
  else if (mode === 'quickLog') actions.logUnit(itemId, 1);
  else modals.open('goal');
};

interface OverflowMenuProps {
  scale: number;
  menuVisible: boolean;
  onToggle: () => void;
  onSelectMode: (_mode: 'quickLog' | 'stats' | 'edit') => void;
  onOpenOnboarding: () => void;
}

const MENU_ITEMS: Array<{
  Icon: typeof Check;
  label: string;
  mode: 'quickLog' | 'stats' | 'edit' | null;
}> = [
  { Icon: Check, label: 'Quick Log', mode: 'quickLog' },
  { Icon: BarChart2, label: 'Stats', mode: 'stats' },
  { Icon: Pencil, label: 'Edit', mode: 'edit' },
  { Icon: Zap, label: 'Energy Scaffolding', mode: null },
];

const OverflowMenu = ({
  scale,
  menuVisible,
  onToggle,
  onSelectMode,
  onOpenOnboarding,
}: OverflowMenuProps) => {
  const iconMargin = { marginRight: spacing(1, scale) };
  return (
    <View style={styles.overflowMenuContainer} testID="overflow-menu-wrapper">
      <TouchableOpacity
        testID="overflow-menu-toggle"
        onPress={onToggle}
        style={{ padding: spacing(1, scale) }}
      >
        <MoreHorizontal size={spacing(3, scale)} />
      </TouchableOpacity>
      {menuVisible && (
        <View
          testID="overflow-menu"
          style={[styles.mobileMenu, { top: spacing(4, scale), right: 0 }]}
        >
          {MENU_ITEMS.map((item) => (
            <MenuItem
              key={item.label}
              icon={<item.Icon size={spacing(2, scale)} style={iconMargin} />}
              label={item.label}
              onPress={item.mode ? () => onSelectMode(item.mode!) : onOpenOnboarding}
              scale={scale}
            />
          ))}
        </View>
      )}
    </View>
  );
};

const EmojiPickerModal = ({
  onSelect,
  onClose,
}: {
  onSelect: (_emoji: string) => void;
  onClose: () => void;
}) => (
  <Modal transparent animationType="fade">
    <View style={styles.modalOverlay}>
      <View style={styles.emojiPickerModal}>
        <View style={styles.emojiPickerHeader}>
          <Text style={styles.emojiPickerTitle}>Select Icon</Text>
          <TouchableOpacity style={styles.closeEmojiPicker} onPress={onClose}>
            <Text style={styles.closeEmojiPickerText}>×</Text>
          </TouchableOpacity>
        </View>
        <EmojiSelector onEmojiSelected={onSelect} showSearchBar columns={6} emojiSize={28} />
      </View>
    </View>
  </Modal>
);

interface HabitModalsProps {
  modals: ReturnType<typeof useModalCoordinator>;
  selectedHabit: Habit | null;
  habits: Habit[];
  actions: ReturnType<typeof useHabits>['actions'];
}

const HabitDataModals = ({ modals, selectedHabit, actions }: Omit<HabitModalsProps, 'habits'>) => (
  <>
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
    <MissedDaysModal
      visible={modals.missedDays}
      habit={selectedHabit}
      missedDays={selectedHabit ? calculateMissedDays(selectedHabit) : []}
      onClose={() => modals.close('missedDays')}
      onBackfill={actions.backfillMissedDays}
      onNewStartDate={actions.setNewStartDate}
    />
  </>
);

const HabitModals = ({ modals, selectedHabit, habits, actions }: HabitModalsProps) => (
  <>
    <HabitDataModals modals={modals} selectedHabit={selectedHabit} actions={actions} />
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
    <OnboardingModal
      visible={modals.onboarding}
      onClose={() => modals.close('onboarding')}
      onSaveHabits={actions.onboardingSave}
    />
    {modals.emojiPicker && (
      <EmojiPickerModal
        onSelect={actions.emojiSelect}
        onClose={() => modals.close('emojiPicker')}
      />
    )}
  </>
);

const ErrorBanner = ({ error, onRetry }: { error: string; onRetry: () => void }) => (
  <View style={styles.energyScaffoldingContainer}>
    <Text style={{ color: '#c00', marginBottom: 8 }}>{error}</Text>
    <TouchableOpacity
      testID="retry-button"
      onPress={onRetry}
      style={styles.energyScaffoldingButton}
    >
      <Text style={styles.energyScaffoldingButtonText}>Retry</Text>
    </TouchableOpacity>
  </View>
);

const LoadingSpinner = () => (
  <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
    <ActivityIndicator testID="loading-spinner" size="large" />
  </View>
);

const EnergyCTA = ({ onOpen, onArchive }: { onOpen: () => void; onArchive: () => void }) => (
  <View style={styles.energyScaffoldingContainer}>
    <TouchableOpacity style={styles.energyScaffoldingButton} onPress={onOpen}>
      <Text style={styles.energyScaffoldingButtonText}>Perform Energy Scaffolding</Text>
    </TouchableOpacity>
    <TouchableOpacity
      testID="archive-energy-cta"
      onPress={onArchive}
      style={styles.archiveEnergyButton}
    >
      <Text>Archive This</Text>
    </TouchableOpacity>
  </View>
);

interface HabitListProps {
  habits: Habit[];
  columns: number;
  gridGutter: number;
  renderItem: (_info: { item: Habit; index: number }) => React.ReactElement;
}

const HabitList = ({ habits, columns, gridGutter, renderItem }: HabitListProps) => (
  <FlatList
    key={`cols-${columns}`}
    testID="habits-list"
    data={habits.filter((h) => h.revealed)}
    keyExtractor={(item) => item.id?.toString() ?? item.name}
    renderItem={renderItem}
    numColumns={columns}
    columnWrapperStyle={columns > 1 ? { gap: gridGutter } : undefined}
    contentContainerStyle={[
      styles.habitsGrid,
      { padding: gridGutter / 2, paddingBottom: gridGutter / 2 },
    ]}
  />
);

interface EnergyFooterProps {
  showCTA: boolean;
  showArchive: boolean;
  mode: string;
  onOpen: () => void;
  onArchive: () => void;
  onExitMode: () => void;
}

const EnergyFooter = ({
  showCTA,
  showArchive,
  mode,
  onOpen,
  onArchive,
  onExitMode,
}: EnergyFooterProps) => (
  <>
    {showCTA && mode === 'normal' && <EnergyCTA onOpen={onOpen} onArchive={onArchive} />}
    {!showCTA && showArchive && (
      <Text style={styles.archivedMessage}>Energy Scaffolding button moved to menu.</Text>
    )}
    {mode !== 'normal' && <ModeBar mode={mode} onExit={onExitMode} />}
  </>
);

const useHabitTileRenderer = (
  mode: string,
  modals: ReturnType<typeof useModalCoordinator>,
  actions: ReturnType<typeof useHabits>['actions'],
  setSelectedHabit: (_h: Habit) => void,
) => {
  const renderHabitTile = ({ item, index }: { item: Habit; index: number }) => (
    <HabitTile
      habit={item}
      onOpenGoals={() => {
        setSelectedHabit(item);
        openModalForMode(mode, modals, actions, item.id!);
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
  return renderHabitTile;
};

const HabitsScreen = () => {
  const { habits, loading, error, selectedHabit, setSelectedHabit, mode, setMode, actions, ui } =
    useHabits();
  const modals = useModalCoordinator();
  const { columns, gridGutter, scale, isLG, isXL } = useResponsive();
  const screenPadding = spacing(isLG || isXL ? 2 : 1, scale);
  const handleSelectMode = (m: 'quickLog' | 'stats' | 'edit') => {
    setMode(m);
    modals.closeAll();
  };
  const renderHabitTile = useHabitTileRenderer(mode, modals, actions, setSelectedHabit);

  return (
    <SafeAreaView style={[styles.container, { padding: screenPadding }]}>
      <View style={styles.topBar}>
        <OverflowMenu
          scale={scale}
          menuVisible={modals.menu}
          onToggle={modals.toggleMenu}
          onSelectMode={handleSelectMode}
          onOpenOnboarding={() => modals.open('onboarding')}
        />
      </View>
      {error && <ErrorBanner error={error} onRetry={() => void actions.loadHabits()} />}
      {loading ? (
        <LoadingSpinner />
      ) : (
        <HabitList
          habits={habits}
          columns={columns}
          gridGutter={gridGutter}
          renderItem={renderHabitTile}
        />
      )}
      <EnergyFooter
        showCTA={ui.showEnergyCTA}
        showArchive={ui.showArchiveMessage}
        mode={mode}
        onOpen={() => modals.open('onboarding')}
        onArchive={ui.archiveEnergyCTA}
        onExitMode={() => setMode('normal')}
      />
      <HabitModals
        modals={modals}
        selectedHabit={selectedHabit}
        habits={habits}
        actions={actions}
      />
    </SafeAreaView>
  );
};

export default HabitsScreen;
