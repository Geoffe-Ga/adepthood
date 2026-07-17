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
import { DrawerItem, DrawerSearch, fuzzyMatch } from '../../components/drawer';
import { SPACING, accent, ink, radius, surface, touchTarget, type } from '../../design/tokens';

import {
  getStageColor,
  isCompleted,
  isUnlocked,
  STAGE_LOCKED_GLYPH,
  stageStatusGlyph,
} from './stageDisplay';

/** Copy for the inline per-section retry row after a failed fetch. */
const RETRY_LABEL = 'Content failed to load. Tap to retry.';
/** Dim factor applied to a locked chapter row. */
const LOCKED_ROW_OPACITY = 0.5;
/** Side of the square stage-color swatch in dp. */
const SWATCH_SIZE = 14;
/** Placeholder for the drawer's fuzzy chapter-title search field. */
const SEARCH_PLACEHOLDER = 'Search chapters...';
/** Accessibility label for that search field. */
const SEARCH_ACCESSIBILITY_LABEL = 'Search chapters';
/** Test hook for the drawer's search-field wrapper. */
const SEARCH_TESTID = 'course-drawer-search';
/** Confirm-row copy that invites widening the search into chapter bodies. */
const DEEP_SEARCH_LABEL = 'Search inside chapters? This downloads chapter text.';
/** Quiet caption shown while the confirm-triggered body sweep is running. */
const SEARCH_LOADING_LABEL = 'Searching inside chapters...';
/** Quiet caption shown when the body sweep failed, above its retry row. */
const SEARCH_ERROR_LABEL = 'We could not finish searching the chapters.';
/** Retry affordance shown alongside the sweep-error caption. */
const SEARCH_RETRY_LABEL = 'Tap to retry';

/** Load state for one stage's chapter list within the drawer. */
type DrawerSection =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly items: ContentItem[] }
  | { readonly status: 'error' };

/** Per-stage-number load state, keyed by stage number. */
export type DrawerSections = Readonly<Record<number, DrawerSection | undefined>>;

/** Progress of the confirm-gated chapter-body sweep for deep search. */
export type BodySweepStatus = 'idle' | 'loading' | 'error';

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

