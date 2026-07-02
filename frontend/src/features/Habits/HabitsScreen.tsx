// HabitsScreen.tsx

import {
  BarChart2,
  Check,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Unlock,
  Zap,
} from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { habits as habitsApi } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { STAGE_COLORS, STAGE_ORDER, spacing } from '../../design/tokens';
import useResponsive from '../../design/useResponsive';

import AddHabitModal from './components/AddHabitModal';
import GoalModal from './components/GoalModal';
import HabitEmojiPicker from './components/HabitEmojiPicker';
import { HabitsEmptyState } from './components/HabitsEmptyState';
import HabitSettingsModal from './components/HabitSettingsModal';
import MissedDaysModal from './components/MissedDaysModal';
import OnboardingModal from './components/OnboardingModal';
import ReorderHabitsModal from './components/ReorderHabitsModal';
import StatsModal from './components/StatsModal';
import { MAX_HABITS } from './constants';
import styles from './Habits.styles';
import type { AddHabitInput, Habit, HabitStatsData } from './Habits.types';
import HabitTile, { useTileLayout } from './HabitTile';
import {
  generateStatsForHabit,
  toLocalHabitStats,
  calculateMissedDays,
  isHabitLockedToday,
} from './HabitUtils';
import { useHabits } from './hooks/useHabits';
import { useModalCoordinator } from './hooks/useModalCoordinator';
import { usePagination } from './hooks/usePagination';

/** Habits per page — the ceiling that fills the screen 1-up on mobile and 2x5 on landscape/desktop. */
const HABITS_PER_PAGE = MAX_HABITS;

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  scale: number;
}

