// The Habits header-drawer body. Replaces the removed in-body overflow menu and
// hosts, top to bottom: the action rows (Quick Log, Edit, Add Habit, Energy
// Scaffolding, Stats), the unlock-all confirm gate, the page-controls
// visibility switch, and the "Show Habits" pager row with its right-aligned
// Prev/range/Next cluster. Rendered as ScreenDrawer children by HabitsScreen.
import {
  BarChart2,
  Check,
  ChevronLeft,
  ChevronRight,
  Lock,
  Pencil,
  Plus,
  Unlock,
  Zap,
} from 'lucide-react-native';
import React, { useState } from 'react';
import {
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

import ConfirmDialog from './ConfirmDialog';

import { DrawerItem } from '@/components/drawer';
import { accent, ink, SPACING, surface, touchTarget, type } from '@/design/tokens';

/** Lucide glyph size in dp for the drawer's row and pager icons. */
const ICON_SIZE = 20;

type SelectableMode = 'quickLog' | 'stats' | 'edit';

export interface HabitsDrawerProps {
  onSelectMode: (_mode: SelectableMode) => void;
  onOpenOnboarding: () => void;
  onOpenAddHabit: () => void;
  allRevealed: boolean;
  onToggleReveal: () => void;
  page: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
  stageStart: number;
  stageEnd: number;
  barVisible: boolean;
  onToggleBarVisible: () => void;
  onClose: () => void;
}

interface ActionRowsProps {
  onSelectMode: (_mode: SelectableMode) => void;
  onOpenOnboarding: () => void;
  onOpenAddHabit: () => void;
  onClose: () => void;
}

/** The five mode/action rows; each fires its action then dismisses the drawer. */
function ActionRows({
  onSelectMode,
  onOpenOnboarding,
  onOpenAddHabit,
  onClose,
}: ActionRowsProps): React.JSX.Element {
  const rows: Array<{ Icon: typeof Check; label: string; run: () => void }> = [
    { Icon: Check, label: 'Quick Log', run: () => onSelectMode('quickLog') },
    { Icon: Pencil, label: 'Edit', run: () => onSelectMode('edit') },
    { Icon: Plus, label: 'Add Habit', run: onOpenAddHabit },
    { Icon: Zap, label: 'Energy Scaffolding', run: onOpenOnboarding },
    { Icon: BarChart2, label: 'Stats', run: () => onSelectMode('stats') },
  ];
  return (
    <>
      {rows.map((row) => (
        <DrawerItem
          key={row.label}
          label={row.label}
          icon={<row.Icon size={ICON_SIZE} color={accent.primary} />}
          onPress={() => {
            row.run();
            onClose();
          }}
        />
      ))}
    </>
  );
}

interface RevealRowProps {
  allRevealed: boolean;
  onToggleReveal: () => void;
  onClose: () => void;
}

/**
 * The unlock/lock-all row. Unlocking every habit at once bypasses each per-tile
 * confirm, so it is gated behind its own dialog; re-locking untouched habits is
 * reversible and fires directly.
 */
function RevealRow({ allRevealed, onToggleReveal, onClose }: RevealRowProps): React.JSX.Element {
  const [showConfirm, setShowConfirm] = useState(false);
  const label = allRevealed ? 'Lock Unstarted Habits' : 'Unlock All Habits';
  const RevealIcon = allRevealed ? Lock : Unlock;
  const confirmReveal = (): void => {
    setShowConfirm(false);
    onToggleReveal();
    onClose();
  };
  const handlePress = (): void => {
    if (allRevealed) {
      onToggleReveal();
      onClose();
    } else {
      setShowConfirm(true);
    }
  };
  return (
    <>
      <DrawerItem
        label={label}
        icon={<RevealIcon size={ICON_SIZE} color={accent.primary} />}
        onPress={handlePress}
      />
      <ConfirmDialog
        visible={showConfirm}
        title="Unlock all habits?"
        message="This opens every locked habit at once. You can always re-lock the ones you haven't started."
        testID="unlock-all-confirm"
        cancelTestID="unlock-all-cancel"
        confirmTestID="unlock-all-confirm-button"
        confirmLabel="Unlock All"
        onCancel={() => setShowConfirm(false)}
        onConfirm={confirmReveal}
      />
    </>
  );
}

interface VisibilityRowProps {
  barVisible: boolean;
  onToggleBarVisible: () => void;
}

/** Label-left, switch-right row governing the in-body pagination bar's visibility. */
function VisibilityRow({ barVisible, onToggleBarVisible }: VisibilityRowProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const visibilityLabel = barVisible ? 'Hide page controls' : 'Show page controls';
  return (
    <View style={styles.settingRow}>
      <Text style={[type(width).body, styles.rowLabel]}>{visibilityLabel}</Text>
      <Switch
        accessibilityRole="switch"
        accessibilityLabel={visibilityLabel}
        accessibilityState={{ checked: barVisible }}
        value={barVisible}
        onValueChange={onToggleBarVisible}
        trackColor={{ false: surface.hairline, true: accent.primary }}
        thumbColor={surface.raised}
      />
    </View>
  );
}

interface PaginationSectionProps {
  page: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
  stageStart: number;
  stageEnd: number;
}

/**
 * The "Show Habits" pager row: static label on the left, then a right-aligned
 * Prev/range/Next cluster whose range label also announces the page position.
 */
function PaginationSection({
  page,
  pageCount,
  onPrev,
  onNext,
  stageStart,
  stageEnd,
}: PaginationSectionProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const canPrev = page > 0;
  const canNext = page < pageCount - 1;
  const positionLabel = `Show habits ${stageStart} to ${stageEnd}, page ${page + 1} of ${pageCount}`;
  return (
    <View style={styles.settingRow} testID="drawer-pagination">
      <Text style={[type(width).body, styles.rowLabel]}>Show Habits</Text>
      <View style={styles.pagerCluster}>
        <TouchableOpacity
          onPress={onPrev}
          disabled={!canPrev}
          accessibilityRole="button"
          accessibilityLabel="Previous page"
          accessibilityState={{ disabled: !canPrev }}
          style={styles.pagerButton}
          testID="drawer-pagination-prev"
        >
          <ChevronLeft size={ICON_SIZE} color={canPrev ? accent.primary : ink.muted} />
        </TouchableOpacity>
        <Text
          style={[type(width).body, styles.rangeLabel]}
          accessibilityLabel={positionLabel}
          testID="drawer-pagination-label"
        >
          {stageStart}–{stageEnd}
        </Text>
        <TouchableOpacity
          onPress={onNext}
          disabled={!canNext}
          accessibilityRole="button"
          accessibilityLabel="Next page"
          accessibilityState={{ disabled: !canNext }}
          style={styles.pagerButton}
          testID="drawer-pagination-next"
        >
          <ChevronRight size={ICON_SIZE} color={canNext ? accent.primary : ink.muted} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

/** The drawer body: action rows, the reveal gate, the visibility switch, then the pager. */
export default function HabitsDrawer(props: HabitsDrawerProps): React.JSX.Element {
  return (
    <View>
      <ActionRows
        onSelectMode={props.onSelectMode}
        onOpenOnboarding={props.onOpenOnboarding}
        onOpenAddHabit={props.onOpenAddHabit}
        onClose={props.onClose}
      />
      <RevealRow
        allRevealed={props.allRevealed}
        onToggleReveal={props.onToggleReveal}
        onClose={props.onClose}
      />
      <VisibilityRow barVisible={props.barVisible} onToggleBarVisible={props.onToggleBarVisible} />
      <PaginationSection
        page={props.page}
        pageCount={props.pageCount}
        onPrev={props.onPrev}
        onNext={props.onNext}
        stageStart={props.stageStart}
        stageEnd={props.stageEnd}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touchTarget.minimum,
    gap: SPACING.md,
  },
  rowLabel: {
    color: ink.primary,
  },
  pagerCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  pagerButton: {
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rangeLabel: {
    textAlign: 'center',
    color: ink.primary,
  },
});
