// app/features/Map/MapScreen.tsx

import { useNavigation } from '@react-navigation/native';
import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';

import styles from './Map.styles';
import { STAGES } from './stageData';

/**
 * Displays the ten APTITUDE stages as a simple ladder.
 * Each card links out to the relevant course and practice areas.
 */
const MapScreen = (): React.JSX.Element => {
  const navigation = useNavigation();

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {STAGES.map((stage) => (
        <View key={stage.id} testID={`stage-card-${stage.stageNumber}`} style={styles.card}>
          <Text style={styles.title}>
            {stage.stageNumber}. {stage.title}
          </Text>
          <Text style={styles.subtitle}>{stage.subtitle}</Text>

          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${stage.progress * 100}%` }]} />
          </View>

          <Text style={styles.meta}>
            {stage.practices.length} practices • {stage.goals.length} goals
          </Text>

          <View style={styles.actions}>
            <TouchableOpacity
              testID={`practice-button-${stage.stageNumber}`}
              style={styles.actionButton}
              onPress={() => navigation.navigate('Practice' as never)}
            >
              <Text style={styles.actionText}>Practice</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID={`course-button-${stage.stageNumber}`}
              style={styles.actionButton}
              onPress={() => navigation.navigate('Course' as never)}
            >
              <Text style={styles.actionText}>Course</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
    </ScrollView>
  );
};

export default MapScreen;
