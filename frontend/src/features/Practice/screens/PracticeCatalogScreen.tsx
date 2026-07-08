/**
 * ``PracticeCatalogScreen`` — top-level browse surface for every visible
 * practice (presets + the user's drafts + imported drafts).
 *
 * Apply ALL custom-practices-07 UX guard-rails:
 *
 *   1. Mode category filter chips — never a flat 11-mode list.
 *   2. ``+ Create`` is the primary CTA and recommends starting from a
 *      preset; the wizard handles that recommendation in step 0.
 *   3. Per-stage filter — defaults to the user's current stage.
 *   4. Sections (Presets / My drafts / Imported) so the catalog can
 *      grow without collapsing into one giant scroll.
 *   5. Search by name + description.
 *
 * The backend's ``GET /practices/`` requires ``stage_number``, so the
 * catalog pages one stage at a time and the stage chip is the primary
 * navigation rather than an optional filter.
 */

import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type PracticeItem, practices, userPractices } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  ink,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';
import { LoadErrorRetry, LoadingBlock } from '@/features/Practice/components/LoadErrorRetry';
import { MODE_CATEGORIES, type PickableMode } from '@/features/Practice/components/ModePicker';
import { MIN_STAGE, stageRange } from '@/features/Practice/constants';
import { useRecentPractices } from '@/features/Practice/hooks/useRecentPractices';
import { formatDuration } from '@/features/Practice/utils/formatDuration';
import type { RootStackParamList } from '@/navigation/RootStack';
import type { RecentPractice } from '@/storage/recentPracticesStorage';

type Section = 'presets' | 'drafts' | 'imported';

interface CatalogProps {
  /** Stage to seed the chip filter with; defaults to ``1``. */
  initialStage?: number;
  /** Override for tests so the catalog doesn't poke the live API. */
  loadPractices?: (stageNumber: number) => Promise<PracticeItem[]>;
  /** Override for tests; otherwise wires through ``RootStack`` navigator. */
  navigateToDetail?: (practiceId: number) => void;
  /** Override for tests; otherwise opens ``CreatePractice``. */
  navigateToCreate?: () => void;
  /** Override for tests; otherwise sets the active practice via the API. */
  setActive?: (practiceId: number, stageNumber: number) => Promise<void>;
}

interface CatalogState {
  practices: PracticeItem[];
  loading: boolean;
  error: string | null;
}

/**
 * Top-level catalog. Defaults to stage 1 so the screen renders something
 * before the user picks a chip; pass ``initialStage`` to align with the
 * user's current stage when this screen is the catalog tab.
 */
export function PracticeCatalogScreen(props: CatalogProps = {}): React.JSX.Element {
  // Destructure so the useCallback deps below are stable field refs, not the
  // ``props`` object (a fresh ref each render that would defeat memoization).
  const { initialStage, loadPractices, navigateToDetail, navigateToCreate, setActive } = props;
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const seededStage = useSeededStage(initialStage);
  const [stageNumber, setStageNumber] = useState(seededStage);
  const [modeCategory, setModeCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [state, reload] = useCatalog(stageNumber, loadPractices);

  const { onDetail, onCreate } = useCatalogNavigation(
    navigation,
    navigateToDetail,
    navigateToCreate,
  );
  const setActivePractice = useCatalogSetActive(stageNumber, navigation, setActive);
  const { recents, record } = useRecentPractices();
  const onUse = useRecordedUse(setActivePractice, record);
  const { sections, renderItem } = useCatalogList(state, query, modeCategory, onDetail, onUse);
  const insets = useSafeAreaInsets();
  const containerStyle = [styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }];

  return (
    <View style={containerStyle} testID="practice-catalog-safe-area">
      <SectionList<PracticeItem, CatalogSection>
        testID="practice-catalog-screen"
        sections={state.loading || state.error !== null ? [] : sections}
        keyExtractor={catalogKeyExtractor}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        renderSectionFooter={makeSectionFooter(onCreate, sections)}
        ListHeaderComponent={
          <CatalogHeader
            query={query}
            onQueryChange={setQuery}
            stageNumber={stageNumber}
            onStage={setStageNumber}
            modeCategory={modeCategory}
            onMode={setModeCategory}
            onCreate={onCreate}
            recents={recents}
            onDetail={onDetail}
          />
        }
        ListFooterComponent={<CatalogStatus state={state} onRetry={reload} />}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
      />
    </View>
  );
}

