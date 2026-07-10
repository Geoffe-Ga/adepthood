/**
 * The Course header-drawer body: a stage-grouped table of contents rendered as
 * ``ScreenDrawer`` children (the panel already supplies the scroll surface, so
 * this maps plain sections rather than nesting its own list).
 *
 * Chapter content for each unlocked stage is fetched lazily and independently
 * the first time the drawer opens, cached across reopens, and a per-section
 * failure surfaces an inline retry row instead of blanking that stage while its
 * siblings keep their chapters (audit-ux-04 pattern).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

import { course as courseApi, type ContentItem, type Stage } from '../../api';
import { SPACING, accent, ink, radius, surface, touchTarget, type } from '../../design/tokens';

import { getStageColor, isCompleted, isUnlocked, totalStageCount } from './stageDisplay';

/** Glyph shown on a completed stage header. */
const COMPLETED_GLYPH = '✓';
/** Glyph shown on a locked stage header or chapter row. */
const LOCKED_GLYPH = '🔒';
/** Copy for the inline per-section retry row after a failed fetch. */
const RETRY_LABEL = 'Content failed to load. Tap to retry.';
/** Dim factor applied to a locked chapter row. */
const LOCKED_ROW_OPACITY = 0.5;

/** Load state for one stage's chapter list within the drawer. */
type DrawerSection =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly items: ContentItem[] }
  | { readonly status: 'error' };

/** Per-stage-number load state, keyed by stage number. */
export type DrawerSections = Readonly<Record<number, DrawerSection | undefined>>;

/**
 * Lazily load each unlocked stage's chapters the first time the drawer opens,
 * caching the results so reopening never refetches. Each stage loads on its own
 * promise so a slow or failing stage never blocks its siblings, and a per-stage
 * sequence guard drops stale responses (unmount or a retry supersedes them).
 *
 * This hook lives above the drawer panel (which unmounts when closed) so its
 * cache survives close/reopen. It assumes ``stages`` is effectively static for
 * the life of the mount: the first open latches the set of stages to load, so a
 * stage that becomes unlocked afterward would need a remount to fetch.
 */
export function useCourseDrawerContent(
  stages: Stage[],
  isOpen: boolean,
): { sections: DrawerSections; retry: (_stageNumber: number) => void } {
  const [sections, setSections] = useState<Record<number, DrawerSection>>({});
  const requestSeq = useRef<Record<number, number>>({});
  const mountedRef = useRef(true);
  const hasOpened = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadStage = useCallback((stageNumber: number) => {
    const seq = (requestSeq.current[stageNumber] ?? 0) + 1;
    requestSeq.current[stageNumber] = seq;
    const isLatest = (): boolean => mountedRef.current && requestSeq.current[stageNumber] === seq;
    setSections((prev) => ({ ...prev, [stageNumber]: { status: 'loading' } }));
    void courseApi
      .stageContentAll(stageNumber)
      .then((items) => {
        if (isLatest()) {
          setSections((prev) => ({ ...prev, [stageNumber]: { status: 'loaded', items } }));
        }
      })
      .catch((err: unknown) => {
        // A per-section failure must not blank the drawer: flag only this stage
        // so it shows an inline retry while siblings keep their chapters.
        console.error('Failed to load drawer stage content:', err);
        if (isLatest()) {
          setSections((prev) => ({ ...prev, [stageNumber]: { status: 'error' } }));
        }
      });
  }, []);

  const unlockedStageNumbers = useMemo(
    () => stages.filter((s) => s.is_unlocked).map((s) => s.stage_number),
    [stages],
  );

  useEffect(() => {
    if (!isOpen || hasOpened.current) return;
    hasOpened.current = true;
    for (const stageNumber of unlockedStageNumbers) {
      loadStage(stageNumber);
    }
  }, [isOpen, unlockedStageNumbers, loadStage]);

  return { sections, retry: loadStage };
}

/** Resolve the status glyph for a stage header, or null for an open stage. */
function headerGlyph(unlocked: boolean, completed: boolean): string | null {
  if (completed) return COMPLETED_GLYPH;
  if (!unlocked) return LOCKED_GLYPH;
  return null;
}

interface StageHeaderProps {
  stageNumber: number;
  title: string;
  color: string;
  unlocked: boolean;
  completed: boolean;
  isSelected: boolean;
}

/** A stage's colored section header, marked completed / locked / selected. */
const StageHeader = ({
  stageNumber,
  title,
  color,
  unlocked,
  completed,
  isSelected,
}: StageHeaderProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const glyph = headerGlyph(unlocked, completed);
  return (
    <View
      testID={`course-drawer-stage-${stageNumber}`}
      accessibilityState={{ disabled: !unlocked, selected: isSelected }}
      style={[styles.stageHeader, { backgroundColor: color }]}
    >
      <Text style={[type(width).label, styles.stageHeaderTitle]} numberOfLines={1}>
        {title}
      </Text>
      {glyph === null ? null : (
        <Text style={[type(width).body, styles.stageHeaderGlyph]}>{glyph}</Text>
      )}
    </View>
  );
};

interface ChapterRowProps {
  stageNumber: number;
  item: ContentItem;
  onChapterPress: (_stageNumber: number, _item: ContentItem) => void;
}

