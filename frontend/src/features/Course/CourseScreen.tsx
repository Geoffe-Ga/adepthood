import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Hourglass, TriangleAlert } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  course as courseApi,
  stages as stagesApi,
  uiFlags,
  type ContentItem,
  type CourseProgress,
  type NextUnread,
  type SiteResource,
  type Stage,
} from '../../api';
import { decorativeHidden } from '../../components/a11yHidden';
import {
  DrawerNavSection,
  ScreenDrawer,
  useScreenDrawer,
  type ScreenDrawerState,
} from '../../components/drawer';
import { Celebration } from '../../components/feedback/Celebration';
import { EmptyState } from '../../components/feedback/EmptyState';
import { BottomFade } from '../../components/layout/BottomFade';
import { ContentContainer } from '../../components/layout/ContentContainer';
import { EditorialSection } from '../../components/layout/EditorialSection';
import { ScreenHeader } from '../../components/layout/ScreenHeader';
import { ShowcaseCard } from '../../components/layout/ShowcaseCard';
import { ink, resolveStageColor } from '../../design/tokens';
import type { RootTabParamList } from '../../navigation/BottomTabs';
import { useAppRoute } from '../../navigation/hooks';
import type { RootStackParamList } from '../../navigation/RootStack';
import { useProgramStore, programStage } from '../../store/useProgramStore';

import { deriveChapterNeighbors, type ChapterNav } from './chapterNav';
import ChapterReader, { type WriteNotePassage } from './ChapterReader';
import ContentCard from './ContentCard';
import ContentViewer from './ContentViewer';
import styles from './Course.styles';
import CourseDrawer, { useCourseDrawerBodies, useCourseDrawerContent } from './CourseDrawer';
import ReadNextButton, { useNextUnread, type NextUnreadState } from './ReadNextButton';
import RetryButton from './RetryButton';
import SiteResourcesPanel from './SiteResourcesPanel';
import StageIntroCard from './StageIntroCard';
import StageSelector from './StageSelector';

const DEFAULT_STAGE_NUMBER = 1;

// Stable empty reference so the FlatList shows ListEmptyComponent while a stage
// is loading or after a failed fetch, without churning the data prop's identity.
const EMPTY_CONTENT: ContentItem[] = [];

// --- Hook: load stages on mount ---

async function defaultReadingStage(
  stagesList: Stage[],
  programAnchor: Date | null,
): Promise<number> {
  const { course_last_stage: lastReadStage } = await uiFlags.get();
  const savedStage = stagesList.find(
    (stage) => stage.stage_number === lastReadStage && stage.is_unlocked,
  );
  // Reading position survives devices. Cycle resets may lock that Frequency
  // again, so only an available saved stage takes precedence over the calendar.
  return (
    savedStage?.stage_number ??
    programStage(programAnchor) ??
    (await stagesApi.programCalendar()).current_stage
  );
}

function useStagesLoader() {
  const route = useAppRoute<'Course'>();
  const routeStageNumber = route.params?.stageNumber ?? null;
  const programAnchor = useProgramStore((s) => s.programStartDate);

  const [allStages, setAllStages] = useState<Stage[]>([]);
  const [selectedStage, setSelectedStage] = useState(routeStageNumber ?? DEFAULT_STAGE_NUMBER);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const requestSeq = useRef(0);

  const init = useCallback(async () => {
    const requestId = (requestSeq.current += 1);
    const isLatest = () => requestId === requestSeq.current;
    setLoading(true);
    setError(false);
    try {
      const stagesList = await stagesApi.listAll();
      if (routeStageNumber === null) {
        const initialStage = await defaultReadingStage(stagesList, programAnchor);
        if (!isLatest()) return;
        setSelectedStage(initialStage);
      }
      if (!isLatest()) return;
      setAllStages(stagesList);
    } catch (err) {
      if (!isLatest()) return;
      // Track failure explicitly so the screen can show error+retry instead of
      // an empty course (audit-ux-04).
      console.error('Failed to load stages:', err);
      setError(true);
    } finally {
      if (isLatest()) setLoading(false);
    }
  }, [routeStageNumber, programAnchor]);

  useEffect(() => {
    void init();
    return () => {
      // A route/anchor change or unmount supersedes every older async load.
      requestSeq.current += 1;
    };
  }, [init]);

  // A warm Course tab stays mounted, so a later Map->Course deep-link changes
  // only the route param. Follow a changed non-null incoming stage number here;
  // a null param (no deep-link) leaves the derived default untouched, and a
  // same-number re-navigation is a no-op because the effect keys on the number.
  useEffect(() => {
    if (routeStageNumber !== null) {
      setSelectedStage(routeStageNumber);
    }
  }, [routeStageNumber]);

  return { allStages, selectedStage, setSelectedStage, loading, error, retry: init };
}

