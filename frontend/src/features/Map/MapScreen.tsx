// frontend/features/Map/MapScreen.tsx

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  InteractionManager,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import type { HabitHistoryItem, PracticeHistoryItem, StageHistoryResponse } from '../../api';
import { stages as stagesApi } from '../../api';
import { MAP_BACKGROUND_URI } from '../../constants/images';
import { useAppNavigation } from '../../navigation/hooks';
import { useDerivedCurrentStage } from '../../store/useProgramProgression';
import {
  selectCurrentStage,
  selectStages,
  selectStagesError,
  selectStagesLoading,
  useStageStore,
} from '../../store/useStageStore';

import styles from './Map.styles';
import { MAP_ROWS, STAGE_DISPLAY, TITLE_BY_STAGE } from './mapLayout';
import type { MapRow, StageDisplay } from './mapLayout';
import { stageService, isStageUnlocked } from './services/stageService';
import { isLeftReturning, type StageData } from './stageData';

import { colors } from '@/design/tokens';

/** Lookup of stage number → StageData for resolving row/arrow content. */
type StageLookup = Readonly<Record<number, StageData | undefined>>;

const FULL_PROGRESS = 1;
/** Directional spiral glyphs — the Map reads with no background PNG (#766). */
const ARROW_GLYPH_LEFT = '↩';
const ARROW_GLYPH_RIGHT = '↪';

// --- Sub-components ---
//
// One responsive row grid is the single source of vertical truth. Each stage is
// a flex row [LeftCell | CenterCell | RightCell]; the three columns are siblings
// in the same row, so they cannot drift the way the old content-driven flex
// table + absolute-percentage center overlay did. The Map reads with no PNG.

const LockOverlay = (): React.JSX.Element => (
  <View style={styles.lockOverlay}>
    <Text style={styles.lockText}>🔒</Text>
  </View>
);

interface StageCellProps {
  stage: StageData;
  display: StageDisplay;
  locked: boolean;
  isCurrent: boolean;
  onPress: (_stage: StageData) => void;
}

// --- Left cell: colored stage text (the -0 tap target) --------------------

const StageTextBlock = ({ stage, display, locked, onPress }: StageCellProps): React.JSX.Element => (
  <TouchableOpacity
    testID={`stage-hotspot-${display.stageNumber}-0`}
    style={[styles.stageBlock, locked ? styles.locked : null]}
    onPress={() => onPress(stage)}
    accessibilityRole="button"
    accessibilityLabel={`${display.persona} - ${display.descriptor}`}
  >
    <Text style={[styles.personaText, { color: display.textColor }]}>{display.persona}</Text>
    <Text style={[styles.lineText, { color: display.textColor }]}>{display.descriptor}</Text>
    <Text style={[styles.lineText, { color: display.textColor }]}>{display.practice}</Text>
    {locked ? <LockOverlay /> : null}
  </TouchableOpacity>
);

// --- Center cell: directional glyph + label/title, lock, badge (the -1 tap) -

const CenterContent = ({ display }: { display: StageDisplay }): React.JSX.Element => {
  const glyph = isLeftReturning(display.stageNumber) ? ARROW_GLYPH_LEFT : ARROW_GLYPH_RIGHT;
  const title = TITLE_BY_STAGE[display.stageNumber];
  return (
    <>
      <Text style={[styles.arrowGlyph, { color: display.textColor }]}>{glyph}</Text>
      {title ? (
        <Text style={styles.titleText}>{title}</Text>
      ) : display.arrowLabel ? (
        <View style={styles.centerLabelRow}>
          <Text style={styles.arrowLabelText}>{display.arrowLabel}</Text>
        </View>
      ) : null}
    </>
  );
};

const StageCenterCell = ({
  stage,
  display,
  locked,
  isCurrent,
  onPress,
}: StageCellProps): React.JSX.Element => (
  <TouchableOpacity
    testID={`stage-hotspot-${display.stageNumber}-1`}
    style={[
      styles.centerStageCell,
      isLeftReturning(display.stageNumber) ? styles.cellFeminine : styles.cellMasculine,
      locked ? styles.locked : null,
      isCurrent ? styles.cellCurrent : null,
    ]}
    onPress={() => onPress(stage)}
    accessibilityRole="button"
    accessibilityLabel={`${stage.title} - ${stage.subtitle}`}
  >
    <CenterContent display={display} />
    {locked ? <LockOverlay /> : null}
    {stage.progress >= FULL_PROGRESS ? (
      <View style={styles.completedBadge} testID={`stage-complete-${stage.stageNumber}`}>
        <Text style={styles.completedBadgeText}>✓</Text>
      </View>
    ) : null}
    {/* Connector to the stage below (replaces the old %-positioned line). */}
    {display.stageNumber > 1 ? (
      <View style={styles.connector} testID={`stage-connection-${stage.stageNumber}`} />
    ) : null}
  </TouchableOpacity>
);

