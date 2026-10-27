import { MoreHorizontal } from 'lucide-react-native';
import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  formatCalendarDate,
  formatPracticeMinutes,
  milestoneText,
} from './PracticeStory.presentation';
import { createPracticeStoryStyles, type PracticeStoryStyles } from './PracticeStory.styles';
import { PracticeStoryCharts } from './PracticeStoryCharts';

import type { PracticeStoryResponse } from '@/api';
import { decorativeHidden } from '@/components/a11yHidden';
import { ink } from '@/design/tokens';
import { useResponsive } from '@/design/useResponsive';
import ReadOnlyMarkdownText from '@/features/Journal/ReadOnlyMarkdownText';
import { dayKeyInTZ } from '@/utils/dateUtils';

interface Props {
  story: PracticeStoryResponse | null;
  stageName: string;
  timezone: string;
}
interface RecordProps {
  story: PracticeStoryResponse;
  timezone: string;
  styles: PracticeStoryStyles;
}
interface HeaderProps {
  story: PracticeStoryResponse;
  styles: PracticeStoryStyles;
  options: boolean;
  onOptions: () => void;
}
function StoryHeader({ story, styles, options, onOptions }: HeaderProps) {
  return (
    <View style={styles.heroRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.hero} testID="practice-story-time">
          {formatPracticeMinutes(story.total_minutes)}
        </Text>
        <Text
          style={styles.caption}
          testID="practice-story-caption"
        >{`in practice · ${story.total_sessions} sits`}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Practice record options"
        accessibilityState={{ expanded: options }}
        onPress={onOptions}
        style={styles.options}
      >
        <MoreHorizontal color={ink.soft} {...decorativeHidden()} />
      </Pressable>
    </View>
  );
}
function StoryMenu({
  tables,
  styles,
  onToggle,
}: {
  tables: boolean;
  styles: PracticeStoryStyles;
  onToggle: () => void;
}) {
  return (
    <View style={styles.menu}>
      <Pressable accessibilityRole="button" onPress={onToggle} style={styles.control}>
        <Text style={styles.controlText}>{tables ? 'Show all charts' : 'Show all tables'}</Text>
      </Pressable>
    </View>
  );
}
function LastInsight({ story, timezone, styles }: RecordProps) {
  if (!story.last_insight) return null;
  return (
    <View testID="practice-story-section-insight" style={styles.section}>
      <Text style={styles.title}>Last insight</Text>
      {story.last_insight_timestamp ? (
        <Text style={styles.caption}>
          {formatCalendarDate(dayKeyInTZ(story.last_insight_timestamp, timezone))}
        </Text>
      ) : null}
      <ReadOnlyMarkdownText
        body={story.last_insight}
        style={styles.body}
        testID="practice-story-insight"
      />
    </View>
  );
}
function StoryNotes({ story, timezone, styles }: RecordProps) {
  const milestones = (story.milestones ?? []).flatMap((entry) => {
    const text = milestoneText(entry);
    return text === null ? [] : [text];
  });
  return (
    <>
      <LastInsight {...{ story, timezone, styles }} />
      {story.observations?.length ? (
        <View testID="practice-story-section-observations" style={styles.section}>
          <Text style={styles.title}>Noticing your practice</Text>
          {story.observations.map((observation, index) => (
            <ReadOnlyMarkdownText key={index} body={observation} style={styles.body} />
          ))}
        </View>
      ) : null}
      {milestones.length ? (
        <View testID="practice-story-section-milestones" style={styles.section}>
          <Text style={styles.title}>Along the way</Text>
          {milestones.map((text, index) => (
            <Text key={index} style={styles.body}>
              {text}
            </Text>
          ))}
        </View>
      ) : null}
    </>
  );
}
export function PracticeStory({ story, stageName, timezone }: Props): React.JSX.Element | null {
  const { width } = useResponsive();
  const styles = useMemo(() => createPracticeStoryStyles(width), [width]);
  const [options, setOptions] = useState(false);
  const [tables, setTables] = useState(false);
  if (story === null) return null;
  const toggleTables = () => {
    setTables(!tables);
    setOptions(false);
  };
  return (
    <View testID="practice-story" style={styles.record}>
      <StoryHeader {...{ story, styles, options }} onOptions={() => setOptions(!options)} />
      {options ? <StoryMenu {...{ tables, styles }} onToggle={toggleTables} /> : null}
      <PracticeStoryCharts {...{ story, stageName, timezone, tables, styles }} />
      <StoryNotes {...{ story, timezone, styles }} />
    </View>
  );
}