// --- Hook: load content for selected stage ---

function useStageContent(selectedStage: number, stagesLoaded: boolean) {
  const [content, setContent] = useState<ContentItem[]>([]);
  const [progress, setProgress] = useState<CourseProgress | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState(false);
  const requestSeq = useRef(0);

  const refreshContent = useCallback(async () => {
    // Only the newest in-flight request may settle; stale ones are dropped.
    const requestId = (requestSeq.current += 1);
    const isLatest = () => requestId === requestSeq.current;
    setLoadingContent(true);
    setError(false);
    try {
      const [contentResult, progressResult] = await Promise.all([
        courseApi.stageContentAll(selectedStage),
        courseApi.stageProgress(selectedStage),
      ]);
      if (!isLatest()) return;
      setContent(contentResult);
      setProgress(progressResult);
    } catch (err) {
      // A failed fetch is distinct from a genuinely empty stage: flag it so the
      // screen shows error+retry rather than "No Content Yet" (audit-ux-04).
      console.error('Failed to load stage content:', err);
      if (isLatest()) {
        setContent([]);
        setProgress(null);
        setError(true);
      }
    } finally {
      if (isLatest()) setLoadingContent(false);
    }
  }, [selectedStage]);

  useEffect(() => {
    if (!stagesLoaded) return;
    void refreshContent();
    // On unmount, supersede any in-flight run so it cannot setState afterward.
    return () => {
      requestSeq.current += 1;
    };
  }, [stagesLoaded, refreshContent]);

  const handleMarkRead = useCallback(() => {
    void refreshContent();
  }, [refreshContent]);

  return { content, progress, loadingContent, handleMarkRead, error, retry: refreshContent };
}

// --- Sub-components ---

const stageIsComplete = (progress: CourseProgress | null): boolean =>
  progress != null && progress.total_items > 0 && progress.read_items >= progress.total_items;

interface StageCoverProps {
  stage: Stage;
  progress: CourseProgress | null;
  spiralColor: string | undefined;
}

/** The showcase "book cover" for the selected stage: serif title, Spiral-Dynamics
 *  accent rule, progress arc, and a celebration when the stage is finished. */
const StageCover = ({ stage, progress, spiralColor }: StageCoverProps): React.JSX.Element => {
  const accentColor = resolveStageColor(spiralColor);
  const percent = progress ? progress.progress_percent : 0;
  const complete = stageIsComplete(progress);
  return (
    <ShowcaseCard style={styles.stageCover} testID="stage-cover">
      <Text style={styles.stageCoverEyebrow}>{`Chapter ${stage.stage_number}`}</Text>
      <Text style={styles.stageCoverTitle}>{stage.title}</Text>
      <Text style={styles.stageCoverSubtitle}>{stage.subtitle}</Text>
      <View style={[styles.stageCoverRule, { backgroundColor: accentColor }]} />
      <View style={styles.stageCoverProgressTrack}>
        <View
          testID="stage-cover-progress"
          style={[
            styles.stageCoverProgressFill,
            { width: `${percent}%`, backgroundColor: accentColor },
          ]}
        />
      </View>
      <Celebration active={complete} testID="stage-cover-celebration">
        <Text style={styles.stageCoverProgressLabel}>
          {complete
            ? '✓ Stage complete'
            : progress
              ? `${progress.read_items} of ${progress.total_items} read`
              : ' '}
        </Text>
      </Celebration>
    </ShowcaseCard>
  );
};

