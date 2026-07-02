import React from 'react';
import { Modal, Pressable, ScrollView, Text } from 'react-native';
import Markdown from 'react-native-markdown-display';

import { markdownStyles } from '../Course/Course.styles';

import styles from './Map.styles';
import TorusSpiralVisual from './TorusSpiralVisual';
import { WAVELENGTH_EXPLAINER } from './wavelengthExplainerContent';

interface WavelengthExplainerProps {
  visible: boolean;
  onClose: () => void;
}

/** The explainer's inner sheet: title, close affordance, and the model copy. */
const ExplainerSheet = ({ onClose }: { onClose: () => void }): React.JSX.Element => (
  <Pressable style={styles.explainerSheet} onPress={() => {}} testID="wavelength-explainer-sheet">
    <Pressable
      testID="wavelength-explainer-close"
      style={styles.explainerClose}
      onPress={onClose}
      accessibilityRole="button"
      accessibilityLabel="Close"
    >
      <Text style={styles.explainerCloseText}>×</Text>
    </Pressable>
    <ScrollView
      testID="wavelength-explainer"
      contentContainerStyle={styles.explainerScroll}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.explainerTitle}>{WAVELENGTH_EXPLAINER.title}</Text>
      <TorusSpiralVisual />
      <Markdown style={markdownStyles}>{WAVELENGTH_EXPLAINER.markdown}</Markdown>
    </ScrollView>
  </Pressable>
);

/** Opt-in, declinable "How the Wavelength works" explainer — never auto-shown, never ranking. */
export default function WavelengthExplainer({
  visible,
  onClose,
}: WavelengthExplainerProps): React.JSX.Element {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={styles.modalOverlay}
        onPress={onClose}
        testID="wavelength-explainer-overlay"
      >
        {visible ? <ExplainerSheet onClose={onClose} /> : null}
      </Pressable>
    </Modal>
  );
}
