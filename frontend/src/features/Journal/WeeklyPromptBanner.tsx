import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import type { PromptDetail } from '../../api';

import styles from './Journal.styles';

interface WeeklyPromptBannerProps {
  prompt: PromptDetail;
  onRespond: () => void;
}

const WeeklyPromptBanner = ({ prompt, onRespond }: WeeklyPromptBannerProps): React.JSX.Element => {
  return (
    <View style={styles.promptBanner} testID="weekly-prompt-banner">
      <Text style={styles.promptLabel}>Week {prompt.week_number} Reflection</Text>
      <Text style={styles.promptQuestion}>{prompt.question}</Text>
      <TouchableOpacity
        testID="prompt-respond-button"
        style={styles.promptRespondButton}
        onPress={onRespond}
      >
        <Text style={styles.promptRespondText}>Respond</Text>
      </TouchableOpacity>
    </View>
  );
};

export default WeeklyPromptBanner;
