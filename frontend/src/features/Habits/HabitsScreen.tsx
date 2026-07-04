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
import { STAGE_COLORS, spacing } from '../../design/tokens';
import useResponsive from '../../design/useResponsive';

import AddHabitModal from './components/AddHabitModal';
import ConfirmDialog from './components/ConfirmDialog';
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
  isHabitUnlocked,
  stageAtIndex,
  stageRangeForPage,
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
  // Locking re-locks only untouched habits; the toggle label reflects that
  // it acts on unstarted habits. Unlocking-all is destructive enough (it
  // bypasses every per-tile confirm) to warrant its own confirmation.
  const revealLabel = allRevealed ? 'Lock Unstarted Habits' : 'Unlock All Habits';
  const [showUnlockAllConfirm, setShowUnlockAllConfirm] = useState(false);
  const handleRevealPress = () => {
    if (allRevealed) onToggleReveal();
    else setShowUnlockAllConfirm(true);
  };
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
        onPress={handleRevealPress}
        scale={scale}
      />
      <ConfirmDialog
        visible={showUnlockAllConfirm}
        title="Unlock all habits?"
        message="This opens every locked habit at once. You can always re-lock the ones you haven't started."
        testID="unlock-all-confirm"
        cancelTestID="unlock-all-cancel"
        confirmTestID="unlock-all-confirm-button"
        confirmLabel="Unlock All"
        onCancel={() => setShowUnlockAllConfirm(false)}
        onConfirm={() => {
          setShowUnlockAllConfirm(false);
          onToggleReveal();
        }}
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
  stageStart?: number;
  stageEnd?: number;
}