const MenuItem = ({ icon, label, onPress, scale }: MenuItemProps) => (
  <TouchableOpacity
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={label}
    style={{ paddingVertical: spacing(0.5, scale) }}
  >
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

export const ModeBar = ({ mode, onExit }: { mode: string; onExit: () => void }) => (
  <View style={styles.energyScaffoldingContainer}>
    <View style={styles.energyScaffoldingButton}>
      <Text style={styles.energyScaffoldingButtonText}>{MODE_LABELS[mode] ?? mode}</Text>
    </View>
    <TouchableOpacity
      testID="exit-mode"
      onPress={onExit}
      accessibilityRole="button"
      accessibilityLabel={`Exit ${MODE_LABELS[mode] ?? mode}`}
      style={styles.archiveEnergyButton}
    >
      <Text>Exit</Text>
    </TouchableOpacity>
  </View>
);

const openModalForMode = (
  mode: string,
  open: ReturnType<typeof useModalCoordinator>['open'],
  logUnit: ReturnType<typeof useHabits>['actions']['logUnit'],
  itemId: number,
) => {
  if (mode === 'stats') open('stats');
  else if (mode === 'edit') open('settings');
  else if (mode === 'quickLog') logUnit(itemId, 1);
  else open('goal');
};

interface OverflowMenuProps {
  scale: number;
  menuVisible: boolean;
  onToggle: () => void;
  onSelectMode: (_mode: 'quickLog' | 'stats' | 'edit') => void;
  onOpenOnboarding: () => void;
  onOpenAddHabit: () => void;
  allRevealed: boolean;
  onToggleReveal: () => void;
}

type MenuAction = 'quickLog' | 'stats' | 'edit' | 'addHabit' | 'onboarding';

const MENU_ITEMS: Array<{
  Icon: typeof Check;
  label: string;
  action: MenuAction;
}> = [
  { Icon: Check, label: 'Quick Log', action: 'quickLog' },
  { Icon: BarChart2, label: 'Stats', action: 'stats' },
  { Icon: Pencil, label: 'Edit', action: 'edit' },
  { Icon: Plus, label: 'Add Habit', action: 'addHabit' },
  { Icon: Zap, label: 'Energy Scaffolding', action: 'onboarding' },
];

interface OverflowMenuListProps {
  scale: number;
  iconMargin: { marginRight: number };
  handleMenuPress: (_action: MenuAction) => void;
  allRevealed: boolean;
  onToggleReveal: () => void;
}

const OverflowMenuList = ({
  scale,
  iconMargin,
  handleMenuPress,
  allRevealed,
  onToggleReveal,
}: OverflowMenuListProps) => {
  const RevealIcon = allRevealed ? Lock : Unlock;
  const revealLabel = allRevealed ? 'Lock Unstarted Habits' : 'Reveal All Habits';
  return (
    <View testID="overflow-menu" style={[styles.mobileMenu, { top: spacing(4, scale), right: 0 }]}>
      {MENU_ITEMS.map((item) => (
        <MenuItem
          key={item.label}
          icon={<item.Icon size={spacing(2, scale)} style={iconMargin} />}
          label={item.label}
          onPress={() => handleMenuPress(item.action)}
          scale={scale}
        />
      ))}
      <MenuItem
        key="reveal-toggle"
        icon={<RevealIcon size={spacing(2, scale)} style={iconMargin} />}
        label={revealLabel}
        onPress={onToggleReveal}
        scale={scale}
      />
    </View>
  );
};

export const OverflowMenu = ({
  scale,
  menuVisible,
  onToggle,
  onSelectMode,
  onOpenOnboarding,
  onOpenAddHabit,
  allRevealed,
  onToggleReveal,
}: OverflowMenuProps) => {
  const iconMargin = { marginRight: spacing(1, scale) };
  const handleMenuPress = (action: MenuAction) => {
    if (action === 'onboarding') onOpenOnboarding();
    else if (action === 'addHabit') onOpenAddHabit();
    else onSelectMode(action);
  };
  return (
    <View style={styles.overflowMenuContainer} testID="overflow-menu-wrapper">
      <TouchableOpacity
        testID="overflow-menu-toggle"
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel="Habit options menu"
        accessibilityState={{ expanded: menuVisible }}
        style={{ padding: spacing(1, scale) }}
      >
        <MoreHorizontal size={spacing(3, scale)} />
      </TouchableOpacity>
      {menuVisible && (
        <OverflowMenuList
          scale={scale}
          iconMargin={iconMargin}
          handleMenuPress={handleMenuPress}
          allRevealed={allRevealed}
          onToggleReveal={onToggleReveal}
        />
      )}
    </View>
  );
};

interface HabitModalsProps {
  modals: ReturnType<typeof useModalCoordinator>;
  selectedHabit: Habit | null;
  habitStats: HabitStatsData | null;
  habits: Habit[];
  actions: ReturnType<typeof useHabits>['actions'];
  onAddHabit: (_input: AddHabitInput) => Promise<void>;
}

/**
 * Missed-days for the modal, gated on modal-open. ``calculateMissedDays`` scans
 * every completion, so it must not run on the (frequent) closed-modal renders —
 * the modal is hidden unless ``open`` is set. Extracted so the gate is unit-testable.
 */
export const missedDaysFor = (
  open: boolean,
  habit: Habit | null,
): ReturnType<typeof calculateMissedDays> => (open && habit ? calculateMissedDays(habit) : []);

const HabitDataModals = ({
  modals,
  selectedHabit,
  habitStats,
  actions,
}: Omit<HabitModalsProps, 'habits' | 'onAddHabit'>) => (
  <>
    <GoalModal
      visible={modals.goal}
      habit={selectedHabit}
      onClose={() => modals.close('goal')}
      onUpdateGoal={actions.updateGoal}
      onUpdateGoalUnits={actions.updateGoalUnits}
      onLogUnit={actions.logUnit}
      onUpdateHabit={actions.updateHabit}
    />
    <StatsModal
      visible={modals.stats}
      habit={selectedHabit}
      stats={habitStats}
      onClose={() => modals.close('stats')}
    />
    <MissedDaysModal
      visible={modals.missedDays}
      habit={selectedHabit}
      missedDays={missedDaysFor(modals.missedDays, selectedHabit)}
      onClose={() => modals.close('missedDays')}
      onBackfill={actions.backfillMissedDays}
      onNewStartDate={actions.setNewStartDate}
    />
  </>
);

const HabitWriteModals = ({
  modals,
  selectedHabit,
  habits,
  actions,
  onAddHabit,
}: Omit<HabitModalsProps, 'habitStats'>) => (
  <>
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
    <AddHabitModal
      visible={modals.addHabit}
      onClose={() => modals.close('addHabit')}
      onAdd={onAddHabit}
    />
    <HabitEmojiPicker
      visible={modals.emojiPicker}
      onSelect={(emoji) => {
        actions.emojiSelect(emoji);
        modals.close('emojiPicker');
      }}
      onClose={() => modals.close('emojiPicker')}
    />
  </>
);

const HabitModals = (props: HabitModalsProps) => (
  <>
    <HabitDataModals
      modals={props.modals}
      selectedHabit={props.selectedHabit}
      habitStats={props.habitStats}
      actions={props.actions}
    />
    <HabitWriteModals
      modals={props.modals}
      selectedHabit={props.selectedHabit}
      habits={props.habits}
      actions={props.actions}
      onAddHabit={props.onAddHabit}
    />
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

export const EnergyCTA = ({ onOpen, onArchive }: { onOpen: () => void; onArchive: () => void }) => (
  <View style={styles.energyScaffoldingContainer}>
    <TouchableOpacity
      style={styles.energyScaffoldingButton}
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel="Perform Energy Scaffolding"
    >
      <Text style={styles.energyScaffoldingButtonText}>Perform Energy Scaffolding</Text>
    </TouchableOpacity>
    <TouchableOpacity
      testID="archive-energy-cta"
      onPress={onArchive}
      accessibilityRole="button"
      accessibilityLabel="Archive This energy scaffolding prompt"
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

export const HabitList = ({ habits, columns, gridGutter, renderItem }: HabitListProps) => {
  // Fixed row pitch = tile min-height + its top/bottom margins (gridGutter/2
  // each). Supplying getItemLayout lets the list skip async measurement and
  // restore scroll synchronously. Derived from the same useTileLayout the tiles
  // size themselves with, so there are no magic numbers and the two can't drift.
  const { tileMinHeight } = useTileLayout();
  const rowHeight = tileMinHeight + gridGutter;
  const getItemLayout = useCallback(
    (_data: ArrayLike<Habit> | null | undefined, index: number) => ({
      length: rowHeight,
      offset: rowHeight * Math.floor(index / columns),
      index,
    }),
    [rowHeight, columns],
  );
  return (
    <FlatList
      // ``key`` on numColumns is required, not incidental: RN's FlatList throws
      // an invariant ("Changing numColumns on the fly is not supported") when
      // numColumns changes on a live instance (FlatList.js), so a column flip
      // (portrait↔landscape) must remount. It only changes on that flip — not
      // on every render — and this grid is paginated to fit the viewport, so
      // there is no in-page scroll position to preserve.
      key={`cols-${columns}`}
      testID="habits-list"
      data={habits}
      keyExtractor={(item) => item.id?.toString() ?? item.name}
      renderItem={renderItem}
      numColumns={columns}
      getItemLayout={getItemLayout}
      columnWrapperStyle={columns > 1 ? { gap: gridGutter } : undefined}
      contentContainerStyle={[
        styles.habitsGrid,
        { padding: gridGutter / 2, paddingBottom: gridGutter / 2 },
      ]}
    />
  );
};

interface PaginationBarProps {
  page: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
  scale: number;
}

export const PaginationBar = ({ page, pageCount, onPrev, onNext, scale }: PaginationBarProps) => {
  const canPrev = page > 0;
  const canNext = page < pageCount - 1;
  const textSize = { fontSize: spacing(1.75, scale) };
  return (
    <View style={styles.paginationBar} testID="habits-pagination">
      <TouchableOpacity
        testID="pagination-prev"
        onPress={onPrev}
        disabled={!canPrev}
        accessibilityRole="button"
        accessibilityLabel="Previous page"
        accessibilityState={{ disabled: !canPrev }}
        style={[styles.paginationButton, !canPrev && styles.disabledButton]}
      >
        <Text style={[styles.paginationButtonText, textSize]}>Prev</Text>
      </TouchableOpacity>
      <Text style={[styles.paginationLabel, textSize]}>
        Page {page + 1} of {pageCount}
      </Text>
      <TouchableOpacity
        testID="pagination-next"
        onPress={onNext}
        disabled={!canNext}
        accessibilityRole="button"
        accessibilityLabel="Next page"
        accessibilityState={{ disabled: !canNext }}
        style={[styles.paginationButton, !canNext && styles.disabledButton]}
      >
        <Text style={[styles.paginationButtonText, textSize]}>Next</Text>
      </TouchableOpacity>
    </View>
  );
};

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

interface TileHandlers {
  handleOpenGoals: (_item: Habit) => void;
  handleLongPress: (_item: Habit) => void;
  handleIconPress: (_index: number) => void;
}

// Stable per-tile handlers: the tile binds these to its own habit/index, so
// unchanged rows keep identical prop references and React.memo skips them.
const useTileHandlers = (
  mode: string,
  open: ReturnType<typeof useModalCoordinator>['open'],
  actions: ReturnType<typeof useHabits>['actions'],
  setSelectedHabit: (_h: Habit) => void,
): TileHandlers => {
  // Depend on the specific stable function refs, not the whole ``actions``
  // object, so the memo optimization holds even if ``actions`` were ever
  // rebuilt per render (issue #468 review).
  const { iconPress, logUnit } = actions;
  const handleOpenGoals = useCallback(
    (item: Habit) => {
      setSelectedHabit(item);
      openModalForMode(mode, open, logUnit, item.id!);
    },
    [mode, open, logUnit, setSelectedHabit],
  );
  const handleLongPress = useCallback(
    (item: Habit) => {
      setSelectedHabit(item);
      open('settings');
    },
    [open, setSelectedHabit],
  );
  const handleIconPress = useCallback(
    (globalIndex: number) => {
      iconPress(globalIndex);
      open('emojiPicker');
    },
    [iconPress, open],
  );
  return { handleOpenGoals, handleLongPress, handleIconPress };
};

const useHabitTileRenderer = (
  mode: string,
  modals: ReturnType<typeof useModalCoordinator>,
  actions: ReturnType<typeof useHabits>['actions'],
  setSelectedHabit: (_h: Habit) => void,
  tz: string,
  pageOffset = 0,
) => {
  const { handleOpenGoals, handleLongPress, handleIconPress } = useTileHandlers(
    mode,
    modals.open,
    actions,
    setSelectedHabit,
  );
  const { unlockHabit } = actions;
  const renderHabitTile = useCallback(
    ({ item, index }: { item: Habit; index: number }) => {
      // Calendar-driven: unlocks when the anchored start_date arrives, not on the stale `revealed` flag — keeps Habits in lockstep with Map/Practice/Course.
      const isLocked = isHabitLockedToday(item);
      const globalIndex = pageOffset + index;
      // index is page-relative, so each page restarts the Beige → Clear Light gradient.
      const stageColor = STAGE_COLORS[STAGE_ORDER[index % STAGE_ORDER.length]!]!;
      return (
        <HabitTile
          habit={item}
          locked={isLocked}
          stageColor={stageColor}
          globalIndex={globalIndex}
          onOpenGoals={handleOpenGoals}
          onLongPress={handleLongPress}
          onIconPress={handleIconPress}
          onUnlockHabit={unlockHabit}
          tz={tz}
        />
      );
    },
    [pageOffset, tz, handleOpenGoals, handleLongPress, handleIconPress, unlockHabit],
  );
  return renderHabitTile;
};

const useHabitStats = (visible: boolean, habit: Habit | null): HabitStatsData | null => {
  const { token, userTimezone } = useAuth();
  const [stats, setStats] = useState<HabitStatsData | null>(null);

  const fetchStats = useCallback(
    (h: Habit) => {
      if (h.id == null) return;
      // ``userTimezone`` flows from the auth-context value populated by
      // /auth/login | signup | refresh -- closes BUG-FE-HABIT-002 / -207.
      // The API path is preferred (server already buckets in user TZ);
      // the local fallback path now also receives the user's zone so
      // weekday charts and current-streak agree across both branches.
      habitsApi
        .getStats(h.id, token ?? undefined)
        .then((apiStats) => setStats(toLocalHabitStats(apiStats)))
        .catch(() => setStats(generateStatsForHabit(h, userTimezone)));
    },
    [token, userTimezone],
  );

  useEffect(() => {
    if (visible && habit) {
      fetchStats(habit);
    } else {
      setStats(null);
    }
  }, [visible, habit, fetchStats]);

  return stats;
};

const useSelectMode = (
  setMode: (_m: 'quickLog' | 'stats' | 'edit') => void,
  closeAll: () => void,
) =>
  useCallback(
    (m: 'quickLog' | 'stats' | 'edit') => {
      setMode(m);
      closeAll();
    },
    [setMode, closeAll],
  );

const useToggleReveal = (
  habits: ReturnType<typeof useHabits>['habits'],
  actions: ReturnType<typeof useHabits>['actions'],
  closeAll: () => void,
) => {
  const allRevealed = habits.every((h) => h.revealed !== false);
  const handleToggleReveal = useCallback(() => {
    if (allRevealed) {
      actions.lockUnstartedHabits();
    } else {
      actions.revealAllHabits();
    }
    closeAll();
  }, [allRevealed, actions, closeAll]);
  return { allRevealed, handleToggleReveal };
};

interface HabitsContentProps {
  habits: Habit[];
  loading: boolean;
  error: string | null;
  columns: number;
  gridGutter: number;
  renderItem: (_info: { item: Habit; index: number }) => React.ReactElement;
  onRetry: () => void;
  onAddHabit: () => void;
  pagination: PaginationBarProps | null;
}

export const HabitsContent = ({
  habits,
  loading,
  error,
  columns,
  gridGutter,
  renderItem,
  onRetry,
  onAddHabit,
  pagination,
}: HabitsContentProps) => {
  // First-run guidance; suppressed during loading/error (audit-ux-07).
  const showEmpty = !loading && !error && habits.length === 0;
  return (
    <>
      {error && <ErrorBanner error={error} onRetry={onRetry} />}
      {loading && <LoadingSpinner />}
      {showEmpty && <HabitsEmptyState onAdd={onAddHabit} />}
      {/* List co-renders under the error banner (unchanged); only loading/empty replace it. */}
      {!loading && !showEmpty && (
        <>
          <HabitList
            habits={habits}
            columns={columns}
            gridGutter={gridGutter}
            renderItem={renderItem}
          />
          {pagination && (
            <PaginationBar
              page={pagination.page}
              pageCount={pagination.pageCount}
              onPrev={pagination.onPrev}
              onNext={pagination.onNext}
              scale={pagination.scale}
            />
          )}
        </>
      )}
    </>
  );
};

const useHabitsScreenState = () => {
  const habitsReturn = useHabits();
  const modals = useModalCoordinator();
  const habitStats = useHabitStats(modals.stats, habitsReturn.selectedHabit);
  const responsive = useResponsive();
  const { userTimezone } = useAuth();
  const pagination = usePagination(habitsReturn.habits.length, HABITS_PER_PAGE);
  const pageOffset = pagination.page * HABITS_PER_PAGE;
  const pagedHabits = useMemo(
    () => habitsReturn.habits.slice(pageOffset, pageOffset + HABITS_PER_PAGE),
    [habitsReturn.habits, pageOffset],
  );
  const handleSelectMode = useSelectMode(habitsReturn.setMode, modals.closeAll);
  const renderHabitTile = useHabitTileRenderer(
    habitsReturn.mode,
    modals,
    habitsReturn.actions,
    habitsReturn.setSelectedHabit,
    userTimezone,
    pageOffset,
  );
  const reveal = useToggleReveal(habitsReturn.habits, habitsReturn.actions, modals.closeAll);
  /**
   * Wrap addHabit so the modal can await it, the screen jumps to the page
   * containing the newly added row, and any in-flight failure surfaces via
   * the existing rollback toast before the modal closes.
   */
  const handleAddHabit = useCallback(
    async (input: AddHabitInput) => {
      await habitsReturn.actions.addHabit(input);
      pagination.goLast();
    },
    [habitsReturn.actions, pagination],
  );
  return {
    ...habitsReturn,
    modals,
    habitStats,
    responsive,
    pagination,
    pagedHabits,
    handleSelectMode,
    renderHabitTile,
    handleAddHabit,
    ...reveal,
  };
};

const buildPaginationProps = (
  pagination: ReturnType<typeof usePagination>,
  scale: number,
): PaginationBarProps | null =>
  pagination.pageCount > 1
    ? {
        page: pagination.page,
        pageCount: pagination.pageCount,
        onPrev: pagination.goPrev,
        onNext: pagination.goNext,
        scale,
      }
    : null;

const HabitsScreen = () => {
  const state = useHabitsScreenState();
  const { habits, loading, error, modals, actions, ui, responsive, pagination, pagedHabits } =
    state;
  const { columns, gridGutter, scale, isLG, isXL } = responsive;
  const paginationProps = buildPaginationProps(pagination, scale);
  return (
    <SafeAreaView style={[styles.container, { padding: spacing(isLG || isXL ? 2 : 1, scale) }]}>
      <View style={styles.topBar}>
        <OverflowMenu
          scale={scale}
          menuVisible={modals.menu}
          onToggle={modals.toggleMenu}
          onSelectMode={state.handleSelectMode}
          onOpenOnboarding={() => modals.open('onboarding')}
          onOpenAddHabit={() => modals.open('addHabit')}
          allRevealed={state.allRevealed}
          onToggleReveal={state.handleToggleReveal}
        />
      </View>
      <HabitsContent
        habits={pagedHabits}
        loading={loading}
        error={error}
        columns={columns}
        gridGutter={gridGutter}
        renderItem={state.renderHabitTile}
        onRetry={() => void actions.loadHabits()}
        onAddHabit={() => modals.open('addHabit')}
        pagination={paginationProps}
      />
      <EnergyFooter
        showCTA={ui.showEnergyCTA}
        showArchive={ui.showArchiveMessage}
        mode={state.mode}
        onOpen={() => modals.open('onboarding')}
        onArchive={ui.archiveEnergyCTA}
        onExitMode={() => state.setMode('normal')}
      />
      <HabitModals
        modals={modals}
        selectedHabit={state.selectedHabit}
        habitStats={state.habitStats}
        habits={habits}
        actions={actions}
        onAddHabit={state.handleAddHabit}
      />
    </SafeAreaView>
  );
};

export default HabitsScreen;
