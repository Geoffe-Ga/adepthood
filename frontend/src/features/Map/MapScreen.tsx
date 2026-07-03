// frontend/features/Map/MapScreen.tsx

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  InteractionManager,
  type LayoutChangeEvent,
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
import {
  useDaysUntilStage,
  useDerivedCurrentStage,
  useDerivedCurrentWeek,
} from '../../store/useProgramProgression';
import {
  selectCurrentStage,
  selectCycleNumber,
  selectStages,
  selectStagesError,
  selectStagesLoading,
  useStageStore,
} from '../../store/useStageStore';

import { BEGIN_AGAIN_COPY, cycleLabel } from './beginAgain';
import { useBeginAgainGuard } from './hooks/useBeginAgainGuard';
import { useStageAnchors } from './hooks/useStageAnchors';
import type { UseStageAnchorsResult } from './hooks/useStageAnchors';
import { useWheelBalance } from './hooks/useWheelBalance';
import {
  formatMinutes,
  journeyRead,
  progressionSentence,
  rankedStats,
  unlockTimeline,
} from './journeyNarrative';
import styles from './Map.styles';
import { labelCorner, MAP_ROWS, STAGE_DISPLAY, TITLE_BY_STAGE } from './mapLayout';
import type { MapRow, StageDisplay } from './mapLayout';
import { stageService, isStageUnlocked, isEndOfCycle } from './services/stageService';
import { isLeftReturning, STAGE_COUNT, type StageData } from './stageData';
import { WaveOverlay } from './WaveOverlay';
import { emphasisStyle, FULLNESS_ALIVE_THRESHOLD } from './wheelBalance';

import { Button } from '@/components/Button';
import { Celebration } from '@/components/feedback/Celebration';
import { colors } from '@/design/tokens';

/** Lookup of stage number → StageData for resolving row/arrow content. */
type StageLookup = Readonly<Record<number, StageData | undefined>>;

/** Wheel-of-wholeness fullness (0..1) keyed by stage number; absent reads thin. */
type FullnessLookup = Readonly<Record<number, number>>;

const FULL_PROGRESS = 1;
const THIN_FULLNESS = 0;

/** Accessibility suffix appended to a node's label from its wheel fullness. */
const balanceLabelSuffix = (fullness: number): string =>
  fullness >= FULLNESS_ALIVE_THRESHOLD ? 'reads full' : 'reads thin';

/** Full a11y label for a stage node: persona/descriptor plus the balance read. */
const stageNodeLabel = (display: StageDisplay, fullness: number): string =>
  `${display.persona} - ${display.descriptor} - ${balanceLabelSuffix(fullness)}`;

// --- Sub-components ---
//
// One responsive row grid is the single source of vertical truth. Each stage is
// a flex row [LeftCell | CenterCell | RightCell]; the three columns are siblings
// in the same row, so they cannot drift the way the old content-driven flex
// table + absolute-percentage center overlay did. The Map reads with no PNG.

const LockGlyph = (): React.JSX.Element => (
  <View style={styles.lockRow}>
    <Text style={styles.lockText}>🔒</Text>
  </View>
);

/** Aspect label / unlock estimate corner within a center cell. */
type LabelCorner = 'left' | 'right';

/**
 * "Unlocks in N days" / unlock-condition copy for a locked stage, computed from
 * the existing calendar drip (no new backend). Falls back to the condition when
 * no program anchor is set. Its text aligns to the block's corner so the copy
 * reads away from the wave strand.
 */
const UnlockTimeline = ({
  stageNumber,
  corner,
}: {
  stageNumber: number;
  corner: LabelCorner;
}): React.JSX.Element => {
  const daysUntil = useDaysUntilStage(stageNumber);
  const alignStyle = corner === 'left' ? styles.unlockTimelineLeft : styles.unlockTimelineRight;
  return (
    <Text style={[styles.unlockTimeline, alignStyle]} testID={`stage-unlock-${stageNumber}`}>
      {unlockTimeline(daysUntil)}
    </Text>
  );
};

const YouAreHereMarker = (): React.JSX.Element => (
  <View style={styles.youAreHere} testID="you-are-here">
    <Text style={styles.youAreHereText}>YOU ARE HERE</Text>
  </View>
);

interface StageCellProps {
  stage: StageData;
  display: StageDisplay;
  locked: boolean;
  isCurrent: boolean;
  onPress: (_stage: StageData) => void;
}

interface StageTextBlockProps extends StageCellProps {
  /** Wheel-of-wholeness fullness (0..1) for this Aspect; drives emphasis + a11y. */
  fullness: number;
}

