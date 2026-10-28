import { ChevronRight } from 'lucide-react-native';
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { STORY_ICON_SIZE, type HabitStoryStyles } from './HabitStory.styles';
import { HabitStoryCharts } from './HabitStoryCharts';
import {
  datedMilestones,
  earlyDaysLine,
  glanceTiles,
  storyDepth,
  STORY_OBSERVATIONS_SHOWN,
} from './habitStoryPresentation';

import type { ApiHabitStory } from '@/api';
import { decorativeHidden } from '@/components/a11yHidden';
import { ink } from '@/design/tokens';

interface BodyProps {
  story: ApiHabitStory;
  habitName: string;
  tables: boolean;
  styles: HabitStoryStyles;
  onOpenLedger: () => void;
}

function Glance({ story, styles }: { story: ApiHabitStory; styles: HabitStoryStyles }) {
  return (
    <View testID="habit-story-glance" style={styles.glance}>
      {glanceTiles(story).map((tile) => (
        <View
          key={tile.key}
          testID={`habit-story-glance-${tile.key}`}
          style={styles.tile}
          accessible
          accessibilityLabel={`${tile.label}: ${tile.value}${tile.caption ? ` ${tile.caption}` : ''}`}
        >
          <Text style={styles.tileLabel}>{tile.label}</Text>
          <Text style={styles.tileValue}>{tile.value}</Text>
          {tile.caption ? <Text style={styles.caption}>{tile.caption}</Text> : null}
        </View>
      ))}
    </View>
  );
}

function Notes({ story, habitName, styles }: Omit<BodyProps, 'tables' | 'onOpenLedger'>) {
  const early = !storyDepth(story).charts;
  const observations = (
    early ? [earlyDaysLine(story, habitName), ...story.observations.slice(1)] : story.observations
  ).slice(0, STORY_OBSERVATIONS_SHOWN);
  const milestones = datedMilestones(story);
  return (
    <>
      {observations.length > 0 ? (
        <View testID="habit-story-observations" style={styles.section}>
          {observations.map((line, index) => (
            <View key={index} style={styles.note}>
              <Text style={styles.prose}>{line}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {milestones.length > 0 ? (
        <View testID="habit-story-milestones" style={styles.section}>
          <Text style={styles.sectionTitle}>Along the way</Text>
          {milestones.map((milestone, index) => (
            <View key={index} style={styles.milestone}>
              <Text style={styles.milestoneDate}>{milestone.date}</Text>
              <Text style={[styles.prose, styles.shrink]}>{milestone.text}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}

/** Glance, charts, notes and the door to everything, top to bottom (#3526). */
export function HabitStoryBody(props: BodyProps) {
  const { story, styles, onOpenLedger } = props;
  return (
    <>
      <Glance story={story} styles={styles} />
      <HabitStoryCharts {...props} />
      <Notes story={story} habitName={props.habitName} styles={styles} />
      <View style={styles.footer}>
        <Pressable
          testID="habit-story-everything"
          accessibilityRole="button"
          accessibilityLabel="Everything: every log and figure"
          onPress={onOpenLedger}
          style={styles.footerAction}
        >
          <Text style={styles.footerText}>Everything</Text>
          <ChevronRight color={ink.soft} size={STORY_ICON_SIZE} {...decorativeHidden()} />
        </Pressable>
      </View>
    </>
  );
}
