import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  course as courseApi,
  stages as stagesApi,
  type ContentItem,
  type CourseProgress,
  type SiteResource,
  type Stage,
} from '../../api';
import { STAGE_COLORS, colors } from '../../design/tokens';
import { useAppNavigation, useAppRoute } from '../../navigation/hooks';
import { useProgramStore, programStage } from '../../store/useProgramStore';
import { deriveCurrentStage } from '../Map/services/stageService';

import ChapterReader from './ChapterReader';
import ContentCard from './ContentCard';
import ContentViewer from './ContentViewer';
import styles from './Course.styles';
import SiteResourcesPanel from './SiteResourcesPanel';
import StageSelector from './StageSelector';

const DEFAULT_STAGE_NUMBER = 1;

// --- Hook: load stages on mount ---

function useStagesLoader() {
  const route = useAppRoute<'Course'>();
  const routeStageNumber = route.params?.stageNumber ?? null;
  const programAnchor = useProgramStore((s) => s.programStartDate);

  const [allStages, setAllStages] = useState<Stage[]>([]);
  const [selectedStage, setSelectedStage] = useState(routeStageNumber ?? DEFAULT_STAGE_NUMBER);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
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
        console.error('Failed to load stages:', err);
      } finally {
        setLoading(false);
      }
    };
    void init();
  }, [routeStageNumber, programAnchor]);

  return { allStages, selectedStage, setSelectedStage, loading };
}

// --- Hook: load content for selected stage ---

function useStageContent(selectedStage: number, stagesLoaded: boolean) {
  const [content, setContent] = useState<ContentItem[]>([]);
  const [progress, setProgress] = useState<CourseProgress | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  const refreshContent = useCallback(async () => {
    setLoadingContent(true);
    try {
      const [contentResult, progressResult] = await Promise.all([
        courseApi.stageContentAll(selectedStage),
        courseApi.stageProgress(selectedStage),
      ]);
      setContent(contentResult);
      setProgress(progressResult);
    } catch (err) {
      console.error('Failed to load stage content:', err);
      setContent([]);
      setProgress(null);
    } finally {
      setLoadingContent(false);
    }
  }, [selectedStage]);

  useEffect(() => {
    if (!stagesLoaded) return;
    void refreshContent();
  }, [stagesLoaded, refreshContent]);

  const handleMarkRead = useCallback(() => {
    void refreshContent();
  }, [refreshContent]);

  return { content, progress, loadingContent, handleMarkRead };
}

// --- Sub-components ---

const StageMetadata = ({ stage }: { stage: Stage }): React.JSX.Element => (
  <View style={styles.stageMetadata} testID="stage-metadata">
    <Text style={styles.stageTitle}>{stage.title}</Text>
    <Text style={styles.stageSubtitle}>{stage.subtitle}</Text>
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
}

const CourseProgressBar = ({ progress, spiralColor }: ProgressBarProps): React.JSX.Element => {
  const progressPercent = progress ? progress.progress_percent : 0;
  const barColor = spiralColor ? STAGE_COLORS[spiralColor] ?? colors.neutral : colors.neutral;

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
      <Text style={styles.progressBarLabel}>
        {progress ? `${progress.read_items}/${progress.total_items} completed` : 'Loading...'}
      </Text>
    </View>
  );
};

const CourseEmptyState = (): React.JSX.Element => (
  <View style={styles.emptyContainer}>
    <Text style={styles.emptyIcon}>{'📚'}</Text>
    <Text style={styles.emptyTitle}>No Content Yet</Text>
    <Text style={styles.emptySubtitle}>
      Content for this stage has not been added yet. Check back soon.
    </Text>
  </View>
);

const CourseLoadingState = (): React.JSX.Element => (
  <SafeAreaView style={styles.container}>
    <View style={styles.loadingContainer}>
      <ActivityIndicator testID="course-loading" size="large" />
    </View>
  </SafeAreaView>
);

interface ContentAreaProps {
  content: ContentItem[];
  loadingContent: boolean;
  onContentPress: (_item: ContentItem) => void;
}

const ContentArea = ({
  content,
  loadingContent,
  onContentPress,
}: ContentAreaProps): React.JSX.Element => {
  const renderContentItem = useCallback(
    ({ item }: { item: ContentItem }) => <ContentCard item={item} onPress={onContentPress} />,
    [onContentPress],
  );

  const renderEmpty = useCallback(() => {
    if (loadingContent) return null;
    return <CourseEmptyState />;
  }, [loadingContent]);

  if (loadingContent) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator testID="content-loading" size="small" />
      </View>
    );
  }

  return (
    <FlatList
      testID="content-list"
      style={styles.contentList}
      data={content}
      renderItem={renderContentItem}
      keyExtractor={(item) => String(item.id)}
      ListEmptyComponent={renderEmpty}
    />
  );
};

// --- Hook: viewer actions ---

function useCourseViewer(selectedStage: number) {
  const navigation = useAppNavigation();
  const [viewingItem, setViewingItem] = useState<ContentItem | null>(null);
  const [viewingResource, setViewingResource] = useState<SiteResource | null>(null);

  const handleContentPress = useCallback((item: ContentItem) => {
    if (!item.is_locked) setViewingItem(item);
  }, []);

  const handleResourcePress = useCallback((resource: SiteResource) => {
    setViewingResource(resource);
  }, []);

  const handleBack = useCallback(() => {
    setViewingItem(null);
    setViewingResource(null);
  }, []);

  const handleReflect = useCallback(() => {
    if (!viewingItem) return;
    navigation.navigate('Journal', {
      tag: 'stage_reflection',
      stageNumber: selectedStage,
      contentTitle: viewingItem.title,
    });
    setViewingItem(null);
  }, [viewingItem, selectedStage, navigation]);

  return {
    viewingItem,
    setViewingItem,
    viewingResource,
    setViewingResource,
    handleContentPress,
    handleResourcePress,
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
  return null;
}

const CourseScreen = (): React.JSX.Element => {
  const { allStages, selectedStage, setSelectedStage, loading } = useStagesLoader();
  const stageContent = useStageContent(selectedStage, allStages.length > 0);
  const viewer = useCourseViewer(selectedStage);

  const handleStageSelect = useCallback(
    (stageNumber: number) => {
      setSelectedStage(stageNumber);
      viewer.setViewingItem(null);
    },
    [setSelectedStage, viewer],
  );

  const overlay = renderOverlay(viewer, stageContent.handleMarkRead);
  if (overlay !== null) return overlay;

  if (loading) return <CourseLoadingState />;

  const selectedStageData = allStages.find((s) => s.stage_number === selectedStage);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <StageSelector
        stages={allStages}
        selectedStage={selectedStage}
        onSelectStage={handleStageSelect}
      />
      <SiteResourcesPanel onSelect={viewer.handleResourcePress} />
      {selectedStageData && <StageMetadata stage={selectedStageData} />}
      <CourseProgressBar
        progress={stageContent.progress}
        spiralColor={selectedStageData?.spiral_dynamics_color}
      />
      <ContentArea
        content={stageContent.content}
        loadingContent={stageContent.loadingContent}
        onContentPress={viewer.handleContentPress}
      />
    </SafeAreaView>
  );
};

export default CourseScreen;