export const PaginationBar = ({
  page,
  pageCount,
  onPrev,
  onNext,
  scale,
  stageStart,
  stageEnd,
}: PaginationBarProps) => {
  const canPrev = page > 0;
  const canNext = page < pageCount - 1;
  const textSize = { fontSize: spacing(1.75, scale) };
  // The visible label names the stage range this page covers; the page position
  // (redundant for sighted users who read the range) is folded into this same
  // Text's accessibility label so screen readers announce where they are. The
  // label lives on the Text — an accessibility element — rather than the
  // container, whose own accessibleLabel would be swallowed by its focusable
  // children.
  const positionLabel = `Stages ${stageStart} to ${stageEnd}, page ${page + 1} of ${pageCount}`;
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
      <Text
        style={[styles.paginationLabel, textSize]}
        testID="pagination-label"
        accessibilityLabel={positionLabel}
      >
        Stages {stageStart}–{stageEnd}
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
      // Unlock is governed solely by the persisted ``revealed`` flag — locked by
      // default, opened only when the user chooses. Stage/calendar never gate it.
      const isLocked = !isHabitUnlocked(item);
      const globalIndex = pageOffset + index;
      // Anchor the tile color to its global position, not the page-relative one:
      // the mod-wrap inside stageAtIndex (over STAGE_ORDER's length) is what
      // restarts the Beige → Clear Light gradient on each lap, so a full first
      // lap and the second lap paint identically without page math here.
      const stageColor = STAGE_COLORS[stageAtIndex(globalIndex)]!;
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
  const allRevealed = habits.every(isHabitUnlocked);
  const handleToggleReveal = useCallback(() => {
    if (allRevealed) {
      actions.lockUntouchedHabits();
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
  /** Stage bounds for the current lap's empty state; omitted on the first-run page. */
  emptyStageStart?: number;
  emptyStageEnd?: number;
}

interface HabitsBodyProps {
  showEmpty: boolean;
  habits: Habit[];
  columns: number;
  gridGutter: number;
  renderItem: (_info: { item: Habit; index: number }) => React.ReactElement;
  onAddHabit: () => void;
  pagination: PaginationBarProps | null;
  emptyStageStart?: number;
  emptyStageEnd?: number;
}

// Empty state and list swap on showEmpty, but the pagination bar renders
// alongside either so a full lap's trailing invite page is never stranded
// without a way back to the populated laps.
const HabitsBody = ({
  showEmpty,
  habits,
  columns,
  gridGutter,
  renderItem,
  onAddHabit,
  pagination,
  emptyStageStart,
  emptyStageEnd,
}: HabitsBodyProps) => (
  <>
    {showEmpty && (
      <HabitsEmptyState onAdd={onAddHabit} stageStart={emptyStageStart} stageEnd={emptyStageEnd} />
    )}
    {!showEmpty && (
      <HabitList
        habits={habits}
        columns={columns}
        gridGutter={gridGutter}
        renderItem={renderItem}
      />
    )}
    {pagination && (
      <PaginationBar
        page={pagination.page}
        pageCount={pagination.pageCount}
        onPrev={pagination.onPrev}
        onNext={pagination.onNext}
        scale={pagination.scale}
        stageStart={pagination.stageStart}
        stageEnd={pagination.stageEnd}
      />
    )}
  </>
);

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
  emptyStageStart,
  emptyStageEnd,
}: HabitsContentProps) => {
  // First-run guidance; suppressed during loading/error (audit-ux-07).
  const showEmpty = !loading && !error && habits.length === 0;
  return (
    <>
      {error && <ErrorBanner error={error} onRetry={onRetry} />}
      {loading && <LoadingSpinner />}
      {!loading && (
        <HabitsBody
          showEmpty={showEmpty}
          habits={habits}
          columns={columns}
          gridGutter={gridGutter}
          renderItem={renderItem}
          onAddHabit={onAddHabit}
          pagination={pagination}
          emptyStageStart={emptyStageStart}
          emptyStageEnd={emptyStageEnd}
        />
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
  // Lap-aware empty-state copy applies only beyond the first page: page 0 keeps
  // the plain first-run guidance, while a trailing invite page names its stages.
  const isLapInvitePage = pagination.page > 0;
  const lapRange = stageRangeForPage(pagination.page, HABITS_PER_PAGE);
  const emptyStageStart = isLapInvitePage ? lapRange.start : undefined;
  const emptyStageEnd = isLapInvitePage ? lapRange.end : undefined;
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
    emptyStageStart,
    emptyStageEnd,
    handleSelectMode,
    renderHabitTile,
    handleAddHabit,
    ...reveal,
  };
};

const buildPaginationProps = (
  pagination: ReturnType<typeof usePagination>,
  scale: number,
): PaginationBarProps | null => {
  if (pagination.pageCount <= 1) return null;
  const { start, end } = stageRangeForPage(pagination.page, HABITS_PER_PAGE);
  return {
    page: pagination.page,
    pageCount: pagination.pageCount,
    onPrev: pagination.goPrev,
    onNext: pagination.goNext,
    scale,
    stageStart: start,
    stageEnd: end,
  };
};

interface HabitsContentSectionProps {
  state: ReturnType<typeof useHabitsScreenState>;
  columns: number;
  gridGutter: number;
  paginationProps: PaginationBarProps | null;
}

const HabitsContentSection = ({
  state,
  columns,
  gridGutter,
  paginationProps,
}: HabitsContentSectionProps) => (
  <HabitsContent
    habits={state.pagedHabits}
    loading={state.loading}
    error={state.error}
    columns={columns}
    gridGutter={gridGutter}
    renderItem={state.renderHabitTile}
    onRetry={() => void state.actions.loadHabits()}
    onAddHabit={() => state.modals.open('addHabit')}
    pagination={paginationProps}
    emptyStageStart={state.emptyStageStart}
    emptyStageEnd={state.emptyStageEnd}
  />
);

const HabitsScreen = () => {
  const state = useHabitsScreenState();
  const { habits, modals, actions, ui, responsive, pagination } = state;
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
      <HabitsContentSection
        state={state}
        columns={columns}
        gridGutter={gridGutter}
        paginationProps={paginationProps}
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
