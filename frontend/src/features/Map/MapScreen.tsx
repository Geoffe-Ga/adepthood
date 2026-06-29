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
import { MAP_ROWS, MAP_TITLE_LINES, STAGE_DISPLAY } from './mapLayout';
import type { MapRow, StageDisplay } from './mapLayout';
import { stageService, isStageUnlocked } from './services/stageService';
import type { StageData } from './stageData';

import { colors } from '@/design/tokens';

/** Lookup of stage number → StageData for resolving row/arrow content. */
type StageLookup = Readonly<Record<number, StageData | undefined>>;

const FULL_PROGRESS = 1;

// --- Sub-components ---

const ConnectionLines = ({ stages }: { stages: StageData[] }): React.JSX.Element => (
  <>
    {stages.slice(0, -1).map((stage, idx) => {
      const next = stages[idx + 1];
      if (!next) return null;
      const topPct = stage.hotspots[0]?.top ?? 0;
      const nextTop = next.hotspots[0]?.top ?? 0;
      return (
        <View
          key={`conn-${stage.stageNumber}`}
          testID={`stage-connection-${stage.stageNumber}`}
          style={[
            styles.connectionLine,
            {
              top: `${topPct + 6}%`,
              left: '50%',
              height: `${nextTop - topPct - 6}%`,
            },
          ]}
        />
      );
    })}
  </>
);

const getHotspotStyle = (stage: StageData, currentStage: number | null) => {
  if (!isStageUnlocked(stage, currentStage)) return styles.hotspotLocked;
  if (stage.stageNumber === currentStage) return styles.hotspotCurrent;
  if (stage.progress >= FULL_PROGRESS) return styles.hotspotCompleted;
  return null;
};

const LockOverlay = (): React.JSX.Element => (
  <View style={styles.lockOverlay}>
    <Text style={styles.lockText}>🔒</Text>
  </View>
);

interface StageTapProps {
  stage: StageData;
  display: StageDisplay;
  locked: boolean;
  onPress: (_stage: StageData) => void;
}

// --- Left column: colored stage text (also the -0 tap target) -------------

