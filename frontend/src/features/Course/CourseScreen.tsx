import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  course as courseApi,
  stages as stagesApi,
  type ContentItem,
  type CourseProgress,
  type SiteResource,
  type Stage,
} from '../../api';
import {
  DrawerNavSection,
  ScreenDrawer,
  useScreenDrawer,
  type ScreenDrawerState,
} from '../../components/drawer';
import { Celebration } from '../../components/feedback/Celebration';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ContentContainer } from '../../components/layout/ContentContainer';
import { EditorialSection } from '../../components/layout/EditorialSection';
import { ScreenHeader } from '../../components/layout/ScreenHeader';
import { ShowcaseCard } from '../../components/layout/ShowcaseCard';
import { resolveStageColor } from '../../design/tokens';
import { deriveCurrentStage } from '../../domain/stageProgression';
import { useAppRoute } from '../../navigation/hooks';
import type { RootStackParamList } from '../../navigation/RootStack';
import { useProgramStore, programStage } from '../../store/useProgramStore';

import ChapterReader from './ChapterReader';
import ContentCard from './ContentCard';
import ContentViewer from './ContentViewer';
import styles from './Course.styles';
import CourseDrawer, { useCourseDrawerContent } from './CourseDrawer';
import SiteResourcesPanel from './SiteResourcesPanel';
import StageIntroCard from './StageIntroCard';
import StageSelector from './StageSelector';

const DEFAULT_STAGE_NUMBER = 1;

// Stable empty reference so the FlatList shows ListEmptyComponent while a stage
// is loading or after a failed fetch, without churning the data prop's identity.
const EMPTY_CONTENT: ContentItem[] = [];

// --- Hook: load stages on mount ---

function useStagesLoader() {
  const route = useAppRoute<'Course'>();
  const routeStageNumber = route.params?.stageNumber ?? null;
  const programAnchor = useProgramStore((s) => s.programStartDate);

  const [allStages, setAllStages] = useState<Stage[]>([]);
  const [selectedStage, setSelectedStage] = useState(routeStageNumber ?? DEFAULT_STAGE_NUMBER);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const init = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const stagesList = await stagesApi.listAll();
      setAllStages(stagesList);
      if (routeStageNumber === null) {
        // Master date wins when the user has picked an anchor; otherwise
        // fall back to the server-owned, count-based progression
        // (``completed_count + 1``) — "max unlocked" would visually
        // reward skip-ahead attempts whenever ``is_unlocked`` ran
        // ahead of completion.
        const dateDerived = programStage(programAnchor);
        setSelectedStage(dateDerived ?? deriveCurrentStage(stagesList));
      }
    } catch (err) {
      // Track failure explicitly so the screen can show error+retry instead of
      // an empty course (audit-ux-04).
      console.error('Failed to load stages:', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [routeStageNumber, programAnchor]);

  useEffect(() => {
    void init();
  }, [init]);

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

const CourseErrorState = ({ onRetry }: { onRetry: () => void }): React.JSX.Element => (
  <View style={styles.emptyContainer} testID="course-error">
    <Text style={styles.emptyIcon}>{'⚠️'}</Text>
    <Text style={styles.emptyTitle}>Couldn&apos;t load the course</Text>
    <Text style={styles.emptySubtitle}>
      Something went wrong loading this stage. Check your connection and try again.
    </Text>
    <TouchableOpacity
      onPress={onRetry}
      accessibilityRole="button"
      accessibilityLabel="Try again"
      style={styles.retryButton}
      testID="course-retry"
    >
      <Text style={styles.retryText}>Try again</Text>
    </TouchableOpacity>
  </View>
);

const CourseLoadingState = (): React.JSX.Element => (
  <SafeAreaView style={styles.container}>
    <View style={styles.loadingContainer}>
      <ActivityIndicator testID="course-loading" size="large" />
    </View>
  </SafeAreaView>
);

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

function useCourseViewer(selectedStage: number) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [viewingItem, setViewingItem] = useState<ContentItem | null>(null);
  const [viewingResource, setViewingResource] = useState<SiteResource | null>(null);
  const [viewingIntro, setViewingIntro] = useState<number | null>(null);

  const handleContentPress = useCallback((item: ContentItem) => {
    if (!item.is_locked) setViewingItem(item);
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
  }, []);

  const handleReflect = useCallback(() => {
    if (!viewingItem) return;
    navigation.navigate('JournalEntry', {
      prefillTitle: `Stage ${selectedStage} reflection — ${viewingItem.title}`,
    });
    setViewingItem(null);
  }, [viewingItem, selectedStage, navigation]);

  return {
    viewingItem,
    setViewingItem,
    viewingResource,
    setViewingResource,
    viewingIntro,
    handleContentPress,
    handleResourcePress,
    handleIntroPress,
    handleBack,
    handleReflect,
  };
}