const StageMetadata = ({ stage }: { stage: Stage }): React.JSX.Element => (
  <View style={styles.stageMetadata} testID="stage-metadata">
    <View style={styles.stageDetailRow}>
      <Text style={styles.stageDetailLabel}>Spiral Dynamics</Text>
      <Text style={styles.stageDetailValue}>{stage.spiral_dynamics_color}</Text>
    </View>
    <View style={styles.stageDetailRow}>
      <Text style={styles.stageDetailLabel}>Growing Up Stage</Text>
      <Text style={styles.stageDetailValue}>{stage.growing_up_stage}</Text>
    </View>
  </View>
);

interface ProgressBarProps {
  progress: CourseProgress | null;
  spiralColor: string | undefined;
  error?: boolean;
}

const progressLabel = (progress: CourseProgress | null, error: boolean): string => {
  if (error) return 'Progress unavailable';
  return progress ? `${progress.read_items}/${progress.total_items} completed` : 'Loading...';
};

const CourseProgressBar = ({
  progress,
  spiralColor,
  error = false,
}: ProgressBarProps): React.JSX.Element => {
  const progressPercent = progress ? progress.progress_percent : 0;
  const barColor = resolveStageColor(spiralColor);

  return (
    <View style={styles.progressBarContainer} testID="progress-bar">
      <View style={styles.progressBarTrack}>
        <View
          testID="progress-bar-fill"
          style={[
            styles.progressBarFill,
            { width: `${progressPercent}%`, backgroundColor: barColor },
          ]}
        />
      </View>
      <Text style={styles.progressBarLabel}>{progressLabel(progress, error)}</Text>
    </View>
  );
};

const CourseEmptyState = (): React.JSX.Element => (
  <EmptyState
    glyph="📚"
    title="No Content Yet"
    body="Content for this stage has not been added yet. Check back soon."
  />
);

/**
 * The drawn icon box heading the error and loading-timeout states. It keeps the
 * footprint of the emoji it replaced (#2964), and it is an icon, not text, so it
 * sets no font size and never reaches the text census.
 */
export const STATE_ICON_SIZE = 48;

interface StateIconProps {
  icon: typeof TriangleAlert;
  testID: string;
}

/**
 * Decorative: the state's title beside it already says what happened, so
 * ``decorativeHidden`` hides it from every screen reader, the web's included.
 */
const StateIcon = ({ icon: Icon, testID }: StateIconProps): React.JSX.Element => (
  <View style={styles.emptyIcon} testID={testID} {...decorativeHidden()}>
    <Icon size={STATE_ICON_SIZE} color={ink.muted} />
  </View>
);

const CourseErrorState = ({ onRetry }: { onRetry: () => void }): React.JSX.Element => (
  <View style={styles.emptyContainer} testID="course-error">
    <StateIcon icon={TriangleAlert} testID="course-error-icon" />
    <Text style={styles.emptyTitle}>Couldn&apos;t load the course</Text>
    <Text style={styles.emptySubtitle}>
      Something went wrong loading this stage. Check your connection and try again.
    </Text>
    <RetryButton onRetry={onRetry} testID="course-retry" />
  </View>
);

/**
 * How long the cold-start spinner may hold the whole Course tab before it
 * offers a way out. ``loading`` only flips back when the stage-list request
 * settles, so a dropped connection, a backgrounded app or a proxy holding the
 * socket open leaves it true for good — long enough that a slow-but-alive
 * network still lands first, short enough that nobody is asked to trust an
 * indefinite spinner. Valued to match ``MAP_LOADING_TIMEOUT_MS``: the two cold
 * starts must not disagree about how long a person is asked to wait.
 */
export const COURSE_LOADING_TIMEOUT_MS = 12_000;