const StageTextBlock = ({ stage, display, locked, onPress }: StageTapProps): React.JSX.Element => (
  <TouchableOpacity
    testID={`stage-hotspot-${display.stageNumber}-0`}
    style={[styles.stageBlock, locked ? styles.hotspotLocked : null]}
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

interface RowProps {
  row: MapRow;
  isLast: boolean;
  lookup: StageLookup;
  currentStage: number | null;
  onPress: (_stage: StageData) => void;
}

const cellStyle = (row: MapRow, isLast: boolean) => [
  styles.rowCell,
  { flex: row.stageNumbers.length },
  isLast ? styles.rowCellLast : null,
];

const LeftRow = ({ row, isLast, lookup, currentStage, onPress }: RowProps): React.JSX.Element => (
  <View style={cellStyle(row, isLast)}>
    {row.stageNumbers.map((stageNumber) => {
      const stage = lookup[stageNumber];
      const display = STAGE_DISPLAY[stageNumber];
      return stage && display ? (
        <StageTextBlock
          key={stageNumber}
          stage={stage}
          display={display}
          locked={!isStageUnlocked(stage, currentStage)}
          onPress={onPress}
        />
      ) : null;
    })}
  </View>
);

interface ColumnProps {
  lookup: StageLookup;
  currentStage: number | null;
  onPress: (_stage: StageData) => void;
}

const LeftTextColumn = ({ lookup, currentStage, onPress }: ColumnProps): React.JSX.Element => (
  <View style={styles.leftColumn}>
    {MAP_ROWS.map((row, idx) => (
      <LeftRow
        key={row.rightLabel}
        row={row}
        isLast={idx === MAP_ROWS.length - 1}
        lookup={lookup}
        currentStage={currentStage}
        onPress={onPress}
      />
    ))}
  </View>
);

// --- Right column: aspect-of-wholeness labels -----------------------------

const RightLabelColumn = (): React.JSX.Element => (
  <View style={styles.rightColumn}>
    {MAP_ROWS.map((row, idx) => (
      <View key={row.rightLabel} style={cellStyle(row, idx === MAP_ROWS.length - 1)}>
        <Text style={styles.rightLabelText}>{row.rightLabel}</Text>
      </View>
    ))}
  </View>
);

// --- Center column: arrow artwork, grey bands, tap targets, labels --------

const bandPosition = (stage: StageData) => {
  const hs = stage.hotspots[0];
  return { top: `${hs?.top ?? 0}%` as const, height: `${hs?.height ?? 0}%` as const };
};

const ArrowHotspot = ({
  stage,
  currentStage,
  onPress,
}: {
  stage: StageData;
  currentStage: number | null;
  onPress: (_stage: StageData) => void;
}): React.JSX.Element | null => {
  const hs = stage.hotspots[0];
  if (!hs) return null;
  const locked = !isStageUnlocked(stage, currentStage);
  return (
    <TouchableOpacity
      testID={`stage-hotspot-${stage.stageNumber}-1`}
      style={[
        styles.hotspot,
        { top: `${hs.top}%`, left: `${hs.left}%`, width: `${hs.width}%`, height: `${hs.height}%` },
        getHotspotStyle(stage, currentStage),
      ]}
      onPress={() => onPress(stage)}
      accessibilityRole="button"
      accessibilityLabel={`${stage.title} - ${stage.subtitle}`}
    >
      {locked ? <LockOverlay /> : null}
      {stage.progress >= FULL_PROGRESS ? (
        <View style={styles.completedBadge} testID={`stage-complete-${stage.stageNumber}`}>
          <Text style={styles.completedBadgeText}>✓</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
};

const ArrowLabel = ({ stage }: { stage: StageData }): React.JSX.Element | null => {
  const display = STAGE_DISPLAY[stage.stageNumber];
  if (!display?.arrowLabel) return null;
  return (
    <View pointerEvents="none" style={[styles.arrowLabelWrap, bandPosition(stage)]}>
      <Text style={styles.arrowLabelText}>{display.arrowLabel}</Text>
    </View>
  );
};

const SpiralTitle = (): React.JSX.Element => (
  <View pointerEvents="none" style={styles.titleOverlay}>
    {MAP_TITLE_LINES.map((line) => (
      <Text key={line} style={styles.titleText}>
        {line}
      </Text>
    ))}
  </View>
);

const GreyBands = (): React.JSX.Element => (
  <>
    <View pointerEvents="none" style={styles.greyBandFeminine} />
    <View pointerEvents="none" style={styles.greyBandMasculine} />
  </>
);

const CenterColumn = ({
  stages,
  currentStage,
  onPress,
}: {
  stages: StageData[];
  currentStage: number | null;
  onPress: (_stage: StageData) => void;
}): React.JSX.Element => (
  <View style={styles.centerColumn}>
    <View style={styles.centerInner}>
      <GreyBands />
      {MAP_BACKGROUND_URI ? (
        <Image
          source={{ uri: MAP_BACKGROUND_URI }}
          resizeMode="contain"
          style={styles.arrowImage}
          testID="map-background"
        />
      ) : (
        // No hosted art configured — branded in-app fallback, never an external
        // placeholder (#766). The stage labels/bands still render on top.
        <View style={[styles.arrowImage, styles.mapBackgroundFallback]} testID="map-background" />
      )}
      <ConnectionLines stages={stages} />
      {stages.map((stage) => (
        <ArrowHotspot key={stage.id} stage={stage} currentStage={currentStage} onPress={onPress} />
      ))}
      {stages.map((stage) => (
        <ArrowLabel key={stage.id} stage={stage} />
      ))}
      <SpiralTitle />
    </View>
  </View>
);

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

interface SpiralTableProps {
  stages: StageData[];
  lookup: StageLookup;
  currentStage: number | null;
  onSelectStage: (_stage: StageData) => void;
}

const SpiralTable = ({
  stages,
  lookup,
  currentStage,
  onSelectStage,
}: SpiralTableProps): React.JSX.Element => (
  <View style={styles.table}>
    <LeftTextColumn lookup={lookup} currentStage={currentStage} onPress={onSelectStage} />
    <CenterColumn stages={stages} currentStage={currentStage} onPress={onSelectStage} />
    <RightLabelColumn />
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
      <SpiralTable
        stages={stages}
        lookup={lookup}
        currentStage={currentStage}
        onSelectStage={setActiveStage}
      />
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