/** "Use this practice" — snapshot it into the recents list, then set it active. */
function useRecordedUse(
  setActivePractice: (id: number) => void,
  record: (_entry: RecentPractice) => void,
): (practice: PracticeItem) => void {
  return useCallback(
    (practice: PracticeItem) => {
      record(toRecentPractice(practice));
      setActivePractice(practice.id);
    },
    [record, setActivePractice],
  );
}

/** Snapshot a catalog item into the persisted recent-practice shape. */
function toRecentPractice(practice: PracticeItem): RecentPractice {
  return {
    id: practice.id,
    name: practice.name,
    mode: practice.mode ?? null,
    durationMinutes: practice.default_duration_minutes,
  };
}

/** Seed the stage chip: an explicit prop (tests) wins, else the ``Catalog``
 * route param when pushed from the Practice screen, else the first stage.
 *
 * Always calls ``useRoute`` (hooks can't be conditional), so a render outside a
 * navigator must mock it — the prop path alone does not skip the hook. */
function useSeededStage(initialStage: number | undefined): number {
  const route = useRoute<RouteProp<RootStackParamList, 'Catalog'>>();
  return initialStage ?? route.params?.stageNumber ?? MIN_STAGE;
}

/** Memoized SectionList inputs: the bucketed sections + a stable row renderer
 * (kept stable so search keystrokes / chip toggles don't re-render every row). */
function useCatalogList(
  state: CatalogState,
  query: string,
  modeCategory: string | null,
  onDetail: (id: number) => void,
  onUse: (practice: PracticeItem) => void,
): { sections: CatalogSection[]; renderItem: (info: { item: PracticeItem }) => React.JSX.Element } {
  const sections = useMemo(
    () => buildSections(state.practices, query, modeCategory),
    [state.practices, query, modeCategory],
  );
  const renderItem = useCallback(
    ({ item }: { item: PracticeItem }) => (
      <PracticeRow practice={item} onDetail={onDetail} onUse={onUse} />
    ),
    [onDetail, onUse],
  );
  return { sections, renderItem };
}

/** One-tap "use this practice" — set it active for the catalog's current stage,
 * then return to the Practice screen. Errors surface in an alert. */
function useCatalogSetActive(
  stageNumber: number,
  navigation: NativeStackNavigationProp<RootStackParamList>,
  override: CatalogProps['setActive'],
): (id: number) => void {
  return useCallback(
    (id: number) => {
      void (async () => {
        try {
          if (override) {
            await override(id, stageNumber);
          } else {
            await userPractices.create({ practice_id: id, stage_number: stageNumber });
          }
          navigation.goBack();
        } catch (err) {
          Alert.alert('Could not set practice', formatApiError(err, { fallback: 'Try again.' }));
        }
      })();
    },
    [stageNumber, navigation, override],
  );
}

function useCatalogNavigation(
  navigation: NativeStackNavigationProp<RootStackParamList>,
  navigateToDetail: CatalogProps['navigateToDetail'],
  navigateToCreate: CatalogProps['navigateToCreate'],
): { onDetail: (id: number) => void; onCreate: () => void } {
  const onDetail = useCallback(
    (id: number) =>
      navigateToDetail
        ? navigateToDetail(id)
        : navigation.navigate('PracticeDetail', { practiceId: id }),
    [navigation, navigateToDetail],
  );
  const onCreate = useCallback(
    () => (navigateToCreate ? navigateToCreate() : navigation.navigate('CreatePractice')),
    [navigation, navigateToCreate],
  );
  return { onDetail, onCreate };
}