// --- Main component ---

function renderOverlay(
  viewer: ReturnType<typeof useCourseViewer>,
  onMarkRead: () => void,
): React.JSX.Element | null {
  if (viewer.viewingItem) {
    return (
      <ContentViewer
        item={viewer.viewingItem}
        onBack={viewer.handleBack}
        onMarkRead={onMarkRead}
        onReflect={viewer.handleReflect}
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
}

/** The selected stage's cover, metadata, progress, and intro — the pinned
 *  header that rides atop the shared chapter-list scroll surface. */
const StageHeader = ({
  selectedStage,
  selectedStageData,
  stageContent,
  viewer,
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
    <EditorialSection title="Start here">
      <StageIntroCard stageNumber={selectedStage} onOpen={viewer.handleIntroPress} />
    </EditorialSection>
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
}: StagePanelProps): React.JSX.Element => {
  const header = useMemo(
    () => (
      <StageHeader
        selectedStage={selectedStage}
        selectedStageData={selectedStageData}
        stageContent={stageContent}
        viewer={viewer}
      />
    ),
    [selectedStage, selectedStageData, stageContent, viewer],
  );

  // While loading or after a failed fetch the list is empty so the header stays
  // pinned and the loading/error state renders in ListEmptyComponent.
  const items =
    stageContent.loadingContent || stageContent.error ? EMPTY_CONTENT : stageContent.content;

  return (
    <ContentArea
      content={items}
      loadingContent={stageContent.loadingContent}
      error={stageContent.error}
      header={header}
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
  return (
    <ScreenDrawer visible={drawer.isOpen} onClose={drawer.close} screenName="Course" title="Course">
      <DrawerNavSection currentScreen="Course" onNavigate={drawer.close} />
      <CourseDrawer
        stages={stages}
        selectedStage={selectedStage}
        sections={sections}
        onChapterPress={onChapterPress}
        onRetry={retry}
      />
    </ScreenDrawer>
  );
};

/** Stage-selector and drawer navigation callbacks. A drawer chapter tap switches
 *  to that chapter's stage, opens the reader (``handleContentPress`` already
 *  guards locked items — never a raw ``setViewingItem`` that would bypass the
 *  lock check), then closes the drawer. */
function useCourseNavigation(
  setSelectedStage: (_stageNumber: number) => void,
  viewer: ReturnType<typeof useCourseViewer>,
  drawer: ScreenDrawerState,
) {
  const handleStageSelect = useCallback(
    (stageNumber: number) => {
      setSelectedStage(stageNumber);
      viewer.setViewingItem(null);
    },
    [setSelectedStage, viewer],
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

const CourseScreen = (): React.JSX.Element => {
  const { allStages, selectedStage, setSelectedStage, loading, error, retry } = useStagesLoader();
  const stageContent = useStageContent(selectedStage, allStages.length > 0);
  const viewer = useCourseViewer(selectedStage);
  const drawer = useScreenDrawer('Course');
  const { handleStageSelect, handleChapterPress } = useCourseNavigation(
    setSelectedStage,
    viewer,
    drawer,
  );

  const overlay = renderOverlay(viewer, stageContent.handleMarkRead);
  if (overlay !== null) return overlay;

  if (loading) return <CourseLoadingState />;

  // Stage-list fetch failed: show error+retry, not an empty course.
  if (error) {
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <CourseErrorState onRetry={retry} />
      </SafeAreaView>
    );
  }

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
          onSelectStage={handleStageSelect}
        />
        <StagePanel
          selectedStage={selectedStage}
          selectedStageData={selectedStageData}
          stageContent={stageContent}
          viewer={viewer}
        />
        <CourseScreenDrawer
          drawer={drawer}
          stages={allStages}
          selectedStage={selectedStage}
          onChapterPress={handleChapterPress}
        />
      </ContentContainer>
    </SafeAreaView>
  );
};

export default CourseScreen;
