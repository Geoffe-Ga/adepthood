import { ChevronLeft, MoreHorizontal, X } from 'lucide-react-native';
import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  createHabitStoryStyles,
  HELD_STORY_OPACITY,
  STORY_ICON_SIZE,
  type HabitStoryStyles,
} from './HabitStory.styles';
import { HabitStoryBody } from './HabitStoryBody';

import { decorativeHidden } from '@/components/a11yHidden';
import { ErrorFallback } from '@/components/ErrorFallback';
import { ContentContainer } from '@/components/layout/ContentContainer';
import { ink } from '@/design/tokens';
import { useResponsive } from '@/design/useResponsive';
import { STORY_CLOSE_LABEL } from '@/features/Habits/components/modalCloseLabels';
import { useHabitStory, type StoryHabit } from '@/features/Habits/hooks/useHabitStory';
import { HabitLedger } from '@/features/Habits/ledger/HabitLedger';

export interface HabitStorySheetProps {
  visible: boolean;
  habit: StoryHabit | null;
  onClose: () => void;
}

type SheetView = 'story' | 'ledger';

interface HeaderProps {
  title: string;
  styles: HabitStoryStyles;
  view: SheetView;
  menuOpen: boolean;
  canTabulate: boolean;
  onBack: () => void;
  onMenu: () => void;
  onClose: () => void;
}

function SheetHeader({ title, styles, view, menuOpen, canTabulate, ...on }: HeaderProps) {
  return (
    <View style={styles.header}>
      {view === 'ledger' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to the story"
          onPress={on.onBack}
          style={styles.iconButton}
        >
          <ChevronLeft color={ink.soft} size={STORY_ICON_SIZE} {...decorativeHidden()} />
        </Pressable>
      ) : null}
      <Text accessibilityRole="header" style={styles.title} numberOfLines={2}>
        {view === 'ledger' ? `${title} · Everything` : title}
      </Text>
      {view === 'story' && canTabulate ? (
        <Pressable
          testID="habit-story-options"
          accessibilityRole="button"
          accessibilityLabel="Story options"
          accessibilityState={{ expanded: menuOpen }}
          onPress={on.onMenu}
          style={styles.iconButton}
        >
          <MoreHorizontal color={ink.soft} size={STORY_ICON_SIZE} {...decorativeHidden()} />
        </Pressable>
      ) : null}
      <Pressable
        testID="habit-story-close"
        accessibilityRole="button"
        accessibilityLabel={STORY_CLOSE_LABEL}
        onPress={on.onClose}
        style={styles.iconButton}
      >
        <X color={ink.soft} size={STORY_ICON_SIZE} {...decorativeHidden()} />
      </Pressable>
    </View>
  );
}

interface ContentProps {
  habit: StoryHabit;
  read: ReturnType<typeof useHabitStory>;
  view: SheetView;
  tables: boolean;
  styles: HabitStoryStyles;
  onOpenLedger: () => void;
}

function SheetContent({ habit, read, view, tables, styles, onOpenLedger }: ContentProps) {
  if (read.local)
    return (
      <View testID="habit-story-sample" style={styles.note}>
        <Text style={styles.prose}>
          This is a sample habit. Its story is drawn from your own check-ins once you add a habit of
          your own.
        </Text>
      </View>
    );
  if (read.error !== null)
    return (
      <View testID="habit-story-error" style={styles.error}>
        <ErrorFallback
          heading="This habit's story could not load."
          onRetry={() => void read.refresh()}
          retryAccessibilityLabel="Try loading the story again"
          retryTestID="habit-story-retry"
        />
      </View>
    );
  if (read.story === null) return null;
  return (
    <View
      testID="habit-story-content"
      style={read.loading ? { opacity: HELD_STORY_OPACITY } : undefined}
    >
      <View style={styles.stack}>
        {view === 'ledger' ? (
          <HabitLedger
            story={read.story}
            habitName={habit.name}
            timezone={read.timezone}
            styles={styles}
          />
        ) : (
          <HabitStoryBody
            story={read.story}
            habitName={habit.name}
            tables={tables}
            styles={styles}
            onOpenLedger={onOpenLedger}
          />
        )}
      </View>
    </View>
  );
}

function TablesMenu({
  tables,
  styles,
  onToggle,
}: {
  tables: boolean;
  styles: HabitStoryStyles;
  onToggle: () => void;
}) {
  return (
    <View style={styles.menu}>
      <Pressable
        testID="habit-story-tables"
        accessibilityRole="button"
        onPress={onToggle}
        style={styles.control}
      >
        <Text style={styles.controlText}>
          {tables ? 'Show all as charts' : 'Show all as tables'}
        </Text>
      </Pressable>
    </View>
  );
}

/** Which floor is open, whether the options menu is out, and charts or tables. */
function useSheetState(onClose: () => void) {
  const [view, setView] = useState<SheetView>('story');
  const [menuOpen, setMenuOpen] = useState(false);
  const [tables, setTables] = useState(false);
  return {
    view,
    menuOpen,
    tables,
    openLedger: () => setView('ledger'),
    back: () => setView('story'),
    toggleMenu: () => setMenuOpen(!menuOpen),
    toggleTables: () => {
      setTables(!tables);
      setMenuOpen(false);
    },
    close: () => {
      setView('story');
      setMenuOpen(false);
      onClose();
    },
  };
}

/**
 * The Habit Story sheet (#3526, epic #3519): one tap from a tile, a full-height
 * page that reads the server's story and draws it. Replaces the Stats modal.
 */
export function HabitStorySheet({ visible, habit, onClose }: HabitStorySheetProps) {
  const { width } = useResponsive();
  const styles = useMemo(() => createHabitStoryStyles(width), [width]);
  const read = useHabitStory(habit, visible);
  const sheet = useSheetState(onClose);
  if (habit === null) return null;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={sheet.close}>
      <SafeAreaView testID="habit-story-sheet" style={styles.screen}>
        <ContentContainer fill>
          <SheetHeader
            title={habit.name}
            styles={styles}
            view={sheet.view}
            menuOpen={sheet.menuOpen}
            canTabulate={read.story !== null}
            onBack={sheet.back}
            onMenu={sheet.toggleMenu}
            onClose={sheet.close}
          />
          {sheet.menuOpen && sheet.view === 'story' ? (
            <TablesMenu tables={sheet.tables} styles={styles} onToggle={sheet.toggleTables} />
          ) : null}
          <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
            <SheetContent
              habit={habit}
              read={read}
              view={sheet.view}
              tables={sheet.tables}
              styles={styles}
              onOpenLedger={sheet.openLedger}
            />
          </ScrollView>
        </ContentContainer>
      </SafeAreaView>
    </Modal>
  );
}

export default HabitStorySheet;
