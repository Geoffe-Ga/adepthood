import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import type { PromptDetail } from '../../api';
import { useDerivedCurrentWeek } from '../../store/useProgramProgression';

import styles from './Journal.styles';

interface WeeklyPromptBannerProps {
  prompt: PromptDetail;
  onRespond: () => void;
}

const WeeklyPromptBanner = ({ prompt, onRespond }: WeeklyPromptBannerProps): React.JSX.Element => {
  // When the user has set a master program start date, the banner shows
  // the week derived from ``today - programStartDate`` so BotMason
  // surfaces "Week 2" exactly when the anchor says it should.  With no
  // anchor we fall back to the server's count-based ``prompt.week_number``.
  const displayWeek = useDerivedCurrentWeek(prompt.week_number);

  return (
    <View style={styles.promptBanner} testID="weekly-prompt-banner">
      <Text style={styles.promptLabel}>Week {displayWeek} Reflection</Text>
      <Text style={styles.promptQuestion}>{prompt.question}</Text>
      <TouchableOpacity
        testID="prompt-respond-button"
        style={styles.promptRespondButton}
        onPress={onRespond}
        accessibilityLabel="Respond to weekly prompt"
        accessibilityRole="button"
      >
        <Text style={styles.promptRespondText}>Respond</Text>
      </TouchableOpacity>
    </View>
  );
};

export default WeeklyPromptBanner;