// The cold start's last dead end: a spinner with no timeout and nothing to
// press. After the bounded wait it says so plainly and offers the same explicit
// "Try again" the error state uses.
const CourseLoadingTimedOut = ({ onRetry }: { onRetry: () => void }): React.JSX.Element => (
  <View
    style={styles.emptyContainer}
    testID="course-loading-timeout"
    accessibilityRole="alert"
    accessibilityLiveRegion="polite"
  >
    <StateIcon icon={Hourglass} testID="course-loading-timeout-icon" />
    <Text style={styles.emptyTitle}>The course is taking longer than it should</Text>
    <Text style={styles.emptySubtitle}>
      It may still be on its way. Check your connection and try again.
    </Text>
    <RetryButton onRetry={onRetry} testID="course-loading-retry" />
  </View>
);

// Retrying re-arms the wait, so a second slow attempt gets the spinner back
// rather than a stale message; the timer is dropped on unmount and when
// ``loading`` settles, because that unmounts this component with it.
const CourseLoadingState = ({ onRetry }: { onRetry: () => void }): React.JSX.Element => {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (timedOut) return undefined;
    const timer = setTimeout(() => setTimedOut(true), COURSE_LOADING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [timedOut]);

  const handleRetry = useCallback(() => {
    setTimedOut(false);
    onRetry();
  }, [onRetry]);

  return (
    <SafeAreaView style={styles.container}>
      {timedOut ? (
        <CourseLoadingTimedOut onRetry={handleRetry} />
      ) : (
        <View style={styles.loadingContainer}>
          <ActivityIndicator testID="course-loading" size="large" />
        </View>
      )}
    </SafeAreaView>
  );
};

const ContentLoadingIndicator = (): React.JSX.Element => (
  <View style={styles.loadingContainer}>
    <ActivityIndicator testID="content-loading" size="small" />
  </View>
);

interface ContentAreaProps {
  content: ContentItem[];
  loadingContent: boolean;
  error: boolean;
  header: React.ReactElement;
  onContentPress: (_item: ContentItem) => void;
  onRetry: () => void;
}

/** The single scroll surface: the stage header and the chapter list share one
 *  FlatList so the whole landing page scrolls together. Loading, error, and
 *  empty states render in ``ListEmptyComponent`` below the pinned header. */
const ContentArea = ({
  content,
  loadingContent,
  error,
  header,
  onContentPress,
  onRetry,
}: ContentAreaProps): React.JSX.Element => {
  const renderContentItem = useCallback(
    ({ item }: { item: ContentItem }) => <ContentCard item={item} onPress={onContentPress} />,
    [onContentPress],
  );

  const empty = useMemo(() => {
    if (loadingContent) return <ContentLoadingIndicator />;
    if (error) return <CourseErrorState onRetry={onRetry} />;
    return <CourseEmptyState />;
  }, [loadingContent, error, onRetry]);

  return (
    <FlatList
      testID="content-list"
      style={styles.contentList}
      contentContainerStyle={styles.contentListContent}
      data={content}
      renderItem={renderContentItem}
      keyExtractor={(item) => String(item.id)}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
    />
  );
};

// --- Hook: viewer actions ---

/** The two journal hand-offs from an open chapter: the stage reflection, which
 *  closes the reader behind it, and the passage-note flow that keeps the reader
 *  mounted for a warm return. Both carry a ``returnTo`` so the writing surface
 *  can offer "Back to reading"; only the note flow has a scroll position to
 *  restore. */