// Left cell: colored stage text (the -0 tap target); wheel overlay adds emphasis opacity + a11y only.

const StageTextBlock = ({
  stage,
  display,
  locked,
  fullness,
  onPress,
}: StageTextBlockProps): React.JSX.Element => (
  <TouchableOpacity
    testID={`stage-hotspot-${display.stageNumber}-0`}
    style={[styles.stageBlock, locked ? styles.locked : null, emphasisStyle(fullness)]}
    onPress={() => onPress(stage)}
    accessibilityRole="button"
    accessibilityLabel={stageNodeLabel(display, fullness)}
  >
    <Text style={[styles.personaText, { color: display.leftTextColor }]}>{display.persona}</Text>
    <Text style={[styles.lineText, { color: display.leftTextColor }]}>{display.descriptor}</Text>
    <Text style={[styles.lineText, { color: display.leftTextColor }]}>{display.practice}</Text>
    {locked ? <LockGlyph /> : null}
  </TouchableOpacity>
);

// --- Center cell: label/title, lock, badge (the -1 tap); the wave overlay now
// carries the directional/polarity read behind these cells ----------------

// Corner-hugging Aspect-label block: the arrow word plus, when locked, its
// unlock estimate, grouped against the corner opposite the wave's return pole.
const AspectLabelBlock = ({
  display,
  locked,
}: {
  display: StageDisplay;
  locked: boolean;
}): React.JSX.Element => {
  const corner = labelCorner(display.stageNumber);
  const blockStyle = corner === 'left' ? styles.labelBlockLeft : styles.labelBlockRight;
  return (
    <View style={blockStyle} testID={`aspect-label-${display.stageNumber}`}>
      <Text style={styles.arrowLabelText}>{display.arrowLabel}</Text>
      {locked ? <UnlockTimeline stageNumber={display.stageNumber} corner={corner} /> : null}
    </View>
  );
};

// Title rows (9, 10) keep their centered serif heading; every other stage shows
// its corner-hugging Aspect-label block instead of a centered word.
const CenterContent = ({
  display,
  locked,
}: {
  display: StageDisplay;
  locked: boolean;
}): React.JSX.Element | null => {
  const title = TITLE_BY_STAGE[display.stageNumber];
  if (title) {
    return (
      <Text style={styles.titleText} adjustsFontSizeToFit numberOfLines={1}>
        {title}
      </Text>
    );
  }
  if (!display.arrowLabel) {
    return null;
  }
  return <AspectLabelBlock display={display} locked={locked} />;
};

interface StageCenterCellProps extends StageCellProps {
  /** Index of the row this cell sits in, for anchor measurement. */
  rowIndex: number;
  /** Record this cell's measured row-relative center on layout. */
  onCellLayout: UseStageAnchorsResult['onCellLayout'];
}

const StageCenterCell = ({
  stage,
  display,
  locked,
  isCurrent,
  onPress,
  rowIndex,
  onCellLayout,
}: StageCenterCellProps): React.JSX.Element => (
  <TouchableOpacity
    testID={`stage-hotspot-${display.stageNumber}-1`}
    style={[
      styles.centerStageCell,
      isLeftReturning(display.stageNumber) ? styles.cellFeminine : styles.cellMasculine,
      locked ? styles.locked : null,
      isCurrent ? styles.cellCurrent : null,
    ]}
    onPress={() => onPress(stage)}
    onLayout={(e) => onCellLayout(display.stageNumber, rowIndex, e)}
    accessibilityRole="button"
    accessibilityLabel={`${stage.title} - ${stage.subtitle}`}
  >
    {isCurrent ? <YouAreHereMarker /> : null}
    <CenterContent display={display} locked={locked} />
    {locked ? <LockGlyph /> : null}
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
  rowIndex: number;
  lookup: StageLookup;
  fullnessByStage: FullnessLookup;
  currentStage: number | null;
  onPress: (_stage: StageData) => void;
  onRowLayout: UseStageAnchorsResult['onRowLayout'];
  onCellLayout: UseStageAnchorsResult['onCellLayout'];
}

/** A row's stages resolved to their loaded StageData + display copy. */
type ResolvedStage = { stage: StageData; display: StageDisplay };

const resolveRowStages = (row: MapRow, lookup: StageLookup): ResolvedStage[] =>
  row.stageNumbers
    .map((n) => ({ stage: lookup[n], display: STAGE_DISPLAY[n] }))
    .filter((r): r is ResolvedStage => !!r.stage && !!r.display);

