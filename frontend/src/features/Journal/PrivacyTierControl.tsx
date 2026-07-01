/**
 * ``PrivacyTierControl`` — the three-tier privacy chooser on the journal editor.
 *
 * A radio-like segmented control (public / personal / intimate) that lets the
 * writer set how open an entry is. Choosing ``intimate`` reveals a one-line
 * explainer that the entry is never sent to AI — the resonance affordance is
 * gated off for intimate entries in the hosting screen. ``personal`` is the
 * backend default and the selection when no ``value`` is supplied.
 *
 * Presentational and controlled: ``onChange`` is the only output; the host owns
 * the tier and persists it (create/update).
 */
import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import styles from './JournalEntry.styles';

/** Privacy tier for a journal entry (mirrors the backend classification enum). */
export type PrivacyTier = 'public' | 'personal' | 'intimate';

/** The backend default tier, used when no ``value`` is supplied. */
const DEFAULT_TIER: PrivacyTier = 'personal';

/** One-line copy shown under the control when ``intimate`` is selected. */
const INTIMATE_EXPLAINER = 'Intimate entries are never sent to AI.';

interface TierOption {
  tier: PrivacyTier;
  label: string;
  /** Screen-reader hint describing what the tier means. */
  hint: string;
}

/** The three tiers, ordered most-open → most-private. */
const TIER_OPTIONS: readonly TierOption[] = [
  { tier: 'public', label: 'Public', hint: 'Most open — shareable with the Sangha.' },
  { tier: 'personal', label: 'Personal', hint: 'Private to you; resonance may read it.' },
  { tier: 'intimate', label: 'Intimate', hint: 'Never sent to AI; resonance is paused.' },
];

export interface PrivacyTierControlProps {
  /** The currently-selected tier; defaults to ``personal`` when omitted. */
  value?: PrivacyTier;
  /** Called with the chosen tier when an option is pressed. */
  onChange: (_tier: PrivacyTier) => void;
}

interface TierButtonProps {
  option: TierOption;
  selected: boolean;
  onChange: (_tier: PrivacyTier) => void;
}

/** A single radio-like tier option; announces its selection state. */
function TierButton({ option, selected, onChange }: TierButtonProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[styles.privacyTierOption, selected && styles.privacyTierOptionSelected]}
      onPress={() => onChange(option.tier)}
      accessibilityRole="radio"
      accessibilityLabel={option.label}
      accessibilityHint={option.hint}
      accessibilityState={{ selected }}
      testID={`privacy-tier-${option.tier}`}
    >
      <Text style={[styles.privacyTierLabel, selected && styles.privacyTierLabelSelected]}>
        {option.label}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * The privacy tier segmented control plus its intimate-only explainer. Rendered
 * in the writing column of {@link JournalEntryScreen}.
 */
function PrivacyTierControl({
  value = DEFAULT_TIER,
  onChange,
}: PrivacyTierControlProps): React.JSX.Element {
  return (
    <View style={styles.privacyTierControl}>
      <View
        style={styles.privacyTierRow}
        accessibilityRole="radiogroup"
        accessibilityLabel="Entry privacy"
      >
        {TIER_OPTIONS.map((option) => (
          <TierButton
            key={option.tier}
            option={option}
            selected={option.tier === value}
            onChange={onChange}
          />
        ))}
      </View>
      {value === 'intimate' ? (
        <Text style={styles.privacyTierExplainer} testID="privacy-tier-explainer">
          {INTIMATE_EXPLAINER}
        </Text>
      ) : null}
    </View>
  );
}

export default PrivacyTierControl;