function useJournalHandoff(
  selectedStage: number,
  viewingItem: ContentItem | null,
  clearViewingItem: () => void,
) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  // Carry the reader's location across so "Back to reading" has somewhere to go;
  // without it the only exit from the reflection was the Journal shelf, and the
  // writer had to find the Course tab again by hand.
  //
  // Deliberately no `scrollOffset`, unlike the passage-note flow below. Nothing
  // on this path has one to give: `onReflect` takes no argument, so where the
  // reader stood was never captured, and `clearViewingItem()` closes the reader
  // a line later -- there is no warm reader left to return to. The button that
  // fires this only appears once the chapter is read, so the honest landing is
  // the chapter reopened at its top, which is what an absent offset asks for
  // (`useReaderRestore` reads it as 0). Sending `scrollOffset: 0` instead would
  // dress up "no position known" as a position.
  const handleReflect = useCallback(() => {
    if (!viewingItem) return;
    navigation.navigate('JournalEntry', {
      prefillTitle: `Stage ${selectedStage} reflection — ${viewingItem.title}`,
      returnTo: {
        screen: 'Course',
        params: { stageNumber: selectedStage, contentId: viewingItem.id },
      },
    });
    clearViewingItem();
  }, [viewingItem, selectedStage, navigation, clearViewingItem]);

  // Fold the chosen passage into the journal while the reader stays mounted, so
  // "Back to reading" is a cheap warm return to the same scroll position.
  const handleWriteNote = useCallback(
    (passage: WriteNotePassage) => {
      if (!viewingItem) return;
      navigation.navigate('JournalEntry', {
        prefillQuote: { text: passage.text, sourceTitle: passage.sourceTitle },
        returnTo: {
          screen: 'Course',
          params: {
            stageNumber: selectedStage,
            contentId: viewingItem.id,
            scrollOffset: passage.scrollOffset,
          },
        },
      });
    },
    [viewingItem, selectedStage, navigation],
  );

  return { handleReflect, handleWriteNote };
}

function useCourseViewer(selectedStage: number) {
  const [viewingItem, setViewingItem] = useState<ContentItem | null>(null);
  const [viewingResource, setViewingResource] = useState<SiteResource | null>(null);
  const [viewingIntro, setViewingIntro] = useState<number | null>(null);
  // Only set on a warm return; a manual open clears it so no stale scroll leaks.
  const [restoreOffset, setRestoreOffset] = useState<number | undefined>(undefined);

  const clearViewingItem = useCallback(() => setViewingItem(null), []);

  const handleContentPress = useCallback((item: ContentItem) => {
    if (item.is_locked) return;
    setRestoreOffset(undefined);
    setViewingItem(item);
  }, []);

  const openForRestore = useCallback((item: ContentItem, offset: number) => {
    setRestoreOffset(offset);
    setViewingItem(item);
  }, []);

  const handleResourcePress = useCallback((resource: SiteResource) => {
    setViewingResource(resource);
  }, []);

  const handleIntroPress = useCallback((stageNumber: number) => {
    setViewingIntro(stageNumber);
  }, []);

  const handleBack = useCallback(() => {
    setViewingItem(null);
    setViewingResource(null);
    setViewingIntro(null);
    setRestoreOffset(undefined);
  }, []);

  const { handleReflect, handleWriteNote } = useJournalHandoff(
    selectedStage,
    viewingItem,
    clearViewingItem,
  );

  return {
    viewingItem,
    viewingResource,
    viewingIntro,
    restoreOffset,
    openForRestore,
    handleContentPress,
    handleResourcePress,
    handleIntroPress,
    handleBack,
    handleReflect,
    handleWriteNote,
  };
}

/** On a return from the journal, auto-open the returned content restored to its
 *  scroll offset once the stage's content has loaded. The restore is one-shot per
 *  ``contentId``: the param persists on the route indefinitely, so a ref records
 *  the id already restored and refuses to re-fire — otherwise backing out of the
 *  reader (viewing id → null) or revisiting the tab would re-open it unbidden.
 *  Keyed on primitive params + loaded content (never object identity) so it fires
 *  once and never loops.
 *
 *  ``rearm`` is the one deliberate exception: "Read next" asks for the routed
 *  chapter to open again even when the route already names it (the reader backed
 *  out without finishing it), so it forgets the restored id and re-runs the
 *  effect once. */
function useReaderRestore(
  content: ContentItem[],
  currentViewingId: number | null,
  openForRestore: (_item: ContentItem, _offset: number) => void,
): { rearm: () => void } {
  const route = useAppRoute<'Course'>();
  const contentId = route.params?.contentId ?? null;
  const scrollOffset = route.params?.scrollOffset ?? 0;
  const restoredIdRef = useRef<number | null>(null);
  const [armSeq, setArmSeq] = useState(0);

  const rearm = useCallback(() => {
    restoredIdRef.current = null;
    setArmSeq((seq) => seq + 1);
  }, []);

  useEffect(() => {
    if (contentId === null || restoredIdRef.current === contentId) return;
    if (currentViewingId === contentId) return;
    const item = content.find((c) => c.id === contentId);
    if (!item || item.is_locked) return;
    restoredIdRef.current = contentId;
    openForRestore(item, scrollOffset);
  }, [contentId, scrollOffset, currentViewingId, content, openForRestore, armSeq]);

  return { rearm };
}

