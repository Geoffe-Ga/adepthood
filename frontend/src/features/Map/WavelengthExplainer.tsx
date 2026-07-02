import React from 'react';
import { Modal, View } from 'react-native';

import ChapterReader, { type ChapterReaderSource } from '../Course/ChapterReader';

import styles from './Map.styles';

/** Manifest slug of the vendored "How the Wavelength works" site resource. */
const WAVELENGTH_EXPLAINER_SLUG = 'wavelength-explainer';

/** Header title shown until the live title from the manifest arrives. */
const WAVELENGTH_EXPLAINER_TITLE = 'How the Wavelength works';

/**
 * Stable source descriptor so the reader's fetch effect keys on one identity
 * and never re-fetches on re-render.
 */
const EXPLAINER_SOURCE: ChapterReaderSource = {
  kind: 'resource',
  slug: WAVELENGTH_EXPLAINER_SLUG,
};

interface WavelengthExplainerProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * Opt-in, declinable "How the Wavelength works" explainer — never auto-shown,
 * never ranking. The copy is served from the vendored content pipeline through
 * the shared {@link ChapterReader} (its back control doubles as the close
 * affordance) so the explainer stays in sync with the canonical site resource
 * rather than a frontend-local copy.
 */
export default function WavelengthExplainer({
  visible,
  onClose,
}: WavelengthExplainerProps): React.JSX.Element {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {visible ? (
        <View style={styles.explainerModalRoot} testID="wavelength-explainer">
          <ChapterReader
            source={EXPLAINER_SOURCE}
            fallbackTitle={WAVELENGTH_EXPLAINER_TITLE}
            onBack={onClose}
          />
        </View>
      ) : null}
    </Modal>
  );
}