interface MapRowProps {
  row: MapRow;
  lookup: StageLookup;
  currentStage: number | null;
  onPress: (_stage: StageData) => void;
}

/** One grid row: left text + center glyph stacked per stage, one aspect label. */
const MapRowView = ({ row, lookup, currentStage, onPress }: MapRowProps): React.JSX.Element => {
  const resolved = row.stageNumbers
    .map((n) => ({ stage: lookup[n], display: STAGE_DISPLAY[n] }))
    .filter((r): r is { stage: StageData; display: StageDisplay } => !!r.stage && !!r.display);
  return (
    <View style={[styles.groupRow, { flex: row.stageNumbers.length }]}>
      <View style={styles.leftCell}>
        {resolved.map(({ stage, display }) => (
          <StageTextBlock
            key={stage.stageNumber}
            stage={stage}
            display={display}
            locked={!isStageUnlocked(stage, currentStage)}
            isCurrent={stage.stageNumber === currentStage}
            onPress={onPress}
          />
        ))}
      </View>
      <View style={styles.centerCell}>
        {resolved.map(({ stage, display }) => (
          <StageCenterCell
            key={stage.stageNumber}
            stage={stage}
            display={display}
            locked={!isStageUnlocked(stage, currentStage)}
            isCurrent={stage.stageNumber === currentStage}
            onPress={onPress}
          />
        ))}
      </View>
      <View style={styles.rightCell}>
        <Text style={styles.rightLabelText}>{row.rightLabel}</Text>
      </View>
    </View>
  );
};

const StageMetadataSection = ({ stage }: { stage: StageData }): React.JSX.Element => (
  <View style={styles.metadataSection} testID="stage-metadata">
    <View style={styles.metadataRow}>
      <Text style={styles.metadataLabel}>Category</Text>
      <Text style={styles.metadataValue}>{stage.category}</Text>
    </View>
    <View style={styles.metadataRow}>
      <Text style={styles.metadataLabel}>Aspect</Text>
      <Text style={styles.metadataValue}>{stage.aspect}</Text>
    </View>
    <View style={styles.metadataRow}>
      <Text style={styles.metadataLabel}>Growing Up</Text>
      <Text style={styles.metadataValue}>{stage.growingUpStage}</Text>
    </View>
    <View style={styles.metadataRow}>
      <Text style={styles.metadataLabel}>Polarity</Text>
      <Text style={styles.metadataValue}>{stage.divineGenderPolarity}</Text>
    </View>
    <View style={styles.metadataRow}>
      <Text style={styles.metadataLabel}>Free Will</Text>
      <Text style={styles.metadataValue}>{stage.relationshipToFreeWill}</Text>
    </View>
    {stage.freeWillDescription ? (
      <Text style={styles.freeWillDescription}>{stage.freeWillDescription}</Text>
    ) : null}
  </View>
);

const StageProgressSection = ({ stage }: { stage: StageData }): React.JSX.Element => (
  <View style={styles.progressContainer}>
    <Text style={styles.progressLabel}>Progress: {Math.round(stage.progress * 100)}%</Text>
    <View style={styles.progressBar}>
      <View
        style={[
          styles.progressFill,
          { width: `${stage.progress * 100}%`, backgroundColor: stage.color },
        ]}
        testID="progress-fill"
      />
    </View>
  </View>
);

interface ActionLinksProps {
  stage: StageData;
  onNavigate: (_screen: 'Practice' | 'Course' | 'Journal', _stage: StageData) => void;
}