interface ReadNextProps {
  state: NextUnreadState;
  onOpen: (_target: NextUnread) => void;
}

/** "Read next" (#3147): open the server's earliest unread chapter through the
 *  same route-param path a journal return uses, so ``useReaderRestore`` does the
 *  opening once that chapter's stage has loaded. The stage is selected directly
 *  as well, because a route already carrying this stage number would not move
 *  the selection a reader has since changed with the pills. */
function useReadNext(setSelectedStage: (_stageNumber: number) => void, rearm: () => void) {
  const navigation = useNavigation<BottomTabNavigationProp<RootTabParamList, 'Course'>>();
  const nextUnread = useNextUnread();

  const openNext = useCallback(
    (target: NextUnread) => {
      setSelectedStage(target.stage_number);
      // ``scrollOffset`` is cleared so a stale journal-return offset can never
      // drop the reader halfway down a chapter they have not started.
      navigation.setParams({
        stageNumber: target.stage_number,
        contentId: target.content_id,
        scrollOffset: undefined,
      });
      rearm();
    },
    [navigation, setSelectedStage, rearm],
  );

  return { state: nextUnread.state, refresh: nextUnread.refresh, openNext };
}

/** The reader's position across the screen: the journal-return restore, the
 *  "Read next" target, and the mark-read handler that keeps both lists and the
 *  target current. A chapter marked read moves the target, so it is re-asked. */
function useCourseReadingPosition(
  stageContent: ReturnType<typeof useStageContent>,
  viewer: ReturnType<typeof useCourseViewer>,
  setSelectedStage: (_stageNumber: number) => void,
): { readNext: ReadNextProps; onMarkRead: () => void } {
  const { rearm } = useReaderRestore(
    stageContent.content,
    viewer.viewingItem?.id ?? null,
    viewer.openForRestore,
  );
  const { state, refresh, openNext } = useReadNext(setSelectedStage, rearm);
  const { handleMarkRead } = stageContent;
  const onMarkRead = useCallback(() => {
    handleMarkRead();
    refresh();
  }, [handleMarkRead, refresh]);
  const readNext = useMemo(() => ({ state, onOpen: openNext }), [state, openNext]);
  return { readNext, onMarkRead };
}

// --- Main component ---

function buildChapterNav(
  viewer: ReturnType<typeof useCourseViewer>,
  content: ContentItem[],
  current: ContentItem,
): ChapterNav {
  const { prev, next, nextIsDone } = deriveChapterNeighbors(content, current.id);
  return {
    canPrev: prev !== null,
    nextIsDone,
    onPrev: () => {
      if (prev !== null) viewer.handleContentPress(prev);
    },
    onNext: () => {
      if (nextIsDone || next === null) viewer.handleBack();
      else viewer.handleContentPress(next);
    },
  };
}

function renderOverlay(
  viewer: ReturnType<typeof useCourseViewer>,
  onMarkRead: () => void,
  content: ContentItem[],
): React.JSX.Element | null {
  if (viewer.viewingItem) {
    const nav = buildChapterNav(viewer, content, viewer.viewingItem);
    return (
      <ContentViewer
        item={viewer.viewingItem}
        onBack={viewer.handleBack}
        onMarkRead={onMarkRead}
        onReflect={viewer.handleReflect}
        nav={nav}
        onWriteNote={viewer.handleWriteNote}
        initialScrollOffset={viewer.restoreOffset}
      />
    );
  }
  if (viewer.viewingResource) {
    return (
      <ChapterReader
        source={{ kind: 'resource', slug: viewer.viewingResource.slug }}
        fallbackTitle={viewer.viewingResource.title}
        onBack={viewer.handleBack}
      />
    );
  }
  if (viewer.viewingIntro !== null) {
    return (
      <ChapterReader
        source={{ kind: 'intro', stageNumber: viewer.viewingIntro }}
        fallbackTitle="Introduction"
        onBack={viewer.handleBack}
      />
    );
  }
  return null;
}