/** A single chapter row; a locked chapter is disabled and non-navigable. */
const ChapterRow = ({ stageNumber, item, onChapterPress }: ChapterRowProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const locked = item.is_locked;
  return (
    <TouchableOpacity
      testID={`course-drawer-chapter-${item.id}`}
      accessibilityRole="button"
      accessibilityLabel={locked ? `${item.title}, locked` : item.title}
      accessibilityState={{ disabled: locked }}
      disabled={locked}
      onPress={() => {
        if (locked) return;
        onChapterPress(stageNumber, item);
      }}
      style={[styles.chapterRow, locked && styles.chapterRowLocked]}
    >
      <Text style={[type(width).body, styles.chapterRowLabel]} numberOfLines={1}>
        {item.title}
      </Text>
      {locked ? <Text style={styles.chapterRowGlyph}>{LOCKED_GLYPH}</Text> : null}
    </TouchableOpacity>
  );
};

interface RetryRowProps {
  stageNumber: number;
  onRetry: (_stageNumber: number) => void;
}

/** Inline retry affordance shown when a single stage's fetch failed. */
const RetryRow = ({ stageNumber, onRetry }: RetryRowProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  return (
    <TouchableOpacity
      testID={`course-drawer-retry-${stageNumber}`}
      accessibilityRole="button"
      accessibilityLabel={`Retry loading stage ${stageNumber}`}
      onPress={() => onRetry(stageNumber)}
      style={styles.retryRow}
    >
      <Text style={[type(width).body, styles.retryRowText]}>{RETRY_LABEL}</Text>
    </TouchableOpacity>
  );
};

interface StageSectionBodyProps {
  stageNumber: number;
  section: DrawerSection | undefined;
  onChapterPress: (_stageNumber: number, _item: ContentItem) => void;
  onRetry: (_stageNumber: number) => void;
}

/** The rows below an unlocked stage header: chapters, a retry, or a spinner. */
const StageSectionBody = ({
  stageNumber,
  section,
  onChapterPress,
  onRetry,
}: StageSectionBodyProps): React.JSX.Element => {
  if (section?.status === 'error') {
    return <RetryRow stageNumber={stageNumber} onRetry={onRetry} />;
  }
  if (section?.status === 'loaded') {
    return (
      <View>
        {section.items.map((item) => (
          <ChapterRow
            key={item.id}
            stageNumber={stageNumber}
            item={item}
            onChapterPress={onChapterPress}
          />
        ))}
      </View>
    );
  }
  return (
    <ActivityIndicator
      testID={`course-drawer-loading-${stageNumber}`}
      size="small"
      color={accent.primary}
      style={styles.sectionLoading}
    />
  );
};

interface StageSectionProps {
  stageNumber: number;
  stageById: Map<number, Stage>;
  section: DrawerSection | undefined;
  isSelected: boolean;
  onChapterPress: (_stageNumber: number, _item: ContentItem) => void;
  onRetry: (_stageNumber: number) => void;
}

/** One stage: a header plus, when unlocked, its lazily-loaded chapter rows. */
const StageSection = ({
  stageNumber,
  stageById,
  section,
  isSelected,
  onChapterPress,
  onRetry,
}: StageSectionProps): React.JSX.Element => {
  const unlocked = isUnlocked(stageNumber, stageById);
  const completed = isCompleted(stageNumber, stageById);
  const title = stageById.get(stageNumber)?.title ?? `Stage ${stageNumber}`;
  return (
    <View style={styles.section}>
      <StageHeader
        stageNumber={stageNumber}
        title={title}
        color={getStageColor(stageNumber, stageById)}
        unlocked={unlocked}
        completed={completed}
        isSelected={isSelected}
      />
      {unlocked ? (
        <StageSectionBody
          stageNumber={stageNumber}
          section={section}
          onChapterPress={onChapterPress}
          onRetry={onRetry}
        />
      ) : null}
    </View>
  );
};

export interface CourseDrawerProps {
  /** Every stage in the course; the drawer renders one section per stage. */
  stages: Stage[];
  /** The stage currently shown on the screen, marked selected in the list. */
  selectedStage: number;
  /** Per-stage chapter load state, owned by :func:`useCourseDrawerContent`. */
  sections: DrawerSections;
  /** Select a stage, open the chapter, and close the drawer. */
  onChapterPress: (_stageNumber: number, _item: ContentItem) => void;
  /** Refetch a single failed stage's chapters. */
  onRetry: (_stageNumber: number) => void;
}

/** The stage-grouped table of contents for the Course header drawer. */
export default function CourseDrawer({
  stages,
  selectedStage,
  sections,
  onChapterPress,
  onRetry,
}: CourseDrawerProps): React.JSX.Element {
  const stageById = useMemo(() => new Map(stages.map((s) => [s.stage_number, s])), [stages]);
  const stageNumbers = Array.from({ length: totalStageCount(stages) }, (_, i) => i + 1);
  return (
    <View testID="course-drawer">
      {stageNumbers.map((stageNumber) => (
        <StageSection
          key={stageNumber}
          stageNumber={stageNumber}
          stageById={stageById}
          section={sections[stageNumber]}
          isSelected={stageNumber === selectedStage}
          onChapterPress={onChapterPress}
          onRetry={onRetry}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: SPACING.sm,
  },
  stageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    minHeight: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    marginTop: SPACING.sm,
    borderRadius: radius.sm,
  },
  stageHeaderTitle: {
    flex: 1,
    color: surface.canvas,
    fontWeight: '700',
  },
  stageHeaderGlyph: {
    color: surface.canvas,
  },
  sectionLoading: {
    alignSelf: 'flex-start',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  chapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    minHeight: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  chapterRowLocked: {
    opacity: LOCKED_ROW_OPACITY,
  },
  chapterRowLabel: {
    flex: 1,
    color: ink.primary,
  },
  chapterRowGlyph: {
    color: ink.muted,
  },
  retryRow: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  retryRowText: {
    color: accent.primary,
    fontWeight: '600',
  },
});