/** Left column of one row: the colored stage-text tap targets, stacked. */
const RowLeftColumn = ({
  resolved,
  fullnessByStage,
  currentStage,
  onPress,
}: {
  resolved: ResolvedStage[];
  fullnessByStage: FullnessLookup;
  currentStage: number | null;
  onPress: (_stage: StageData) => void;
}): React.JSX.Element => (
  <View style={styles.leftCell}>
    {resolved.map(({ stage, display }) => (
      <StageTextBlock
        key={stage.stageNumber}
        stage={stage}
        display={display}
        locked={!isStageUnlocked(stage, currentStage)}
        isCurrent={stage.stageNumber === currentStage}
        fullness={fullnessByStage[stage.stageNumber] ?? THIN_FULLNESS}
        onPress={onPress}
      />
    ))}
  </View>
);

/** Center column of one row: the per-stage glyph cells that anchor the wave. */
const RowCenterColumn = ({
  resolved,
  rowIndex,
  currentStage,
  onPress,
  onCellLayout,
}: {
  resolved: ResolvedStage[];
  rowIndex: number;
  currentStage: number | null;
  onPress: (_stage: StageData) => void;
  onCellLayout: UseStageAnchorsResult['onCellLayout'];
}): React.JSX.Element => (
  <View style={styles.centerCell}>
    {resolved.map(({ stage, display }) => (
      <StageCenterCell
        key={stage.stageNumber}
        stage={stage}
        display={display}
        locked={!isStageUnlocked(stage, currentStage)}
        isCurrent={stage.stageNumber === currentStage}
        onPress={onPress}
        rowIndex={rowIndex}
        onCellLayout={onCellLayout}
      />
    ))}
  </View>
);