interface CatalogSection {
  section: Section;
  title: string;
  data: readonly PracticeItem[];
}

const catalogKeyExtractor = (item: PracticeItem): string => `practice-${item.id}`;

const renderSectionHeader = ({ section }: { section: CatalogSection }): React.JSX.Element | null =>
  section.data.length === 0 ? null : (
    <View style={styles.section} testID={`practice-catalog-section-${section.section}`}>
      <Text style={styles.sectionTitle}>{section.title}</Text>
    </View>
  );

interface SectionFooterProps {
  section: Section;
  onCreate: () => void;
}

const SECTION_EMPTY_COPY: Readonly<Record<Section, { title: string; body: string }>> = {
  presets: { title: 'No presets here', body: 'No curated practices match this filter yet.' },
  drafts: { title: 'No drafts yet', body: 'Author a practice and it lands here.' },
  imported: { title: 'Nothing imported', body: 'Practices shared with you will appear here.' },
};

/**
 * An empty catalog section reads as an editorial empty state that points to the
 * create wizard, rather than the old passive "Nothing here yet." line.
 *
 * The empty-state footer only renders when the WHOLE visible catalog is empty:
 * once any sibling section has rows, an empty section shows nothing so its
 * footer can't stack over and swallow taps on the populated list.
 */
function makeSectionFooter(
  onCreate: () => void,
  sections: readonly CatalogSection[],
): (info: { section: CatalogSection }) => React.JSX.Element | null {
  const allEmpty = sections.every((s) => s.data.length === 0);
  return ({ section }) =>
    allEmpty && section.data.length === 0 ? (
      <SectionFooter section={section.section} onCreate={onCreate} />
    ) : null;
}

const SectionFooter = ({ section, onCreate }: SectionFooterProps): React.JSX.Element | null => {
  const copy = SECTION_EMPTY_COPY[section];
  return (
    <EmptyState
      inline
      glyph="🪶"
      title={copy.title}
      body={copy.body}
      style={styles.sectionEmpty}
      testID={`practice-catalog-section-${section}-empty`}
      cta={
        <Button
          variant="secondary"
          label="Create a practice"
          onPress={onCreate}
          testID={`practice-catalog-section-${section}-create`}
        />
      }
    />
  );
};

/** Build the three catalog sections (always present, even when empty). */
function buildSections(
  items: readonly PracticeItem[],
  query: string,
  modeCategory: string | null,
): CatalogSection[] {
  const buckets = bucketSections(applyFilters(items, query, modeCategory));
  return [
    { section: 'presets', title: 'Presets', data: buckets.presets },
    { section: 'drafts', title: 'My drafts', data: buckets.drafts },
    { section: 'imported', title: 'Imported', data: buckets.imported },
  ];
}

interface CatalogHeaderProps {
  query: string;
  onQueryChange: (next: string) => void;
  stageNumber: number;
  onStage: (stage: number) => void;
  modeCategory: string | null;
  onMode: (category: string | null) => void;
  onCreate: () => void;
  recents: readonly RecentPractice[];
  onDetail: (id: number) => void;
}

/** Non-scrolling-away header for the SectionList (kept as an element so the
 * search TextInput keeps focus across re-renders). */
const CatalogHeader = (props: CatalogHeaderProps): React.JSX.Element => (
  <View>
    <Header onCreate={props.onCreate} />
    <SearchBar value={props.query} onChange={props.onQueryChange} />
    <StageChips selected={props.stageNumber} onSelect={props.onStage} />
    <ModeChips selected={props.modeCategory} onSelect={props.onMode} />
    <RecentlyUsed recents={props.recents} onDetail={props.onDetail} />
  </View>
);

interface RecentlyUsedProps {
  recents: readonly RecentPractice[];
  onDetail: (id: number) => void;
}