/** Stage numbers present in the section map, ascending. */
function sortedSectionStageNumbers(sections: DrawerSections): number[] {
  return Object.keys(sections)
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * The unlocked, loaded, not-yet-cached chapter ids to fetch, in stage-then-list
 * order. Locked chapters never expose a body and already-cached ones are
 * skipped, so a repeat confirm retries only the ids still missing.
 */
function collectBodyTargets(
  sections: DrawerSections,
  bodies: Readonly<Record<number, string>>,
): number[] {
  const targets: number[] = [];
  for (const stageNumber of sortedSectionStageNumbers(sections)) {
    const section = sections[stageNumber];
    if (section?.status !== 'loaded') continue;
    for (const item of section.items) {
      if (!item.is_locked && bodies[item.id] === undefined) targets.push(item.id);
    }
  }
  return targets;
}

/**
 * Fetch each target body in sequence, caching successes as they arrive and
 * counting them. One fetch's rejection degrades that row silently; the caller
 * decides whether an all-failed sweep is a systemic error. The mount guard drops
 * a late resolution after the drawer host unmounts.
 */
async function sweepChapterBodies(
  targets: readonly number[],
  setBodies: React.Dispatch<React.SetStateAction<Record<number, string>>>,
  isMounted: () => boolean,
): Promise<number> {
  let succeeded = 0;
  for (const contentId of targets) {
    try {
      const body = await courseApi.contentBody(contentId);
      if (isMounted()) setBodies((prev) => ({ ...prev, [contentId]: body.body_markdown }));
      succeeded += 1;
    } catch {
      // A single chapter's failure (drip-locked or 404-masked body) is dropped
      // silently; only an all-failed sweep surfaces below as an error status.
    }
  }
  return succeeded;
}

/**
 * Confirm-gated chapter-body cache backing the drawer's deep search. Titles
 * search with no fetch; only an explicit confirm sweeps every unlocked, loaded,
 * uncached chapter's body into ``bodies`` so it becomes matchable.
 *
 * Mounted above the drawer panel (which unmounts on close) so the cache survives
 * close/reopen. ``confirmBodySearch`` recomputes its targets at call time and is
 * a no-op while a sweep is already in flight or when nothing remains to fetch;
 * re-invoking it after a failure naturally retries only the still-missing ids.
 */
export function useCourseDrawerBodies(sections: DrawerSections): {
  bodies: Record<number, string>;
  status: BodySweepStatus;
  confirmBodySearch: () => void;
} {
  const [bodies, setBodies] = useState<Record<number, string>>({});
  const [status, setStatus] = useState<BodySweepStatus>('idle');
  const mountedRef = useRef(true);
  const sweepingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const confirmBodySearch = useCallback(() => {
    if (sweepingRef.current) return;
    const targets = collectBodyTargets(sections, bodies);
    if (targets.length === 0) {
      setStatus('idle');
      return;
    }
    sweepingRef.current = true;
    setStatus('loading');
    const isMounted = (): boolean => mountedRef.current;
    void sweepChapterBodies(targets, setBodies, isMounted).then((succeeded) => {
      sweepingRef.current = false;
      if (isMounted()) setStatus(succeeded === 0 ? 'error' : 'idle');
    });
  }, [sections, bodies]);

  return { bodies, status, confirmBodySearch };
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
  const glyph = stageStatusGlyph(unlocked, completed);
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
      onPress={() => onChapterPress(stageNumber, item)}
      style={[styles.chapterRow, locked && styles.chapterRowLocked]}
    >
      <Text style={[type(width).body, styles.chapterRowLabel]} numberOfLines={1}>
        {item.title}
      </Text>
      {locked ? <Text style={styles.chapterRowGlyph}>{STAGE_LOCKED_GLYPH}</Text> : null}
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

/** The text a chapter is matched against: its title, plus its body only once a
 *  body search is active for an unlocked chapter whose body is cached. */
function chapterSearchText(
  item: ContentItem,
  bodies: Readonly<Record<number, string>>,
  bodySearchActive: boolean,
): string {
  const body = bodies[item.id];
  if (bodySearchActive && !item.is_locked && body) return `${item.title} ${body}`;
  return item.title;
}

/** A loaded stage narrowed to the chapters that match the active query. */
interface MatchedStage {
  stageNumber: number;
  items: ContentItem[];
}

/** Loaded stages (ascending) filtered to their query-matching chapters; stages
 *  with no match are dropped so only relevant sections render. */
function matchStages(
  query: string,
  sections: DrawerSections,
  bodies: Readonly<Record<number, string>>,
  bodySearchActive: boolean,
): MatchedStage[] {
  const matched: MatchedStage[] = [];
  for (const stageNumber of sortedSectionStageNumbers(sections)) {
    const section = sections[stageNumber];
    if (section?.status !== 'loaded') continue;
    const items = section.items.filter((item) =>
      fuzzyMatch(query, chapterSearchText(item, bodies, bodySearchActive)),
    );
    if (items.length > 0) matched.push({ stageNumber, items });
  }
  return matched;
}

/** Total chapters matched across every kept stage — feeds the result caption. */
function countMatches(matched: readonly MatchedStage[]): number {
  return matched.reduce((sum, stage) => sum + stage.items.length, 0);
}

interface SearchSweepStatusProps {
  /** True once the deep body search is confirmed; gates the sweep's status. */
  active: boolean;
  /** Current progress of the confirm-triggered body sweep. */
  status: BodySweepStatus;
  /** Re-run the sweep after a failure. */
  onRetry: () => void;
}

/**
 * A quiet inline status row shown beneath the search field while deep body
 * search is active: a "searching..." caption during the sweep, or a failure
 * caption plus a retry row if it rejected. It keeps the sweep's in-flight and
 * error states visible without leaving the results view.
 */
function SearchSweepStatus({
  active,
  status,
  onRetry,
}: SearchSweepStatusProps): React.JSX.Element | null {
  const { width } = useWindowDimensions();
  if (!active) return null;
  if (status === 'loading') {
    return (
      <View testID="course-drawer-search-loading" style={styles.searchStatusRow}>
        <ActivityIndicator size="small" color={accent.primary} />
        <Text style={[type(width).caption, styles.searchStatusText]}>{SEARCH_LOADING_LABEL}</Text>
      </View>
    );
  }
  if (status === 'error') {
    return (
      <View testID="course-drawer-search-error" style={styles.searchStatusBlock}>
        <Text style={[type(width).caption, styles.searchStatusText]}>{SEARCH_ERROR_LABEL}</Text>
        <DrawerItem
          testID="course-drawer-search-retry"
          label={SEARCH_RETRY_LABEL}
          onPress={onRetry}
        />
      </View>
    );
  }
  return null;
}

interface DrawerSearchFieldProps {
  /** Match count for the active query, or undefined to hide the caption. */
  resultCount?: number;
  /** True once the deep body search is confirmed; hides the confirm row. */
  bodySearchActive: boolean;
  /** Receives the debounced query (or '' on clear). */
  onQueryChange: (_query: string) => void;
  /** Confirm widening the search into chapter bodies. */
  onConfirmDeepSearch: () => void;
}

/**
 * The drawer's search field. The deep-search confirm row is offered only until
 * body search is active; because ``DrawerSearchProps`` is an exclusive union, we
 * branch the element rather than widen the props to keep the deep pair paired.
 */
function DrawerSearchField({
  resultCount,
  bodySearchActive,
  onQueryChange,
  onConfirmDeepSearch,
}: DrawerSearchFieldProps): React.JSX.Element {
  const shared = {
    testID: SEARCH_TESTID,
    placeholder: SEARCH_PLACEHOLDER,
    accessibilityLabel: SEARCH_ACCESSIBILITY_LABEL,
    resultCount,
    onQueryChange,
  };
  if (bodySearchActive) return <DrawerSearch {...shared} />;
  return (
    <DrawerSearch
      {...shared}
      onConfirmDeepSearch={onConfirmDeepSearch}
      deepSearchLabel={DEEP_SEARCH_LABEL}
    />
  );
}

interface CourseDrawerSearchState {
  query: string;
  bodySearchActive: boolean;
  isSearching: boolean;
  handleQueryChange: (_next: string) => void;
  handleConfirmDeepSearch: () => void;
}

/**
 * Own the drawer's search query and body-search gate. Clearing the query drops
 * back to title-only matching until body search is re-confirmed; confirming
 * flips the gate and asks the host to sweep the chapter bodies.
 */
function useCourseDrawerSearch(onConfirmBodySearch: () => void): CourseDrawerSearchState {
  const [query, setQuery] = useState('');
  const [bodySearchActive, setBodySearchActive] = useState(false);

  const handleQueryChange = useCallback((next: string) => {
    setQuery(next);
    if (next.length === 0) setBodySearchActive(false);
  }, []);

  const handleConfirmDeepSearch = useCallback(() => {
    setBodySearchActive(true);
    onConfirmBodySearch();
  }, [onConfirmBodySearch]);

  const isSearching = query.length > 0;
  return { query, bodySearchActive, isSearching, handleQueryChange, handleConfirmDeepSearch };
}

interface StageListProps {
  stageById: Map<number, Stage>;
  selectedStage: number;
  onChapterPress: (_stageNumber: number, _item: ContentItem) => void;
  onRetry: (_stageNumber: number) => void;
}

interface FullStageListProps extends StageListProps {
  stageNumbers: number[];
  sections: DrawerSections;
}

/** The unfiltered stage-grouped list shown when no query is active. */
function FullStageList({
  stageNumbers,
  sections,
  stageById,
  selectedStage,
  onChapterPress,
  onRetry,
}: FullStageListProps): React.JSX.Element {
  return (
    <View>
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

interface CourseSearchViewProps extends StageListProps {
  matched: MatchedStage[];
  bodySearchActive: boolean;
  sweepStatus: BodySweepStatus;
  onConfirmBodySearch: () => void;
}

/** The active-query view: the sweep-status row above the matched stage sections
 *  (each reuses ``StageSection`` for free header/selected/locked styling). */
function CourseSearchView({
  matched,
  stageById,
  selectedStage,
  bodySearchActive,
  sweepStatus,
  onChapterPress,
  onRetry,
  onConfirmBodySearch,
}: CourseSearchViewProps): React.JSX.Element {
  return (
    <View>
      <SearchSweepStatus
        active={bodySearchActive}
        status={sweepStatus}
        onRetry={onConfirmBodySearch}
      />
      {matched.map(({ stageNumber, items }) => (
        <StageSection
          key={stageNumber}
          stageNumber={stageNumber}
          stageById={stageById}
          section={{ status: 'loaded', items }}
          isSelected={stageNumber === selectedStage}
          onChapterPress={onChapterPress}
          onRetry={onRetry}
        />
      ))}
    </View>
  );
}

export interface CourseDrawerProps {
  /** Every stage in the course; only present stages render (gap numbers are skipped). */
  stages: Stage[];
  /** The stage currently shown on the screen, marked selected in the list. */
  selectedStage: number;
  /** Per-stage chapter load state, owned by :func:`useCourseDrawerContent`. */
  sections: DrawerSections;
  /** Cached chapter bodies (contentId to markdown), owned by :func:`useCourseDrawerBodies`. */
  bodies: Readonly<Record<number, string>>;
  /** Progress of the confirm-gated body sweep, owned by :func:`useCourseDrawerBodies`. */
  sweepStatus: BodySweepStatus;
  /** Select a stage, open the chapter, and close the drawer. */
  onChapterPress: (_stageNumber: number, _item: ContentItem) => void;
  /** Refetch a single failed stage's chapters. */
  onRetry: (_stageNumber: number) => void;
  /** Confirm the deep body search: the host sweeps every unlocked chapter body. */
  onConfirmBodySearch: () => void;
}

/** The stage-grouped table of contents for the Course header drawer, with a
 *  fuzzy chapter-title search and a confirm-gated body search on top. */
export default function CourseDrawer({
  stages,
  selectedStage,
  sections,
  bodies,
  sweepStatus,
  onChapterPress,
  onRetry,
  onConfirmBodySearch,
}: CourseDrawerProps): React.JSX.Element {
  const stageById = useMemo(() => new Map(stages.map((s) => [s.stage_number, s])), [stages]);
  const stageNumbers = useMemo(() => [...stageById.keys()].sort((a, b) => a - b), [stageById]);
  const { query, bodySearchActive, isSearching, handleQueryChange, handleConfirmDeepSearch } =
    useCourseDrawerSearch(onConfirmBodySearch);
  const matched = useMemo(
    () => matchStages(query, sections, bodies, bodySearchActive),
    [query, sections, bodies, bodySearchActive],
  );

  return (
    <View testID="course-drawer">
      <DrawerSearchField
        resultCount={isSearching ? countMatches(matched) : undefined}
        bodySearchActive={bodySearchActive}
        onQueryChange={handleQueryChange}
        onConfirmDeepSearch={handleConfirmDeepSearch}
      />
      {isSearching ? (
        <CourseSearchView
          matched={matched}
          stageById={stageById}
          selectedStage={selectedStage}
          bodySearchActive={bodySearchActive}
          sweepStatus={sweepStatus}
          onChapterPress={onChapterPress}
          onRetry={onRetry}
          onConfirmBodySearch={onConfirmBodySearch}
        />
      ) : (
        <FullStageList
          stageNumbers={stageNumbers}
          sections={sections}
          stageById={stageById}
          selectedStage={selectedStage}
          onChapterPress={onChapterPress}
          onRetry={onRetry}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  searchStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  searchStatusBlock: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    gap: SPACING.xs,
  },
  searchStatusText: {
    color: ink.muted,
  },
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