/** One grid row: left text + center glyph stacked per stage, one aspect label. */
const MapRowView = ({
  row,
  rowIndex,
  lookup,
  fullnessByStage,
  currentStage,
  onPress,
  onRowLayout,
  onCellLayout,
}: MapRowProps): React.JSX.Element => {
  const resolved = resolveRowStages(row, lookup);
  return (
    <View
      style={[styles.groupRow, { flex: row.stageNumbers.length }]}
      testID={`map-row-${row.rightLabel}`}
      onLayout={(e) => onRowLayout(rowIndex, e)}
    >
      <RowLeftColumn
        resolved={resolved}
        fullnessByStage={fullnessByStage}
        currentStage={currentStage}
        onPress={onPress}
      />
      <RowCenterColumn
        resolved={resolved}
        rowIndex={rowIndex}
        currentStage={currentStage}
        onPress={onPress}
        onCellLayout={onCellLayout}
      />
      <View style={styles.rightCell}>
        <Text style={styles.rightLabelText} numberOfLines={2}>
          {row.rightLabelLines.join('\n')}
        </Text>
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

// Ranked actions: the primary "Continue" (the stage's Practice) sits full-width
// above two secondary links. Visual hierarchy only — every handler + testID is
// unchanged, so Practice/Course/Journal still route exactly as before.
const ActionLinks = ({ stage, onNavigate }: ActionLinksProps): React.JSX.Element => (
  <View style={styles.actions}>
    <TouchableOpacity
      testID="practice-link"
      style={styles.primaryAction}
      onPress={() => onNavigate('Practice', stage)}
      accessibilityRole="button"
      accessibilityLabel="Continue this stage"
    >
      <Text style={styles.primaryActionText}>Continue</Text>
    </TouchableOpacity>
    <View style={styles.secondaryActionsRow}>
      <TouchableOpacity
        testID="course-link"
        style={styles.secondaryAction}
        onPress={() => onNavigate('Course', stage)}
      >
        <Text style={styles.secondaryActionText}>Course</Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID="journal-link"
        style={styles.secondaryAction}
        onPress={() => onNavigate('Journal', stage)}
      >
        <Text style={styles.secondaryActionText}>Journal</Text>
      </TouchableOpacity>
    </View>
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

const RankedStatsRow = ({
  history,
}: {
  history: StageHistoryResponse;
}): React.JSX.Element | null => {
  const stats = rankedStats(history);
  if (stats.length === 0) return null;
  return (
    <View style={styles.rankedStatsRow} testID="ranked-stats">
      {stats.map((stat) => (
        <View key={stat.key} style={styles.rankedStat} testID={`ranked-stat-${stat.key}`}>
          <Text style={styles.rankedStatValue}>{stat.value}</Text>
          <Text style={styles.rankedStatLabel}>{stat.label}</Text>
        </View>
      ))}
    </View>
  );
};

/** One progression sentence + the ranked headline stats for the stage. */
const JourneyNarrativeBlock = ({
  history,
}: {
  history: StageHistoryResponse;
}): React.JSX.Element => (
  <View testID="journey-narrative">
    <Text style={styles.progressionSentence} testID="progression-sentence">
      {progressionSentence(history)}
    </Text>
    <RankedStatsRow history={history} />
  </View>
);

const HistoryContent = ({ history }: { history: StageHistoryResponse }): React.JSX.Element => (
  <View testID="history-content">
    <JourneyNarrativeBlock history={history} />
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
      <Pressable
        style={[styles.modalContent, activeStage ? { borderLeftColor: activeStage.color } : null]}
        onPress={() => {}}
        testID="stage-modal"
      >
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
  fullnessByStage: FullnessLookup;
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

/** The first pass through the arc; cycles beyond it earn the subtle indicator. */
const FIRST_CYCLE = 1;

interface JourneyHeaderProps {
  currentStage: number;
  cycleNumber: number;
}

/** Compact momentum read at the top of the Map: "Stage N of 10 · Week W". */
const JourneyHeader = ({ currentStage, cycleNumber }: JourneyHeaderProps): React.JSX.Element => {
  const week = useDerivedCurrentWeek(1);
  return (
    <View style={styles.journeyHeader} testID="journey-read">
      <Text style={styles.journeyReadText}>{journeyRead(currentStage, week, STAGE_COUNT)}</Text>
      {cycleNumber > FIRST_CYCLE ? (
        <Text style={styles.cycleIndicator} testID="cycle-indicator">
          {cycleLabel(cycleNumber)}
        </Text>
      ) : null}
    </View>
  );
};

/** End-of-arc "begin again" affordance: a gentle, declinable invitation the user chooses — never auto-invoked. */
const BeginAgainBlock = ({
  onBeginAgain,
  beginning,
}: {
  onBeginAgain: () => void;
  beginning: boolean;
}): React.JSX.Element => (
  <View style={styles.beginAgain} testID="begin-again">
    <Text style={styles.beginAgainHeading}>{BEGIN_AGAIN_COPY.heading}</Text>
    <Text style={styles.beginAgainBody}>{BEGIN_AGAIN_COPY.body}</Text>
    <Button
      label={BEGIN_AGAIN_COPY.action}
      variant="tertiary"
      onPress={onBeginAgain}
      // Disable while the first POST is in flight so a double-press can't
      // advance the cycle twice before ``loadStages`` hides this button.
      disabled={beginning}
      testID="begin-again-button"
      accessibilityLabel="Begin again — start a new cycle through the arc"
    />
  </View>
);

/** Measured pixel size of the grid; zero until the first layout pass reports it. */
interface GridSize {
  width: number;
  height: number;
}

const EMPTY_GRID_SIZE: GridSize = { width: 0, height: 0 };

/** Track the grid's measured size, updated on every layout pass. */
const useGridSize = (): [GridSize, (_event: LayoutChangeEvent) => void] => {
  const [size, setSize] = useState<GridSize>(EMPTY_GRID_SIZE);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  }, []);
  return [size, onLayout];
};

const MapGrid = ({
  lookup,
  fullnessByStage,
  currentStage,
  onSelectStage,
}: MapGridProps): React.JSX.Element => {
  const [size, onLayout] = useGridSize();
  const { anchors, onRowLayout, onCellLayout } = useStageAnchors(size.height);
  return (
    <View style={styles.grid} testID="map-grid" onLayout={onLayout}>
      <WaveOverlay width={size.width} height={size.height} anchors={anchors} />
      {MAP_ROWS.map((row, index) => (
        <MapRowView
          key={row.rightLabel}
          row={row}
          rowIndex={index}
          lookup={lookup}
          fullnessByStage={fullnessByStage}
          currentStage={currentStage}
          onPress={onSelectStage}
          onRowLayout={onRowLayout}
          onCellLayout={onCellLayout}
        />
      ))}
    </View>
  );
};

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

/** Highest stage number whose progress has reached 100%, or 0 when none. */
const highestCompletedStage = (stages: readonly StageData[]): number =>
  stages.reduce((max, s) => (s.progress >= FULL_PROGRESS ? Math.max(max, s.stageNumber) : max), 0);

interface CompletionCelebration {
  active: boolean;
  message: string;
  dismiss: () => void;
}

/**
 * Watch for a newly-completed stage and surface a celebration naming the stage
 * that just unlocked. The first render seeds the baseline (no celebration on
 * mount); thereafter a rise in the highest-completed stage fires once.
 */
const useStageCompletionCelebration = (
  stages: readonly StageData[],
  lookup: StageLookup,
): CompletionCelebration => {
  const completed = highestCompletedStage(stages);
  const prevCompletedRef = useRef<number | null>(null);
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const prev = prevCompletedRef.current;
    prevCompletedRef.current = completed;
    if (prev === null || completed <= prev) return;
    const next = lookup[completed + 1];
    const nextName = next ? next.title : 'The next stage';
    setMessage(`${nextName} unlocked`);
    setActive(true);
  }, [completed, lookup]);

  const dismiss = useCallback(() => setActive(false), []);
  return { active, message, dismiss };
};

