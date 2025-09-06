// frontend/features/Map/MapScreen.tsx

import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import React, { useEffect, useState } from 'react';
import {
  Image,
  ImageBackground,
  Modal,
  Pressable,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MAP_BACKGROUND_URI } from '../../constants/images';

import styles from './Map.styles';
import { STAGES } from './stageData';
import type { StageData } from './stageData';

/**
 * Displays the ten APTITUDE stages over a background image.
 * Tapping a stage reveals a modal with quick links to Practice and Course.
 */
const MapScreen = (): React.JSX.Element => {
  const navigation = useNavigation();
  const [activeStage, setActiveStage] = useState<StageData | null>(null);
  const { width, height } = useWindowDimensions();
  const tabBarHeight = useBottomTabBarHeight();
  const insets = useSafeAreaInsets();
  const [aspectRatio, setAspectRatio] = useState(1);

  useEffect(() => {
    Image.getSize(MAP_BACKGROUND_URI, (w, h) => setAspectRatio(w / h));
  }, []);

  const isPortrait = height >= width;
  const availableHeight = height - tabBarHeight - insets.top;
  const backgroundStyle = isPortrait
    ? { width, height: width / aspectRatio }
    : { height: availableHeight, width: availableHeight * aspectRatio };

  return (
    <View style={styles.container}>
      <ImageBackground
        source={{ uri: MAP_BACKGROUND_URI }}
        style={backgroundStyle}
        resizeMode="contain"
        testID="map-background"
      >
        {STAGES.flatMap((stage) =>
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
              ]}
              onPress={() => setActiveStage(stage)}
            />
          )),
        )}
      </ImageBackground>

      <Modal
        visible={!!activeStage}
        transparent
        animationType="fade"
        onRequestClose={() => setActiveStage(null)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setActiveStage(null)}
          testID="modal-overlay"
        >
          <Pressable style={styles.modalContent} onPress={() => {}} testID="stage-modal">
            {activeStage && (
              <>
                <TouchableOpacity
                  testID="close-modal"
                  style={styles.closeButton}
                  onPress={() => setActiveStage(null)}
                >
                  <Text style={styles.closeText}>×</Text>
                </TouchableOpacity>
                <Text style={styles.modalTitle}>{activeStage.title}</Text>
                <Text style={styles.modalSubtitle}>{activeStage.subtitle}</Text>
                <View style={styles.progressBar}>
                  <View
                    style={[styles.progressFill, { width: `${activeStage.progress * 100}%` }]}
                  />
                </View>
                <View style={styles.actions}>
                  <TouchableOpacity
                    testID="practice-link"
                    style={styles.actionButton}
                    onPress={() => {
                      setActiveStage(null);
                      navigation.navigate('Practice' as never);
                    }}
                  >
                    <Text style={styles.actionText}>Practice</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID="course-link"
                    style={styles.actionButton}
                    onPress={() => {
                      setActiveStage(null);
                      navigation.navigate('Course' as never);
                    }}
                  >
                    <Text style={styles.actionText}>Course</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
};

export default MapScreen;
