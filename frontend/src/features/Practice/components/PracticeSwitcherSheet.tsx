/**
 * `PracticeSwitcherSheet` — bottom-sheet that lists every approved
 * practice for the current stage so the user can replace their active
 * one without leaving the screen.
 *
 * - Selection writes via `userPractices.create`; the backend's partial
 *   unique index closes the prior `UserPractice` so the catalog stays
 *   "one active row per stage".
 * - "Submit my own" delegates to the existing practice-submission
 *   flow. The handler is injected so this component stays decoupled
 *   from the navigator wiring (and from whether the submission screen
 *   has shipped yet on a given branch).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { practices, userPractices, type PracticeItem, type UserPractice } from '@/api';
import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

export interface PracticeSwitcherSheetProps {
  /** Visibility flag — parent owns whether the modal is mounted. */
  visible: boolean;
  /** Stage to list practices for. */
  stageNumber: number;
  /** Currently active practice id, or null when none is selected yet. */
  currentPracticeId: number | null;
  /** Dismiss the sheet (tap outside, tap close, after a successful replace). */
  onClose: () => void;
  /** Called with the new `UserPractice` after a successful selection. */
  onReplaced: (_userPractice: UserPractice) => void;
  /**
   * Optional handler for the "Submit my own" CTA. Hidden when not provided
   * so this component can ship before the submission route does.
   */
  onSubmitOwn?: () => void;
}

const REPLACE_FAILED_MSG = "We couldn't switch your practice. Check your connection and try again.";
const LOAD_FAILED_MSG =
  "We couldn't load the catalog of practices for this stage. Tap retry below.";

interface UseSheetStateOptions {
  visible: boolean;
  stageNumber: number;
  currentPracticeId: number | null;
  onReplaced: (_up: UserPractice) => void;
  onClose: () => void;
}

interface SheetState {
  items: PracticeItem[];
  isLoading: boolean;
  loadError: string | null;
  writeError: string | null;
  submittingId: number | null;
  loadList: () => Promise<void>;
  handleSelect: (_practice: PracticeItem) => Promise<void>;
}

function useMountedRef() {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

interface LoadController {
  items: PracticeItem[];
  isLoading: boolean;
  loadError: string | null;
  loadList: () => Promise<void>;
}

function useLoadList(
  stageNumber: number,
  visible: boolean,
  mountedRef: React.RefObject<boolean>,
): LoadController {
  const [items, setItems] = useState<PracticeItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const list = await practices.list(stageNumber);
      if (mountedRef.current) setItems(list);
    } catch {
      if (mountedRef.current) setLoadError(LOAD_FAILED_MSG);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [stageNumber, mountedRef]);

  useEffect(() => {
    if (!visible) return;
    void loadList();
  }, [visible, loadList]);

  return { items, isLoading, loadError, loadList };
}

interface SelectController {
  writeError: string | null;
  submittingId: number | null;
  handleSelect: (_p: PracticeItem) => Promise<void>;
}

function useSelect(
  options: Omit<UseSheetStateOptions, 'visible'>,
  mountedRef: React.RefObject<boolean>,
): SelectController {
  const { stageNumber, currentPracticeId, onReplaced, onClose } = options;
  const [writeError, setWriteError] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<number | null>(null);

  const handleSelect = useCallback(
    async (practice: PracticeItem) => {
      if (practice.id === currentPracticeId) {
        onClose();
        return;
      }
      setSubmittingId(practice.id);
      setWriteError(null);
      try {
        const created = await userPractices.create({
          practice_id: practice.id,
          stage_number: stageNumber,
        });
        if (!mountedRef.current) return;
        onReplaced(created);
        onClose();
      } catch {
        if (mountedRef.current) setWriteError(REPLACE_FAILED_MSG);
      } finally {
        if (mountedRef.current) setSubmittingId(null);
      }
    },
    [currentPracticeId, stageNumber, onReplaced, onClose, mountedRef],
  );

  return { writeError, submittingId, handleSelect };
}

function useSheetState(opts: UseSheetStateOptions): SheetState {
  const mountedRef = useMountedRef();
  const load = useLoadList(opts.stageNumber, opts.visible, mountedRef);
  const select = useSelect(opts, mountedRef);
  return { ...load, ...select };
}