const ActionLinks = ({ stage, onNavigate }: ActionLinksProps): React.JSX.Element => (
  <View style={styles.actions}>
    <TouchableOpacity
      testID="practice-link"
      style={styles.actionButton}
      onPress={() => onNavigate('Practice', stage)}
    >
      <Text style={styles.actionText}>Practice</Text>
    </TouchableOpacity>
    <TouchableOpacity
      testID="course-link"
      style={styles.actionButton}
      onPress={() => onNavigate('Course', stage)}
    >
      <Text style={styles.actionText}>Course</Text>
    </TouchableOpacity>
    <TouchableOpacity
      testID="journal-link"
      style={styles.actionButton}
      onPress={() => onNavigate('Journal', stage)}
    >
      <Text style={styles.actionText}>Journal</Text>
    </TouchableOpacity>
  </View>
);

const GOAL_TIER_COLORS: Record<string, string> = {
  low: colors.medal.bronze,
  clear: colors.medal.silver,
  stretch: colors.medal.gold,
};

const GOAL_TIER_LABELS: Record<string, string> = {
  low: 'L',
  clear: 'C',
  stretch: 'S',
};

const MINUTES_PER_HOUR = 60;

const formatMinutes = (minutes: number): string => {
  if (minutes >= MINUTES_PER_HOUR) {
    const hours = Math.round(minutes / MINUTES_PER_HOUR);
    return `${hours} hr${hours !== 1 ? 's' : ''}`;
  }
  return `${Math.round(minutes)} min`;
};

const PracticeHistoryRow = ({ item }: { item: PracticeHistoryItem }): React.JSX.Element => (
  <View style={styles.historyItem} testID="practice-history-item">
    <Text style={styles.historyItemIcon}>🧘</Text>
    <Text style={styles.historyItemName}>{item.name}</Text>
    <Text style={styles.historyItemDetail}>
      {item.sessions_completed} sessions, {formatMinutes(item.total_minutes)}
    </Text>
  </View>
);

const HabitHistoryRow = ({ item }: { item: HabitHistoryItem }): React.JSX.Element => (
  <View style={styles.historyItem} testID="habit-history-item">
    <Text style={styles.historyItemIcon}>{item.icon}</Text>
    <Text style={styles.historyItemName}>
      {item.name} · {item.best_streak}d streak
    </Text>
    <View style={styles.goalBadges}>
      {Object.entries(item.goals_achieved).map(([tier, achieved]) => (
        <View
          key={tier}
          style={[
            styles.goalBadge,
            {
              backgroundColor: achieved
                ? GOAL_TIER_COLORS[tier] ?? colors.text.tertiary
                : 'rgba(255,255,255,0.15)',
            },
          ]}
          testID={`goal-badge-${tier}`}
        >
          <Text style={styles.goalBadgeText}>{GOAL_TIER_LABELS[tier] ?? tier[0]}</Text>
        </View>
      ))}
    </View>
  </View>
);

const HistoryContent = ({ history }: { history: StageHistoryResponse }): React.JSX.Element => (
  <View testID="history-content">
    {history.practices.length > 0 && (
      <>
        <Text style={styles.historySubheading}>Practices</Text>
        {history.practices.map((p) => (
          <PracticeHistoryRow key={p.name} item={p} />
        ))}
      </>
    )}
    {history.habits.length > 0 && (
      <>
        <Text style={styles.historySubheading}>Habits</Text>
        {history.habits.map((h) => (
          <HabitHistoryRow key={h.name} item={h} />
        ))}
      </>
    )}
  </View>
);

