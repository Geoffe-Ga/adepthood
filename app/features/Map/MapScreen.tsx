// app/features/Map/MapScreen.tsx

import { useNavigation } from '@react-navigation/native';
import React, { useState } from 'react';
import { ImageBackground, Modal, Text, TouchableOpacity, View } from 'react-native';

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

  return (
    <View style={styles.container}>
      <ImageBackground
        source={{ uri: MAP_BACKGROUND_URI }}
        style={styles.background}
        testID="map-background"
      >
        {STAGES.map((stage) => (
          <TouchableOpacity
            key={stage.id}
            testID={`stage-hotspot-${stage.stageNumber}`}
            style={[
              styles.hotspot,
              { top: `${stage.position.top}%`, left: `${stage.position.left}%` },
            ]}
            onPress={() => setActiveStage(stage)}
          >
            <Text style={[styles.label, { color: stage.color }]}>{stage.title}</Text>
          </TouchableOpacity>
        ))}
      </ImageBackground>

      <Modal
        visible={!!activeStage}
        transparent
        animationType="fade"
        onRequestClose={() => setActiveStage(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent} testID="stage-modal">
            {activeStage && (
              <>
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
          </View>
        </View>
      </Modal>
    </View>
  );
};

export default MapScreen;
