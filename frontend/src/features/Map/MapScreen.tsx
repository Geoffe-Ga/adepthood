// frontend/features/Map/MapScreen.tsx

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ImageBackground,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

import { MAP_BACKGROUND_URI } from '../../constants/images';
import { useAppNavigation } from '../../navigation/hooks';
import { useStageStore } from '../../store/useStageStore';

import styles from './Map.styles';
import type { StageData } from './stageData';

const FULL_PROGRESS = 1;

/**
 * Displays the ten APTITUDE stages over a background image.
 * Fetches real stage data from the API and shows rich metadata
 * in the detail modal with quick links to Practice, Course, and Journal.
 */
const MapScreen = (): React.JSX.Element => {
  const navigation = useAppNavigation();
  const { stages, loading, error, fetchStages, currentStage } = useStageStore();
  const [activeStage, setActiveStage] = useState<StageData | null>(null);
  const { width, height } = useWindowDimensions();
  const [aspectRatio, setAspectRatio] = useState(1);

  useEffect(() => {
    Image.getSize(MAP_BACKGROUND_URI, (w, h) => setAspectRatio(w / h));
  }, []);

  useEffect(() => {
    if (stages.length === 0 && !loading) {
      void fetchStages();
    }
  }, [stages.length, loading, fetchStages]);

  const isPortrait = height >= width;
  const backgroundStyle = isPortrait
    ? { width, height: width / aspectRatio }
    : { height, width: height * aspectRatio };

  const handleNavigate = useCallback(
    (screen: 'Practice' | 'Course' | 'Journal', stage: StageData) => {
      setActiveStage(null);
      if (screen === 'Journal') {
        navigation.navigate('Journal', { stageReflection: true, stageNumber: stage.stageNumber });
      } else {
        navigation.navigate(screen, { stageNumber: stage.stageNumber });
      }
    },
    [navigation],
  );

  const getHotspotStyle = (stage: StageData) => {
    if (!stage.isUnlocked) return styles.hotspotLocked;
    if (stage.stageNumber === currentStage) return styles.hotspotCurrent;
    if (stage.progress >= FULL_PROGRESS) return styles.hotspotCompleted;
    return null;
  };

  if (loading && stages.length === 0) {
    return (
      <View style={styles.centered} testID="map-loading">
        <ActivityIndicator size="large" color="#fff" />
        <Text style={styles.loadingText}>Loading stages...</Text>
      </View>
    );
  }

  if (error && stages.length === 0) {
    return (
      <View style={styles.centered} testID="map-error">
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ImageBackground
        source={{ uri: MAP_BACKGROUND_URI }}
        style={backgroundStyle}
        resizeMode="contain"
        testID="map-background"
      >
        {/* Connection lines between stages */}
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

        {/* Stage hotspots */}
        {stages.flatMap((stage) =>
          stage.hotspots.map((hs, index) => (
            <TouchableOpacity
              key={`${stage.id}-${index}`}
              testID={`stage-hotspot-${stage.stageNumber}-${index}`}
              style={[
                styles.hotspot,
                {
                  top: `${hs.top}%`,
                  left: `${hs.left}%`,
                  width: `${hs.width}%`,
                  height: `${hs.height}%`,
                },
                getHotspotStyle(stage),
              ]}
              onPress={() => setActiveStage(stage)}
              accessibilityLabel={`${stage.title} - ${stage.subtitle}`}
              accessibilityRole="button"
            >
              {!stage.isUnlocked && (
                <View style={styles.lockOverlay}>
                  <Text style={styles.lockText}>🔒</Text>
                </View>
              )}
              {stage.progress >= FULL_PROGRESS && index === 0 && (
                <View style={styles.completedBadge} testID={`stage-complete-${stage.stageNumber}`}>
                  <Text style={styles.completedBadgeText}>✓</Text>
                </View>
              )}
            </TouchableOpacity>
          )),
        )}
      </ImageBackground>

      {/* Stage detail modal */}
      <Modal
        visible={!!activeStage}
        transparent
        animationType="slide"
        onRequestClose={() => setActiveStage(null)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setActiveStage(null)}
          testID="modal-overlay"
        >
          <Pressable style={styles.modalContent} onPress={() => {}} testID="stage-modal">
            {activeStage && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <TouchableOpacity
                  testID="close-modal"
                  style={styles.closeButton}
                  onPress={() => setActiveStage(null)}
                >
                  <Text style={styles.closeText}>×</Text>
                </TouchableOpacity>

                {/* Title with color indicator */}
                <View style={styles.titleRow}>
                  <View style={[styles.colorDot, { backgroundColor: activeStage.color }]} />
                  <Text style={styles.modalTitle}>{activeStage.title}</Text>
                </View>
                <Text style={styles.modalSubtitle}>{activeStage.subtitle}</Text>

                {/* Progress */}
                <View style={styles.progressContainer}>
                  <Text style={styles.progressLabel}>
                    Progress: {Math.round(activeStage.progress * 100)}%
                  </Text>
                  <View style={styles.progressBar}>
                    <View
                      style={[
                        styles.progressFill,
                        {
                          width: `${activeStage.progress * 100}%`,
                          backgroundColor: activeStage.color,
                        },
                      ]}
                      testID="progress-fill"
                    />
                  </View>
                </View>

                {/* Rich metadata */}
                <View style={styles.metadataSection} testID="stage-metadata">
                  <View style={styles.metadataRow}>
                    <Text style={styles.metadataLabel}>Category</Text>
                    <Text style={styles.metadataValue}>{activeStage.category}</Text>
                  </View>
                  <View style={styles.metadataRow}>
                    <Text style={styles.metadataLabel}>Aspect</Text>
                    <Text style={styles.metadataValue}>{activeStage.aspect}</Text>
                  </View>
                  <View style={styles.metadataRow}>
                    <Text style={styles.metadataLabel}>Growing Up</Text>
                    <Text style={styles.metadataValue}>{activeStage.growingUpStage}</Text>
                  </View>
                  <View style={styles.metadataRow}>
                    <Text style={styles.metadataLabel}>Polarity</Text>
                    <Text style={styles.metadataValue}>{activeStage.divineGenderPolarity}</Text>
                  </View>
                  <View style={styles.metadataRow}>
                    <Text style={styles.metadataLabel}>Free Will</Text>
                    <Text style={styles.metadataValue}>{activeStage.relationshipToFreeWill}</Text>
                  </View>
                  {activeStage.freeWillDescription ? (
                    <Text style={styles.freeWillDescription}>
                      {activeStage.freeWillDescription}
                    </Text>
                  ) : null}
                </View>

                <View style={styles.separator} />

                {/* Quick action links */}
                <View style={styles.actions}>
                  <TouchableOpacity
                    testID="practice-link"
                    style={styles.actionButton}
                    onPress={() => handleNavigate('Practice', activeStage)}
                  >
                    <Text style={styles.actionText}>Practice</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID="course-link"
                    style={styles.actionButton}
                    onPress={() => handleNavigate('Course', activeStage)}
                  >
                    <Text style={styles.actionText}>Course</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID="journal-link"
                    style={styles.actionButton}
                    onPress={() => handleNavigate('Journal', activeStage)}
                  >
                    <Text style={styles.actionText}>Journal</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
};

export default MapScreen;
