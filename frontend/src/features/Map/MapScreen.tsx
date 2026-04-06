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
  if (!stage.isUnlocked) return styles.hotspotLocked;
  if (stage.stageNumber === currentStage) return styles.hotspotCurrent;
  if (stage.progress >= FULL_PROGRESS) return styles.hotspotCompleted;
  return null;
};

interface StageHotspotsProps {
  stages: StageData[];
  currentStage: number | null;
  onPress: (_stage: StageData) => void;
}

const StageHotspots = ({
  stages,
  currentStage,
  onPress,
}: StageHotspotsProps): React.JSX.Element => (
  <>
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
            getHotspotStyle(stage, currentStage),
          ]}
          onPress={() => onPress(stage)}
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
  </>
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
    <ActivityIndicator size="large" color="#fff" />
    <Text style={styles.loadingText}>Loading stages...</Text>
  </View>
);

const MapError = ({ message }: { message: string }): React.JSX.Element => (
  <View style={styles.centered} testID="map-error">
    <Text style={styles.errorText}>{message}</Text>
  </View>
);

function useBackgroundSize() {
  const { width, height } = useWindowDimensions();
  const [aspectRatio, setAspectRatio] = useState(1);

  useEffect(() => {
    Image.getSize(MAP_BACKGROUND_URI, (w, h) => setAspectRatio(w / h));
  }, []);

  const isPortrait = height >= width;
  return isPortrait
    ? { width, height: width / aspectRatio }
    : { height, width: height * aspectRatio };
}

interface MapBackgroundProps {
  stages: StageData[];
  currentStage: number | null;
  onSelectStage: (_stage: StageData) => void;
}

const MapBackground = ({
  stages,
  currentStage,
  onSelectStage,
}: MapBackgroundProps): React.JSX.Element => {
  const backgroundStyle = useBackgroundSize();

  return (
    <ImageBackground
      source={{ uri: MAP_BACKGROUND_URI }}
      style={backgroundStyle}
      resizeMode="contain"
      testID="map-background"
    >
      <ConnectionLines stages={stages} />
      <StageHotspots stages={stages} currentStage={currentStage} onPress={onSelectStage} />
    </ImageBackground>
  );
};

// --- Main component ---

const MapScreen = (): React.JSX.Element => {
  const navigation = useAppNavigation();
  const { stages, loading, error, fetchStages, currentStage } = useStageStore();
  const [activeStage, setActiveStage] = useState<StageData | null>(null);

  useEffect(() => {
    if (stages.length === 0 && !loading) {
      void fetchStages();
    }
  }, [stages.length, loading, fetchStages]);

  const handleNavigate = useCallback(
    (screen: 'Practice' | 'Course' | 'Journal', stage: StageData) => {
      setActiveStage(null);
      if (screen === 'Journal') {
        navigation.navigate('Journal', { tag: 'stage_reflection', stageNumber: stage.stageNumber });
      } else {
        navigation.navigate(screen, { stageNumber: stage.stageNumber });
      }
    },
    [navigation],
  );

  const handleCloseModal = useCallback(() => setActiveStage(null), []);

  if (loading && stages.length === 0) return <MapLoading />;
  if (error && stages.length === 0) return <MapError message={error} />;

  return (
    <View style={styles.container}>
      <MapBackground stages={stages} currentStage={currentStage} onSelectStage={setActiveStage} />
      <StageDetailModal
        activeStage={activeStage}
        onClose={handleCloseModal}
        onNavigate={handleNavigate}
      />
    </View>
  );
};

export default MapScreen;
