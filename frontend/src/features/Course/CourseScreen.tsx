import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  course as courseApi,
  stages as stagesApi,
  type ContentItem,
  type CourseProgress,
  type Stage,
} from '../../api';
import { STAGE_COLORS } from '../../design/tokens';

import ContentCard from './ContentCard';
import ContentViewer from './ContentViewer';
import styles from './Course.styles';
import StageSelector from './StageSelector';

const CourseScreen = (): React.JSX.Element => {
  const [allStages, setAllStages] = useState<Stage[]>([]);
  const [selectedStage, setSelectedStage] = useState(1);
  const [content, setContent] = useState<ContentItem[]>([]);
  const [progress, setProgress] = useState<CourseProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingContent, setLoadingContent] = useState(false);
  const [viewingItem, setViewingItem] = useState<ContentItem | null>(null);

  // Load all stages on mount
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      try {
        const stagesList = await stagesApi.list();
        setAllStages(stagesList);
        // Select user's current unlocked stage by default
        const currentUnlocked = stagesList
          .filter((s) => s.is_unlocked)
          .sort((a, b) => b.stage_number - a.stage_number);
        if (currentUnlocked.length > 0) {
          setSelectedStage(currentUnlocked[0]!.stage_number);
        }
      } catch (err) {
        console.error('Failed to load stages:', err);
      } finally {
        setLoading(false);
      }
    };
    void init();
  }, []);

  // Load content and progress when selected stage changes
  useEffect(() => {
    if (allStages.length === 0) return;

    const loadStageData = async () => {
      setLoadingContent(true);
      try {
        const [contentResult, progressResult] = await Promise.all([
          courseApi.stageContent(selectedStage),
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
    };
    void loadStageData();
  }, [selectedStage, allStages.length]);

  const handleStageSelect = useCallback((stageNumber: number) => {
    setSelectedStage(stageNumber);
    setViewingItem(null);
  }, []);

  const handleContentPress = useCallback((item: ContentItem) => {
    if (!item.is_locked) {
      setViewingItem(item);
    }
  }, []);

  const handleBackFromViewer = useCallback(() => {
    setViewingItem(null);
  }, []);

  const handleMarkRead = useCallback(() => {
    // Refresh content and progress after marking as read
    const refresh = async () => {
      try {
        const [contentResult, progressResult] = await Promise.all([
          courseApi.stageContent(selectedStage),
          courseApi.stageProgress(selectedStage),
        ]);
        setContent(contentResult);
        setProgress(progressResult);
      } catch {
        // Non-critical refresh failure
      }
    };
    void refresh();
  }, [selectedStage]);

  const selectedStageData = allStages.find((s) => s.stage_number === selectedStage);

  const renderContentItem = useCallback(
    ({ item }: { item: ContentItem }) => <ContentCard item={item} onPress={handleContentPress} />,
    [handleContentPress],
  );

  const renderEmpty = useCallback(() => {
    if (loadingContent) return null;
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyIcon}>{'📚'}</Text>
        <Text style={styles.emptyTitle}>No Content Yet</Text>
        <Text style={styles.emptySubtitle}>
          Content for this stage has not been added yet. Check back soon.
        </Text>
      </View>
    );
  }, [loadingContent]);

  // Show content viewer if viewing an item
  if (viewingItem) {
    return (
      <ContentViewer item={viewingItem} onBack={handleBackFromViewer} onMarkRead={handleMarkRead} />
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator testID="course-loading" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const progressPercent = progress ? progress.progress_percent : 0;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <StageSelector
        stages={allStages}
        selectedStage={selectedStage}
        onSelectStage={handleStageSelect}
      />

      {selectedStageData && (
        <View style={styles.stageMetadata} testID="stage-metadata">
          <Text style={styles.stageTitle}>{selectedStageData.title}</Text>
          <Text style={styles.stageSubtitle}>{selectedStageData.subtitle}</Text>
          <View style={styles.stageDetailRow}>
            <Text style={styles.stageDetailLabel}>Spiral Dynamics</Text>
            <Text style={styles.stageDetailValue}>{selectedStageData.spiral_dynamics_color}</Text>
          </View>
          <View style={styles.stageDetailRow}>
            <Text style={styles.stageDetailLabel}>Growing Up Stage</Text>
            <Text style={styles.stageDetailValue}>{selectedStageData.growing_up_stage}</Text>
          </View>
        </View>
      )}

      <View style={styles.progressBarContainer} testID="progress-bar">
        <View style={styles.progressBarTrack}>
          <View
            testID="progress-bar-fill"
            style={[
              styles.progressBarFill,
              {
                width: `${progressPercent}%`,
                backgroundColor: selectedStageData
                  ? STAGE_COLORS[selectedStageData.spiral_dynamics_color] ?? '#888'
                  : '#888',
              },
            ]}
          />
        </View>
        <Text style={styles.progressBarLabel}>
          {progress ? `${progress.read_items}/${progress.total_items} completed` : 'Loading...'}
        </Text>
      </View>

      {loadingContent ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator testID="content-loading" size="small" />
        </View>
      ) : (
        <FlatList
          testID="content-list"
          style={styles.contentList}
          data={content}
          renderItem={renderContentItem}
          keyExtractor={(item) => String(item.id)}
          ListEmptyComponent={renderEmpty}
        />
      )}
    </SafeAreaView>
  );
};

export default CourseScreen;