const CelebrationBanner = ({
  active,
  message,
  onDismiss,
}: {
  active: boolean;
  message: string;
  onDismiss: () => void;
}): React.JSX.Element | null => {
  if (!active) return null;
  return (
    <Celebration active={active} onDismiss={onDismiss} testID="stage-celebration">
      <View style={styles.celebrationBanner}>
        <Text style={styles.celebrationText}>{message}</Text>
      </View>
    </Celebration>
  );
};

interface MapContentProps {
  lookup: StageLookup;
  fullnessByStage: FullnessLookup;
  currentStage: number;
  cycleNumber: number;
  showBeginAgain: boolean;
  beginning: boolean;
  showRefreshError: boolean;
  activeStage: StageData | null;
  celebration: CompletionCelebration;
  onRefresh: () => void;
  onBeginAgain: () => void;
  onSelectStage: (_stage: StageData) => void;
  onCloseModal: () => void;
  onNavigate: (_screen: NavTarget, _stage: StageData) => void;
}

/** The rendered Map: spiral grid + banners + stage modal. */
const MapContent = (props: MapContentProps): React.JSX.Element => (
  <View style={styles.container}>
    <MapBackdrop />
    <JourneyHeader currentStage={props.currentStage} cycleNumber={props.cycleNumber} />
    <MapGrid
      lookup={props.lookup}
      fullnessByStage={props.fullnessByStage}
      currentStage={props.currentStage}
      onSelectStage={props.onSelectStage}
    />
    {props.showBeginAgain && (
      <BeginAgainBlock onBeginAgain={props.onBeginAgain} beginning={props.beginning} />
    )}
    {props.showRefreshError && <MapRefreshErrorBanner onRetry={props.onRefresh} />}
    <CelebrationBanner
      active={props.celebration.active}
      message={props.celebration.message}
      onDismiss={props.celebration.dismiss}
    />
    <StageDetailModal
      activeStage={props.activeStage}
      onClose={props.onCloseModal}
      onNavigate={props.onNavigate}
    />
  </View>
);

const MapScreen = (): React.JSX.Element => {
  const stages = useStageStore(selectStages);
  const loading = useStageStore(selectStagesLoading);
  const error = useStageStore(selectStagesError);
  const storeCurrentStage = useStageStore(selectCurrentStage);
  const cycleNumber = useStageStore(selectCycleNumber);
  // Prefer the date-driven stage when the master anchor is set; the
  // server's count-based ``currentStage`` is the fallback for users who
  // haven't picked an anchor yet.
  const currentStage = useDerivedCurrentStage(storeCurrentStage);
  // Additive overlay: a failed/loading read leaves the map empty so every Aspect reads thin.
  const { fullnessByStage } = useWheelBalance();
  const [activeStage, setActiveStage] = useState<StageData | null>(null);
  const { beginning, handleBeginAgain } = useBeginAgainGuard();

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
  const celebration = useStageCompletionCelebration(stages, lookup);

  if (loading && stages.length === 0) return <MapLoading />;
  if (error && stages.length === 0) return <MapError message={error} />;

  return (
    <MapContent
      lookup={lookup}
      fullnessByStage={fullnessByStage}
      currentStage={currentStage}
      cycleNumber={cycleNumber}
      showBeginAgain={isEndOfCycle(lookup, currentStage)}
      beginning={beginning}
      showRefreshError={!!error && stages.length > 0}
      activeStage={activeStage}
      celebration={celebration}
      onRefresh={handleRefresh}
      onBeginAgain={handleBeginAgain}
      onSelectStage={setActiveStage}
      onCloseModal={handleCloseModal}
      onNavigate={handleNavigate}
    />
  );
};

export default MapScreen;