function SheetHeader({ onClose }: { onClose: () => void }) {
  return (
    <View style={styles.headerRow}>
      <Text style={styles.title}>Replace this practice</Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        style={styles.closeButton}
        testID="practice-switcher-close"
      >
        <Text style={styles.closeButtonText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

function LoadErrorView({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  return (
    <View style={styles.center}>
      <Text style={styles.loadErrorText}>{message}</Text>
      <TouchableOpacity
        accessibilityRole="button"
        onPress={onRetry}
        style={styles.retryButton}
        testID="practice-switcher-retry"
      >
        <Text style={styles.retryButtonText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

interface SheetListProps extends Pick<SheetState, 'items' | 'submittingId' | 'handleSelect'> {
  currentPracticeId: number | null;
}

function SheetList({ items, submittingId, handleSelect, currentPracticeId }: SheetListProps) {
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => String(item.id)}
      renderItem={({ item }) => (
        <SwitcherRow
          item={item}
          selected={item.id === currentPracticeId}
          pending={submittingId === item.id}
          onSelect={handleSelect}
        />
      )}
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.emptyText}>No practices catalogued for this stage yet.</Text>
        </View>
      }
    />
  );
}

interface SheetBodyProps {
  state: SheetState;
  currentPracticeId: number | null;
}

function SheetBody({ state, currentPracticeId }: SheetBodyProps) {
  const { items, isLoading, loadError, submittingId, loadList, handleSelect } = state;
  if (isLoading && items.length === 0) {
    return (
      <View style={styles.center} testID="practice-switcher-loading">
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (loadError) return <LoadErrorView message={loadError} onRetry={loadList} />;
  return (
    <SheetList
      items={items}
      submittingId={submittingId}
      handleSelect={handleSelect}
      currentPracticeId={currentPracticeId}
    />
  );
}

function SubmitOwnButton({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      style={styles.submitOwnButton}
      testID="practice-switcher-submit-own"
    >
      <Text style={styles.submitOwnText}>Submit my own practice</Text>
    </TouchableOpacity>
  );
}

const noop = () => {};

export function PracticeSwitcherSheet(props: PracticeSwitcherSheetProps) {
  const { visible, currentPracticeId, onClose, onSubmitOwn } = props;
  const state = useSheetState(props);

  const handleSubmitOwn = useCallback(() => {
    if (!onSubmitOwn) return;
    onSubmitOwn();
    onClose();
  }, [onSubmitOwn, onClose]);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      transparent
      visible={visible}
      testID="practice-switcher-sheet"
    >
      <Pressable
        accessibilityLabel="Dismiss practice switcher"
        onPress={onClose}
        style={styles.backdrop}
        testID="practice-switcher-backdrop"
      >
        <Pressable onPress={noop} style={styles.sheet}>
          <View style={styles.handle} />
          <SheetHeader onClose={onClose} />
          {state.writeError && (
            <View style={styles.writeError} testID="practice-switcher-error">
              <Text style={styles.writeErrorText}>{state.writeError}</Text>
            </View>
          )}
          <SheetBody state={state} currentPracticeId={currentPracticeId} />
          {onSubmitOwn && <SubmitOwnButton onPress={handleSubmitOwn} />}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

interface SwitcherRowProps {
  item: PracticeItem;
  selected: boolean;
  pending: boolean;
  onSelect: (_item: PracticeItem) => void;
}

function SwitcherRow({ item, selected, pending, onSelect }: SwitcherRowProps) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ selected, busy: pending }}
      activeOpacity={0.85}
      disabled={pending}
      onPress={() => onSelect(item)}
      style={[styles.row, selected && styles.rowSelected]}
      testID={`practice-switcher-row-${item.id}`}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowName}>{item.name}</Text>
        <Text style={styles.rowDescription} numberOfLines={2}>
          {item.description}
        </Text>
        <Text style={styles.rowDuration}>{item.default_duration_minutes} min default</Text>
      </View>
      {pending ? (
        <ActivityIndicator color={colors.primary} testID={`practice-switcher-pending-${item.id}`} />
      ) : (
        selected && (
          <Text style={styles.check} testID={`practice-switcher-check-${item.id}`}>
            ✓
          </Text>
        )
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '80%',
    backgroundColor: colors.background.card,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.xxl,
    ...shadows.large,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: BORDER_RADIUS.circle,
    backgroundColor: colors.border,
    marginBottom: SPACING.sm,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text.primary,
  },
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 20,
    color: colors.text.secondary,
  },
  center: {
    paddingVertical: SPACING.xxl,
    alignItems: 'center',
  },
  loadErrorText: {
    color: colors.destructive.text,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: SPACING.md,
  },
  retryButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
  },
  retryButtonText: {
    color: colors.text.light,
    fontWeight: '600',
    fontSize: 14,
  },
  writeError: {
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    backgroundColor: colors.destructive.background,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: colors.destructive.border,
  },
  writeErrorText: {
    color: colors.destructive.text,
    fontSize: 14,
  },
  emptyText: {
    color: colors.text.secondary,
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    marginBottom: SPACING.sm,
    backgroundColor: colors.background.accent,
  },
  rowSelected: {
    borderWidth: 2,
    borderColor: colors.success,
  },
  rowText: {
    flex: 1,
    paddingRight: SPACING.md,
  },
  rowName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: 2,
  },
  rowDescription: {
    fontSize: 13,
    color: colors.text.secondary,
    marginBottom: 4,
  },
  rowDuration: {
    fontSize: 12,
    color: colors.text.tertiaryAccessible,
  },
  check: {
    fontSize: 22,
    color: colors.success,
    fontWeight: '700',
  },
  submitOwnButton: {
    marginTop: SPACING.md,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  submitOwnText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.primary,
  },
});