/** A quick "Recently used" shortcut above the full catalog; hidden when empty. */
const RecentlyUsed = ({ recents, onDetail }: RecentlyUsedProps): React.JSX.Element | null => {
  if (recents.length === 0) return null;
  return (
    <View style={styles.section} testID="practice-catalog-recently-used">
      <Text style={styles.sectionTitle}>Recently used</Text>
      {recents.map((recent) => (
        <RecentRow key={`recent-${recent.id}`} recent={recent} onDetail={onDetail} />
      ))}
    </View>
  );
};

interface RecentRowProps {
  recent: RecentPractice;
  onDetail: (id: number) => void;
}

const RecentRow = ({ recent, onDetail }: RecentRowProps): React.JSX.Element => {
  const mode = (recent.mode ?? 'meditation_timer') as PickableMode;
  const { label, icon } = MODE_PRESENTATION[mode] ?? FALLBACK_PRESENTATION;
  const rounded = Math.round(recent.durationMinutes);
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`${recent.name}. ${label}, ${rounded} minutes.`}
      onPress={() => onDetail(recent.id)}
      style={[styles.row, styles.recentRow]}
      testID={`practice-catalog-recent-row-${recent.id}`}
    >
      <Text style={styles.rowIcon}>{icon}</Text>
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {recent.name}
        </Text>
        <Text style={styles.rowSubtitle}>{`${label} · ${formatDuration(rounded)}`}</Text>
      </View>
    </TouchableOpacity>
  );
};

interface CatalogStatusProps {
  state: CatalogState;
  onRetry: () => void;
}

/** Loading spinner / error block rendered below the header while the list is empty. */
const CatalogStatus = ({ state, onRetry }: CatalogStatusProps): React.JSX.Element | null => {
  if (state.loading) {
    return (
      <LoadingBlock
        style={styles.loadingBlock}
        color={accent.primary}
        testID="practice-catalog-loading"
      />
    );
  }
  if (state.error !== null) {
    return (
      <LoadErrorRetry
        message={state.error}
        onRetry={onRetry}
        containerStyle={styles.errorBlock}
        containerTestID="practice-catalog-error"
        messageStyle={styles.errorText}
        retryStyle={styles.retryButton}
        retryTextStyle={styles.retryButtonText}
        retryTestID="practice-catalog-retry"
        retryAccessibilityLabel="Retry"
      />
    );
  }
  return null;
};

function useCatalog(
  stageNumber: number,
  loadPractices: CatalogProps['loadPractices'],
): [CatalogState, () => void] {
  const [state, setState] = useState<CatalogState>({
    practices: [],
    loading: true,
    error: null,
  });

  const runReload = useCallback(async () => {
    try {
      const list = loadPractices
        ? await loadPractices(stageNumber)
        : await practices.listAll({ stageNumber, includeMine: true });
      setState({ practices: list, loading: false, error: null });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: formatApiError(err, { fallback: 'Could not load the catalog.' }),
      }));
    }
  }, [stageNumber, loadPractices]);

  const reload = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    void runReload();
  }, [runReload]);

  useEffect(() => {
    reload();
  }, [reload]);

  return [state, reload];
}

interface HeaderProps {
  onCreate: () => void;
}

const Header = ({ onCreate }: HeaderProps): React.JSX.Element => (
  <ScreenHeader
    eyebrow="Practice"
    title="Catalog"
    lead="Browse every practice, or author your own."
    action={
      <Button
        label="+ Create"
        accessibilityLabel="Create a new practice"
        onPress={onCreate}
        testID="practice-catalog-create"
      />
    }
  />
);

interface SearchBarProps {
  value: string;
  onChange: (next: string) => void;
}

const SearchBar = ({ value, onChange }: SearchBarProps): React.JSX.Element => (
  <TextInput
    accessibilityLabel="Search practices by name or description"
    style={styles.search}
    placeholder="Search by name or description"
    placeholderTextColor={ink.muted}
    value={value}
    onChangeText={onChange}
    testID="practice-catalog-search"
  />
);

