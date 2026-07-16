/**
 * The Course header-drawer body: a stage-grouped table of contents rendered as
 * ``ScreenDrawer`` children (the panel already supplies the scroll surface, so
 * this maps plain sections rather than nesting its own list).
 *
 * Chapter content for every stage is fetched lazily and independently while the
 * drawer is open (locked stages return titles-only rows), gated per stage so a
 * stage that is not yet known at the first open still loads on a later open, and
 * the cache survives close/reopen. A failed fetch for an unlocked stage shows an
 * inline retry row while its siblings keep their chapters; a failed fetch for a
 * locked stage degrades to a header-only row (audit-ux-04 pattern).
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

import { getStageColor, isCompleted, isUnlocked } from './stageDisplay';

/** Glyph shown on a completed stage header. */
const COMPLETED_GLYPH = '✓';
/** Glyph shown on a locked stage header or chapter row. */
const LOCKED_GLYPH = '🔒';
/** Copy for the inline per-section retry row after a failed fetch. */
const RETRY_LABEL = 'Content failed to load. Tap to retry.';
/** Dim factor applied to a locked chapter row. */
const LOCKED_ROW_OPACITY = 0.5;
/** Side of the square stage-color swatch in dp. */
const SWATCH_SIZE = 14;

/** Load state for one stage's chapter list within the drawer. */
type DrawerSection =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly items: ContentItem[] }
  | { readonly status: 'error' };

/** Per-stage-number load state, keyed by stage number. */
export type DrawerSections = Readonly<Record<number, DrawerSection | undefined>>;

/**
 * Lazily load every stage's chapters while the drawer is open, caching the
 * results so reopening never refetches. Each stage loads on its own promise so a
 * slow or failing stage never blocks its siblings, and a per-stage sequence
 * guard drops stale responses (unmount or a retry supersedes them).
 *
 * Loading is gated per stage on the absence of a section entry, not on a
 * one-shot open latch: a stage that has no entry yet fetches, while any stage
 * already loading, loaded, or errored is skipped. So a stage that becomes known
 * after the first open still loads on a later open, and the effect converges
 * (each fetch seeds a ``loading`` entry, making re-runs no-ops).
 *
 * This hook lives above the drawer panel (which unmounts when closed) so its
 * cache survives close/reopen.
 */
export function useCourseDrawerContent(
  stages: Stage[],
  isOpen: boolean,
): { sections: DrawerSections; retry: (_stageNumber: number) => void } {
  const [sections, setSections] = useState<Record<number, DrawerSection>>({});
  const requestSeq = useRef<Record<number, number>>({});
  const mountedRef = useRef(true);

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

  useEffect(() => {
    if (!isOpen) return;
    // Fetch every stage that has no entry yet; loading/loaded/errored stages
    // already carry an entry, so re-runs (including reopens) become no-ops.
    for (const stage of stages) {
      const stageNumber = stage.stage_number;
      if (sections[stageNumber] === undefined) {
        loadStage(stageNumber);
      }
    }
  }, [isOpen, stages, sections, loadStage]);

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
      style={[styles.stageHeader, isSelected ? styles.stageHeaderSelected : null]}
    >
      <View
        testID={`course-drawer-swatch-${stageNumber}`}
        style={[styles.swatch, { backgroundColor: color }]}
      />
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

/** The rows below a stage header: chapters, a retry, or a loading spinner. */
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

/** One stage: a header plus its lazily-loaded chapter rows; a failed locked
 *  stage renders header-only. */
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
  // A failed fetch on a locked stage degrades to a header-only row: no retry, no
  // spinner. Every other state (including a failed unlocked stage) shows a body.
  const status = section?.status;
  const showBody = !(status === 'error' && !unlocked);
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
      {showBody ? (
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
  /** Every stage in the course; only present stages render (gap numbers are skipped). */
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
  const stageNumbers = useMemo(() => [...stageById.keys()].sort((a, b) => a - b), [stageById]);
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
    gap: SPACING.sm,
    minHeight: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    marginTop: SPACING.sm,
    borderRadius: radius.sm,
  },
  stageHeaderSelected: {
    backgroundColor: surface.sunken,
  },
  swatch: {
    width: SWATCH_SIZE,
    height: SWATCH_SIZE,
    borderRadius: radius.sm,
  },
  stageHeaderTitle: {
    flex: 1,
    color: ink.primary,
    fontWeight: '700',
  },
  stageHeaderGlyph: {
    color: ink.muted,
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