const COURSE_EYEBROW = 'Aptitude Program';
const COURSE_TITLE = 'The Course';

interface StagePanelProps {
  selectedStage: number;
  selectedStageData: Stage | undefined;
  stageContent: ReturnType<typeof useStageContent>;
  viewer: ReturnType<typeof useCourseViewer>;
  readNext: ReadNextProps;
}

/** The selected stage's cover, metadata, progress, and intro — the pinned
 *  header that rides atop the shared chapter-list scroll surface. */
const StageHeader = ({
  selectedStage,
  selectedStageData,
  stageContent,
  viewer,
  readNext,
}: StagePanelProps): React.JSX.Element => (
  <>
    {selectedStageData && (
      <StageCover
        stage={selectedStageData}
        progress={stageContent.progress}
        spiralColor={selectedStageData.spiral_dynamics_color}
      />
    )}
    <SiteResourcesPanel onSelect={viewer.handleResourcePress} />
    {selectedStageData && <StageMetadata stage={selectedStageData} />}
    <CourseProgressBar
      progress={stageContent.progress}
      spiralColor={selectedStageData?.spiral_dynamics_color}
      error={stageContent.error}
    />
    <View style={styles.introBand}>
      <EditorialSection title="Start here">
        <StageIntroCard stageNumber={selectedStage} onOpen={viewer.handleIntroPress} />
      </EditorialSection>
    </View>
    <ReadNextButton state={readNext.state} onOpen={readNext.onOpen} />
    <View style={styles.sectionBand}>
      <Text style={styles.sectionBandLabel}>Chapters</Text>
    </View>
  </>
);

/** The selected stage's cover, metadata, progress, intro, and chapter list,
 *  all hosted in one FlatList so the landing page scrolls as a single surface. */
const StagePanel = ({
  selectedStage,
  selectedStageData,
  stageContent,
  viewer,
  readNext,
}: StagePanelProps): React.JSX.Element => {
  // While loading or after a failed fetch the list is empty so the header stays
  // pinned and the loading/error state renders in ListEmptyComponent.
  const items =
    stageContent.loadingContent || stageContent.error ? EMPTY_CONTENT : stageContent.content;

  // The header is inlined rather than memoized: stageContent and viewer are
  // fresh object literals every render, so a useMemo keyed on them never hit
  // its cache and only added indirection.
  return (
    <ContentArea
      content={items}
      loadingContent={stageContent.loadingContent}
      error={stageContent.error}
      header={
        <StageHeader
          selectedStage={selectedStage}
          selectedStageData={selectedStageData}
          stageContent={stageContent}
          viewer={viewer}
          readNext={readNext}
        />
      }
      onContentPress={viewer.handleContentPress}
      onRetry={stageContent.retry}
    />
  );
};

interface CourseScreenDrawerProps {
  drawer: ScreenDrawerState;
  stages: Stage[];
  selectedStage: number;
  onChapterPress: (_stageNumber: number, _item: ContentItem) => void;
}

/** The Course header drawer: a stage-grouped table of contents whose chapter
 *  content loads lazily above the panel so the cache survives close/reopen. */
const CourseScreenDrawer = ({
  drawer,
  stages,
  selectedStage,
  onChapterPress,
}: CourseScreenDrawerProps): React.JSX.Element => {
  const { sections, retry } = useCourseDrawerContent(stages, drawer.isOpen);
  const { bodies, status, confirmBodySearch } = useCourseDrawerBodies(sections);
  return (
    <ScreenDrawer visible={drawer.isOpen} onClose={drawer.close} screenName="Course" title="Course">
      <DrawerNavSection currentScreen="Course" onNavigate={drawer.close} />
      <CourseDrawer
        stages={stages}
        selectedStage={selectedStage}
        sections={sections}
        bodies={bodies}
        sweepStatus={status}
        onChapterPress={onChapterPress}
        onRetry={retry}
        onConfirmBodySearch={confirmBodySearch}
      />
    </ScreenDrawer>
  );
};