interface StageChipsProps {
  selected: number;
  onSelect: (stage: number) => void;
}

const StageChips = ({ selected, onSelect }: StageChipsProps): React.JSX.Element => {
  const stages = stageRange();
  return (
    <View style={styles.chipRow} testID="practice-catalog-stage-chips">
      {stages.map((n) => (
        <FilterChip
          key={n}
          label={`Stage ${n}`}
          selected={selected === n}
          onPress={() => onSelect(n)}
          testID={`practice-catalog-stage-${n}`}
        />
      ))}
    </View>
  );
};

interface ModeChipsProps {
  selected: string | null;
  onSelect: (category: string | null) => void;
}

const ModeChips = ({ selected, onSelect }: ModeChipsProps): React.JSX.Element => (
  <View style={styles.chipRow} testID="practice-catalog-mode-chips">
    <FilterChip
      label="All"
      selected={selected === null}
      onPress={() => onSelect(null)}
      testID="practice-catalog-mode-all"
    />
    {MODE_CATEGORIES.map((category) => (
      <FilterChip
        key={category.key}
        label={category.title}
        selected={selected === category.key}
        onPress={() => onSelect(category.key)}
        testID={`practice-catalog-mode-${category.key}`}
      />
    ))}
  </View>
);

interface FilterChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}

const FilterChip = ({ label, selected, onPress, testID }: FilterChipProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ selected }}
    onPress={onPress}
    style={[styles.chip, selected && styles.chipSelected]}
    testID={testID}
  >
    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
  </TouchableOpacity>
);

interface PracticeRowProps {
  practice: PracticeItem;
  onDetail: (id: number) => void;
  onUse: (practice: PracticeItem) => void;
}

// Derived from MODE_CATEGORIES so adding a mode propagates here automatically.
const MODE_PRESENTATION: Readonly<Record<PickableMode, { label: string; icon: string }>> =
  Object.fromEntries(
    MODE_CATEGORIES.flatMap((category) =>
      category.modes.map((entry) => [entry.mode, { label: entry.label, icon: entry.icon }]),
    ),
  ) as Record<PickableMode, { label: string; icon: string }>;

const FALLBACK_PRESENTATION = { label: 'Practice', icon: '🧘' } as const;

const PracticeRowComponent = ({
  practice,
  onDetail,
  onUse,
}: PracticeRowProps): React.JSX.Element => {
  const mode = (practice.mode ?? 'meditation_timer') as PickableMode;
  const { label, icon } = MODE_PRESENTATION[mode] ?? FALLBACK_PRESENTATION;
  const rounded = Math.round(practice.default_duration_minutes);
  const subtitle = `${label} · ${formatDuration(rounded)}`;
  // Spoken label avoids the visual "·" separator and spells out "minutes"
  // (abbreviations + glyphs read poorly under VoiceOver/TalkBack).
  const a11yLabel = `${practice.name}. ${label}, ${rounded} minutes.`;
  return (
    <View style={styles.rowContainer} testID={`practice-catalog-row-${practice.id}-container`}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        onPress={() => onDetail(practice.id)}
        style={styles.row}
        testID={`practice-catalog-row-${practice.id}`}
      >
        {/* Decorative; TouchableOpacity merges children, so screen readers use accessibilityLabel. */}
        <Text style={styles.rowIcon} testID={`practice-catalog-row-${practice.id}-icon`}>
          {icon}
        </Text>
        <View style={styles.rowText}>
          <Text style={styles.rowName} numberOfLines={1}>
            {practice.name}
          </Text>
          <Text style={styles.rowSubtitle}>{subtitle}</Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Use ${practice.name}`}
        onPress={() => onUse(practice)}
        style={styles.rowUse}
        testID={`practice-catalog-row-${practice.id}-use`}
      >
        <Text style={styles.rowUseText}>Use</Text>
      </TouchableOpacity>
    </View>
  );
};

// Memoized so SectionList windowing + a stable ``onDetail`` keep unchanged rows
// from re-rendering on search keystrokes or chip toggles.
const PracticeRow = React.memo(PracticeRowComponent);

function applyFilters(
  items: readonly PracticeItem[],
  query: string,
  modeCategory: string | null,
): readonly PracticeItem[] {
  const needle = query.trim().toLowerCase();
  const modes = modeCategory === null ? null : modesInCategory(modeCategory);
  return items.filter((item) => {
    if (needle.length > 0) {
      const haystack = `${item.name} ${item.description}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (modes !== null) {
      const mode = (item.mode ?? 'meditation_timer') as PickableMode;
      if (!modes.has(mode)) return false;
    }
    return true;
  });
}