const HistoryBody = ({
  loading,
  error,
  history,
  onRetry,
}: {
  loading: boolean;
  error: boolean;
  history: StageHistoryResponse | null;
  onRetry: () => void;
}): React.JSX.Element | null => {
  const hasContent =
    history !== null && (history.practices.length > 0 || history.habits.length > 0);

  if (loading) {
    return (
      <View style={styles.historyLoading} testID="history-loading">
        <ActivityIndicator size="small" color={colors.text.light} />
      </View>
    );
  }
  // A failed fetch is distinct from a genuinely empty stage: show an error +
  // retry instead of the "begin this stage" empty copy.
  if (error) {
    return (
      <View style={styles.historyError} testID="history-error">
        <Text style={styles.historyErrorText}>Couldn&apos;t load your journey for this stage.</Text>
        <TouchableOpacity
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Try again"
          style={styles.historyRetry}
          testID="history-retry"
        >
          <Text style={styles.historyRetryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!hasContent) {
    return (
      <Text style={styles.historyEmpty} testID="history-empty">
        Begin this stage to start tracking your journey
      </Text>
    );
  }
  return history !== null ? <HistoryContent history={history} /> : null;
};

interface StageHistorySectionProps {
  stageNumber: number;
  isUnlocked: boolean;
}

const StageHistorySection = ({
  stageNumber,
  isUnlocked,
}: StageHistorySectionProps): React.JSX.Element | null => {
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<StageHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const loadHistory = useCallback(() => {
    setLoading(true);
    setError(false);
    stagesApi
      .history(stageNumber)
      // Track failure explicitly so a rejected fetch is separable from a
      // resolved-but-empty history (which keeps its "begin this stage" copy).
      .then(setHistory)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [stageNumber]);

  useEffect(() => {
    // Auto-fetch once on expand. The ``error`` guard means a failed fetch is
    // NOT silently re-attempted on collapse→re-expand — the user retries
    // explicitly via the error state's "Try again" (which clears ``error``).
    if (!expanded || !isUnlocked || history !== null || error || loading) return;
    loadHistory();
  }, [expanded, isUnlocked, history, error, loading, loadHistory]);

  if (!isUnlocked) return null;

  return (
    <View style={styles.historySection} testID="history-section">
      <TouchableOpacity
        style={styles.historyHeader}
        onPress={() => setExpanded((prev) => !prev)}
        testID="history-toggle"
      >
        <Text style={styles.historyTitle}>Your Journey</Text>
        <Text style={styles.historyToggle}>{expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {expanded && (
        <HistoryBody loading={loading} error={error} history={history} onRetry={loadHistory} />
      )}
    </View>
  );
};

interface ModalBodyProps {
  stage: StageData;
  onClose: () => void;
  onNavigate: (_screen: 'Practice' | 'Course' | 'Journal', _stage: StageData) => void;
}

const ModalBody = ({ stage, onClose, onNavigate }: ModalBodyProps): React.JSX.Element => (
  <ScrollView showsVerticalScrollIndicator={false}>
    <TouchableOpacity testID="close-modal" style={styles.closeButton} onPress={onClose}>
      <Text style={styles.closeText}>×</Text>
    </TouchableOpacity>
    <View style={styles.titleRow}>
      <View style={[styles.colorDot, { backgroundColor: stage.color }]} />
      <Text style={styles.modalTitle}>{stage.title}</Text>
    </View>
    <Text style={styles.modalSubtitle}>{stage.subtitle}</Text>
    <StageProgressSection stage={stage} />
    <StageMetadataSection stage={stage} />
    {stage.isUnlocked && (
      <StageHistorySection stageNumber={stage.stageNumber} isUnlocked={stage.isUnlocked} />
    )}
    <View style={styles.separator} />
    <ActionLinks stage={stage} onNavigate={onNavigate} />
  </ScrollView>
);

interface StageDetailModalProps {
  activeStage: StageData | null;
  onClose: () => void;
  onNavigate: (_screen: 'Practice' | 'Course' | 'Journal', _stage: StageData) => void;
}

const StageDetailModal = ({
  activeStage,
  onClose,
  onNavigate,
}: StageDetailModalProps): React.JSX.Element => (
  <Modal visible={!!activeStage} transparent animationType="slide" onRequestClose={onClose}>
    <Pressable style={styles.modalOverlay} onPress={onClose} testID="modal-overlay">
      <Pressable style={styles.modalContent} onPress={() => {}} testID="stage-modal">
        {activeStage && <ModalBody stage={activeStage} onClose={onClose} onNavigate={onNavigate} />}
      </Pressable>
    </Pressable>
  </Modal>
);

const MapLoading = (): React.JSX.Element => (
  <View style={styles.centered} testID="map-loading">
    <ActivityIndicator size="large" color={styles.loadingText.color} />
    <Text style={styles.loadingText}>Loading stages...</Text>
  </View>
);

const MapError = ({ message }: { message: string }): React.JSX.Element => (
  <View style={styles.centered} testID="map-error">
    <Text style={styles.errorText}>{message}</Text>
  </View>
);

// Non-blocking banner for a refresh that failed while cached stages are shown,
// so a stale map no longer hides the failure (the cold-start MapError covers
// the no-stages case). Retry re-runs the same loader.
const MapRefreshErrorBanner = ({ onRetry }: { onRetry: () => void }): React.JSX.Element => (
  <View style={styles.refreshBanner} testID="map-refresh-error">
    <Text style={styles.refreshBannerText}>
      Couldn&apos;t refresh the map. Showing your last saved progress.
    </Text>
    <TouchableOpacity
      onPress={onRetry}
      accessibilityRole="button"
      accessibilityLabel="Try again"
      style={styles.refreshRetry}
      testID="map-refresh-retry"
    >
      <Text style={styles.refreshRetryText}>Try again</Text>
    </TouchableOpacity>
  </View>
);

interface MapGridProps {
  lookup: StageLookup;
  currentStage: number | null;
  onSelectStage: (_stage: StageData) => void;
}

// Optional decorative backdrop. The grid is fully legible without it (#766), so
// a missing PNG is a faint no-op rather than a third-party placeholder.
const MapBackdrop = (): React.JSX.Element =>
  MAP_BACKGROUND_URI ? (
    <Image
      source={{ uri: MAP_BACKGROUND_URI }}
      resizeMode="contain"
      style={styles.backdrop}
      testID="map-background"
    />
  ) : (
    <View style={styles.backdrop} testID="map-background" pointerEvents="none" />
  );

const MapGrid = ({ lookup, currentStage, onSelectStage }: MapGridProps): React.JSX.Element => (
  <View style={styles.grid}>
    {MAP_ROWS.map((row) => (
      <MapRowView
        key={row.rightLabel}
        row={row}
        lookup={lookup}
        currentStage={currentStage}
        onPress={onSelectStage}
      />
    ))}
  </View>
);

// --- Main component ---

type NavTarget = 'Practice' | 'Course' | 'Journal';

/**
 * Build the stage-detail action navigator. Closes the modal first, then routes
 * after interactions settle; a ref guards against double-taps mid-transition.
 */
const useStageNavigation = (onBeforeNavigate: () => void) => {
  const navigation = useAppNavigation();
  const navigatingRef = useRef(false);
  return useCallback(
    (screen: NavTarget, stage: StageData) => {
      if (navigatingRef.current) return;
      navigatingRef.current = true;
      onBeforeNavigate();
      InteractionManager.runAfterInteractions(() => {
        if (screen === 'Journal') {
          navigation.navigate('Journal', {
            tag: 'stage_reflection',
            stageNumber: stage.stageNumber,
          });
        } else {
          navigation.navigate(screen, { stageNumber: stage.stageNumber });
        }
        navigatingRef.current = false;
      });
    },
    [navigation, onBeforeNavigate],
  );
};

const MapScreen = (): React.JSX.Element => {
  const stages = useStageStore(selectStages);
  const loading = useStageStore(selectStagesLoading);
  const error = useStageStore(selectStagesError);
  const storeCurrentStage = useStageStore(selectCurrentStage);
  // Prefer the date-driven stage when the master anchor is set; the
  // server's count-based ``currentStage`` is the fallback for users who
  // haven't picked an anchor yet.
  const currentStage = useDerivedCurrentStage(storeCurrentStage);
  const [activeStage, setActiveStage] = useState<StageData | null>(null);

  // Resolve each row's stage numbers to their loaded StageData once per change.
  const lookup = useMemo<StageLookup>(
    () => Object.fromEntries(stages.map((stage) => [stage.stageNumber, stage])),
    [stages],
  );

  useEffect(() => {
    if (stages.length === 0 && !loading) {
      void stageService.loadStages();
    }
  }, [stages.length, loading]);

  const handleRefresh = useCallback(() => void stageService.loadStages(), []);
  const handleCloseModal = useCallback(() => setActiveStage(null), []);
  const handleNavigate = useStageNavigation(handleCloseModal);

  if (loading && stages.length === 0) return <MapLoading />;
  if (error && stages.length === 0) return <MapError message={error} />;

  return (
    <View style={styles.container}>
      <MapBackdrop />
      <MapGrid lookup={lookup} currentStage={currentStage} onSelectStage={setActiveStage} />
      {error && stages.length > 0 && <MapRefreshErrorBanner onRetry={handleRefresh} />}
      <StageDetailModal
        activeStage={activeStage}
        onClose={handleCloseModal}
        onNavigate={handleNavigate}
      />
    </View>
  );
};

export default MapScreen;
