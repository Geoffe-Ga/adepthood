/**
 * The privacy classification chooser for the photograph-capture flow, shown in
 * the collect stage BEFORE the Transcribe action. It reuses the writing editor's
 * {@link PrivacyTierControl} (no parallel control) with its built-in explainer
 * suppressed, and adds a transcription-specific intimate gate.
 *
 * PRIVACY: photo transcription is a cloud-LLM call carrying the page's content,
 * so the ratified intimate-never-cloud promise applies here as it does to
 * resonance. Choosing ``intimate`` reveals a calm, non-shaming gate: it explains
 * that transcription would hand the page to an outside AI and offers a typed
 * entry instead ("Type it instead") or a revert to a transcribable tier ("Keep
 * as Personal"). The host disables Transcribe while intimate is selected, so the
 * cloud call is structurally unreachable.
 */
import React from 'react';
import { Text, View } from 'react-native';

import styles from './JournalPhotograph.styles';
import PrivacyTierControl from './PrivacyTierControl';
import type { PrivacyTier } from './PrivacyTierControl';

import { Button } from '@/components/Button';

/** The one-promise gate copy: warm, declinable, and specific to transcription. */
const INTIMATE_GATE_COPY =
  'Intimate writing is never handed to an outside AI, so photo transcription is off for this entry. You can type it privately instead.';
const TYPE_INSTEAD_LABEL = 'Type it instead';
const KEEP_PERSONAL_LABEL = 'Keep as Personal';

export interface CaptureClassificationControlProps {
  /** The currently-chosen tier for the entry being captured. */
  value: PrivacyTier;
  /** Called with the chosen tier when an option is pressed. */
  onChange: (_tier: PrivacyTier) => void;
  /** Step off to a fresh typed entry (pre-set intimate); the session is released. */
  onTypeInstead: () => void;
  /** Revert the selection to ``personal``, re-enabling transcription. */
  onKeepPersonal: () => void;
}

/** The intimate transcription gate: the one-promise copy over its two declinable
 *  actions. Rendered only while ``intimate`` is the chosen tier. */
function IntimateGate({
  onTypeInstead,
  onKeepPersonal,
}: {
  onTypeInstead: () => void;
  onKeepPersonal: () => void;
}): React.JSX.Element {
  return (
    <View testID="capture-intimate-gate" style={styles.intimateGate}>
      <Text testID="capture-intimate-explainer" style={styles.intimateGateText}>
        {INTIMATE_GATE_COPY}
      </Text>
      <Button
        testID="capture-type-instead"
        label={TYPE_INSTEAD_LABEL}
        accessibilityLabel={TYPE_INSTEAD_LABEL}
        onPress={onTypeInstead}
      />
      <Button
        testID="capture-keep-personal"
        variant="secondary"
        label={KEEP_PERSONAL_LABEL}
        accessibilityLabel={KEEP_PERSONAL_LABEL}
        onPress={onKeepPersonal}
      />
    </View>
  );
}

/** The capture-flow classification chooser: the reused tier control over its
 *  intimate transcription gate. */
export function CaptureClassificationControl({
  value,
  onChange,
  onTypeInstead,
  onKeepPersonal,
}: CaptureClassificationControlProps): React.JSX.Element {
  return (
    <View testID="capture-classification" style={styles.classification}>
      <PrivacyTierControl value={value} onChange={onChange} showExplainer={false} />
      {value === 'intimate' ? (
        <IntimateGate onTypeInstead={onTypeInstead} onKeepPersonal={onKeepPersonal} />
      ) : null}
    </View>
  );
}

export default CaptureClassificationControl;