function modesInCategory(categoryKey: string): Set<PickableMode> {
  const category = MODE_CATEGORIES.find((c) => c.key === categoryKey);
  return new Set(category?.modes.map((m) => m.mode) ?? []);
}

interface SectionBuckets {
  presets: readonly PracticeItem[];
  drafts: readonly PracticeItem[];
  imported: readonly PracticeItem[];
}

/**
 * Bucket the catalog rows into the three sections the screen renders.
 *
 * ``approved=True`` rows are presets — the curated catalog. Unapproved
 * rows are the user's own drafts (the backend only surfaces unapproved
 * rows when the caller is the submitter; see
 * ``GET /practices/?include_mine=true``). The "Imported" section lands
 * empty today: distinguishing imported drafts requires a Practice column
 * that custom-practices-03 will add when share-link recipients can
 * receive a copy under their own user id.
 */
function bucketSections(items: readonly PracticeItem[]): SectionBuckets {
  const presets: PracticeItem[] = [];
  const drafts: PracticeItem[] = [];
  const imported: readonly PracticeItem[] = [];
  for (const item of items) {
    if (item.approved) {
      presets.push(item);
    } else {
      drafts.push(item);
    }
  }
  return { presets, drafts, imported };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.canvas },
  body: { padding: SPACING.md, paddingBottom: SPACING.xl },
  search: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    fontSize: 14,
    color: ink.primary,
    backgroundColor: surface.raised,
    marginBottom: SPACING.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginBottom: SPACING.sm,
  },
  chip: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: surface.hairline,
    backgroundColor: surface.raised,
  },
  chipSelected: { backgroundColor: accent.primary, borderColor: accent.primary },
  chipText: { fontSize: 12, color: ink.primary, fontWeight: '600' },
  chipTextSelected: { color: accent.onPrimary },
  loadingBlock: { padding: SPACING.lg, alignItems: 'center' },
  errorBlock: { padding: SPACING.lg, alignItems: 'center', gap: SPACING.sm },
  errorText: { color: colors.destructive.text, fontSize: 13 },
  retryButton: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: surface.raised,
    borderWidth: 1,
    borderColor: surface.hairline,
  },
  retryButtonText: { color: ink.primary, fontWeight: '600' },
  section: { marginTop: SPACING.md },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: ink.soft,
    textTransform: 'uppercase',
    marginBottom: SPACING.sm,
  },
  sectionEmpty: { paddingVertical: SPACING.md, gap: SPACING.sm },
  rowContainer: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    ...surfaceShadow.card,
  },
  recentRow: { marginBottom: SPACING.sm },
  rowUse: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    backgroundColor: accent.primary,
    borderRadius: BORDER_RADIUS.lg,
    ...surfaceShadow.card,
  },
  rowUseText: { color: accent.onPrimary, fontWeight: '700', fontSize: 14 },
  rowIcon: { fontSize: 24, width: 32, textAlign: 'center' },
  rowText: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: '700', color: ink.primary },
  rowSubtitle: {
    fontSize: 13,
    color: ink.soft,
    marginTop: 2,
  },
});

export default PracticeCatalogScreen;
