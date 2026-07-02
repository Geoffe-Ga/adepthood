import React from 'react';
import { Text, View } from 'react-native';

import styles from '../Habits.styles';
import { calculateNetEnergy } from '../HabitUtils';

import { EnergyTextInput } from './EnergyTextInput';

const ENERGY_VALIDATION_NOTE = 'Enter a whole number from -10 to 10.';

interface EnergyCostReturnEditorProps {
  cost: number;
  energyReturn: number;
  onCommitCost: (_value: number) => void;
  onCommitReturn: (_value: number) => void;
  costTestID?: string;
  returnTestID?: string;
}

/**
 * Shared Cost/Return/Net energy editor. Renders the header row, the two
 * `EnergyTextInput`s, the computed Net value, and the single canonical
 * validation note so every Habits call site edits energy identically. Callers
 * bind their own value source (persisted habit fields or local draft state) via
 * `cost`/`energyReturn` and the two commit callbacks.
 */
export const EnergyCostReturnEditor = ({
  cost,
  energyReturn,
  onCommitCost,
  onCommitReturn,
  costTestID,
  returnTestID,
}: EnergyCostReturnEditorProps) => (
  <View style={styles.energyContainer}>
    <View style={styles.energyHeader}>
      <Text style={styles.energyHeaderText}>Cost</Text>
      <Text style={styles.energyHeaderText}>Return</Text>
      <Text style={styles.energyHeaderText}>Net</Text>
    </View>
    <View style={styles.energyRow}>
      <EnergyTextInput
        testID={costTestID}
        style={styles.energyInput}
        value={cost}
        onCommit={onCommitCost}
      />
      <EnergyTextInput
        testID={returnTestID}
        style={styles.energyInput}
        value={energyReturn}
        onCommit={onCommitReturn}
      />
      <Text style={styles.netEnergyValue}>{calculateNetEnergy(cost, energyReturn)}</Text>
    </View>
    <View style={styles.validationNote}>
      <Text style={styles.validationText}>{ENERGY_VALIDATION_NOTE}</Text>
    </View>
  </View>
);

export default EnergyCostReturnEditor;