/** Stage-selector and drawer navigation callbacks. A drawer chapter tap switches
 *  to that chapter's stage, opens the reader through ``handleContentPress`` (which
 *  guards locked items), then closes the drawer. */
function useCourseNavigation(
  setSelectedStage: (_stageNumber: number) => void,
  viewer: ReturnType<typeof useCourseViewer>,
  drawer: ScreenDrawerState,
) {
  const handleStageSelect = useCallback(
    (stageNumber: number) => setSelectedStage(stageNumber),
    [setSelectedStage],
  );

  const handleChapterPress = useCallback(
    (stageNumber: number, item: ContentItem) => {
      setSelectedStage(stageNumber);
      viewer.handleContentPress(item);
      drawer.close();
    },
    [setSelectedStage, viewer, drawer],
  );

  return { handleStageSelect, handleChapterPress };
}

interface CourseLandingProps {
  allStages: Stage[];
  selectedStage: number;
  stageContent: ReturnType<typeof useStageContent>;
  viewer: ReturnType<typeof useCourseViewer>;
  drawer: ScreenDrawerState;
  readNext: ReadNextProps;
  onStageSelect: (_stageNumber: number) => void;
  onChapterPress: (_stageNumber: number, _item: ContentItem) => void;
}

/** The Course landing view: header, stage selector, the stage-panel scroll
 *  surface, and the shelf drawer mounted over it. */
const CourseLanding = ({
  allStages,
  selectedStage,
  stageContent,
  viewer,
  drawer,
  readNext,
  onStageSelect,
  onChapterPress,
}: CourseLandingProps): React.JSX.Element => {
  const selectedStageData = allStages.find((s) => s.stage_number === selectedStage);
  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ContentContainer fill>
        <View style={styles.headerBand}>
          <ScreenHeader eyebrow={COURSE_EYEBROW} title={COURSE_TITLE} />
        </View>
        <StageSelector
          stages={allStages}
          selectedStage={selectedStage}
          onSelectStage={onStageSelect}
        />
        <StagePanel
          selectedStage={selectedStage}
          selectedStageData={selectedStageData}
          stageContent={stageContent}
          viewer={viewer}
          readNext={readNext}
        />
        <BottomFade />
        <CourseScreenDrawer
          drawer={drawer}
          stages={allStages}
          selectedStage={selectedStage}
          onChapterPress={onChapterPress}
        />
      </ContentContainer>
    </SafeAreaView>
  );
};

const CourseScreen = (): React.JSX.Element => {
  const { allStages, selectedStage, setSelectedStage, loading, error, retry } = useStagesLoader();
  const stageContent = useStageContent(selectedStage, allStages.length > 0);
  const viewer = useCourseViewer(selectedStage);
  const { readNext, onMarkRead } = useCourseReadingPosition(stageContent, viewer, setSelectedStage);
  const drawer = useScreenDrawer('Course');
  const { handleStageSelect, handleChapterPress } = useCourseNavigation(
    setSelectedStage,
    viewer,
    drawer,
  );

  const overlay = renderOverlay(viewer, onMarkRead, stageContent.content);
  if (overlay !== null) {
    // Drawer must mount alongside the reader so the hamburger works while reading.
    return (
      <>
        {overlay}
        <CourseScreenDrawer
          drawer={drawer}
          stages={allStages}
          selectedStage={selectedStage}
          onChapterPress={handleChapterPress}
        />
      </>
    );
  }

  if (loading) return <CourseLoadingState onRetry={retry} />;

  // Stage-list fetch failed: show error+retry, not an empty course.
  if (error) {
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <CourseErrorState onRetry={retry} />
      </SafeAreaView>
    );
  }

  return (
    <CourseLanding
      allStages={allStages}
      selectedStage={selectedStage}
      stageContent={stageContent}
      viewer={viewer}
      drawer={drawer}
      readNext={readNext}
      onStageSelect={handleStageSelect}
      onChapterPress={handleChapterPress}
    />
  );
};

export default CourseScreen;
