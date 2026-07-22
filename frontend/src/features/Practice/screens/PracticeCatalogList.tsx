/**
 * ``PracticeCatalogList`` — the catalog list body shared by the pushed
 * ``PracticeCatalogScreen`` (light) and the Practice player's embedded
 * Catalog tab (dark). Browsable surface for every visible practice
 * (presets + the user's drafts + imported drafts).
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
 *
 * The ``dark`` variant renders transparently over the host's umber ground and
 * recolors section titles for it; the light editorial header (with the
 * ``+ Create`` CTA) is a light-variant-only affordance. Everything else —
 * search, chips, rows, the copy dialog — is identical in both variants.
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
  onShowcase,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';
import CopyToStageDialog from '@/features/Practice/components/CopyToStageDialog';
import { LoadErrorRetry, LoadingBlock } from '@/features/Practice/components/LoadErrorRetry';
import {
  MODE_CATEGORIES,
  resolvePickableMode,
  type PickableMode,
} from '@/features/Practice/components/ModePicker';
import StageSelector from '@/features/Practice/components/StageSelector';
import { MIN_STAGE } from '@/features/Practice/constants';
import { useRecentPractices } from '@/features/Practice/hooks/useRecentPractices';
import { copyPracticeToStage } from '@/features/Practice/utils/copyPracticeToStage';
import { formatDuration } from '@/features/Practice/utils/formatDuration';
import type { RootStackParamList } from '@/navigation/RootStack';
import type { RecentPractice } from '@/storage/recentPracticesStorage';

type Section = 'presets' | 'drafts' | 'imported';

/** Ground the list renders on: ``light`` paper (pushed) or the ``dark`` player. */
export type CatalogVariant = 'light' | 'dark';

export interface CatalogProps {
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

export interface CatalogListProps extends CatalogProps {
  /** Rendering ground; defaults to ``light`` (the pushed route). */
  variant?: CatalogVariant;
  /** Runs after a practice is activated; defaults to popping the pushed route. */
  onActivated?: () => void;
}

interface CatalogState {
  practices: PracticeItem[];
  loading: boolean;
  error: string | null;
}

interface CatalogScreenModel {
  stageNumber: number;
  setStageNumber: (stage: number) => void;
  modeCategory: string | null;
  setModeCategory: (category: string | null) => void;
  query: string;
  setQuery: (query: string) => void;
  state: CatalogState;
  reload: () => void;
  onDetail: (id: number) => void;
  onCreate: () => void;
  recents: readonly RecentPractice[];
  catalogUse: CatalogUse;
  sections: CatalogSection[];
  renderItem: (info: { item: PracticeItem }) => React.JSX.Element;
}

/** Resolve the post-activation continuation: the caller's override when
 * embedded, else pop the pushed route (the historical default). */
function useActivatedHandler(
  onActivated: (() => void) | undefined,
  navigation: NativeStackNavigationProp<RootStackParamList>,
): () => void {
  return useCallback(() => {
    if (onActivated) {
      onActivated();
    } else {
      navigation.goBack();
    }
  }, [onActivated, navigation]);
}

/** Wires the catalog's filter state, data, navigation, and copy flow. */
function useCatalogScreen(props: CatalogListProps): CatalogScreenModel {
  const {
    initialStage,
    loadPractices,
    navigateToDetail,
    navigateToCreate,
    setActive,
    onActivated,
  } = props;
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
  const handleActivated = useActivatedHandler(onActivated, navigation);
  const setActivePractice = useCatalogSetActive(stageNumber, handleActivated, setActive);
  const { recents, record } = useRecentPractices();
  const catalogUse = useCatalogUse(stageNumber, handleActivated, record, setActivePractice);
  const { sections, renderItem } = useCatalogList(
    state,
    query,
    modeCategory,
    onDetail,
    catalogUse.onUse,
  );

  return {
    stageNumber,
    setStageNumber,
    modeCategory,
    setModeCategory,
    query,
    setQuery,
    state,
    reload,
    onDetail,
    onCreate,
    recents,
    catalogUse,
    sections,
    renderItem,
  };
}

/** The cross-stage confirm-and-copy dialog, rendered only while a copy is offered. */
function CatalogCopyDialog({ use }: { use: CatalogUse }): React.JSX.Element | null {
  if (use.copyState === null) return null;
  return (
    <CopyToStageDialog
      visible
      practiceName={use.copyState.practice.name}
      homeStage={use.copyState.practice.stage_number}
      targetStage={use.copyState.targetStage}
      busy={use.busy}
      onConfirm={use.confirmCopy}
      onCancel={use.cancelCopy}
    />
  );
}

/** The catalog list body: the sectioned list plus its copy dialog. */
export default function PracticeCatalogList(props: CatalogListProps): React.JSX.Element {
  const s = useCatalogScreen(props);
  const variant = props.variant ?? 'light';
  const renderSectionHeader = useMemo(() => makeSectionHeader(variant), [variant]);

  return (
    <>
      <SectionList<PracticeItem, CatalogSection>
        testID="practice-catalog-screen"
        sections={s.state.loading || s.state.error !== null ? [] : s.sections}
        keyExtractor={catalogKeyExtractor}
        renderItem={s.renderItem}
        renderSectionHeader={renderSectionHeader}
        renderSectionFooter={makeSectionFooter(s.onCreate, s.sections)}
        ListHeaderComponent={
          <CatalogHeader
            variant={variant}
            query={s.query}
            onQueryChange={s.setQuery}
            stageNumber={s.stageNumber}
            onStage={s.setStageNumber}
            modeCategory={s.modeCategory}
            onMode={s.setModeCategory}
            onCreate={s.onCreate}
            recents={s.recents}
            onDetail={s.onDetail}
          />
        }
        ListFooterComponent={<CatalogStatus state={s.state} onRetry={s.reload} />}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
      />
      <CatalogCopyDialog use={s.catalogUse} />
    </>
  );
}

interface CopyDialogState {
  practice: PracticeItem;
  targetStage: number;
}

interface CatalogUse {
  onUse: (practice: PracticeItem) => void;
  copyState: CopyDialogState | null;
  busy: boolean;
  confirmCopy: (name: string) => void;
  cancelCopy: () => void;
}

/** Create the copy draft under the edited name, record it, and hand control
 * back via ``onActivated``; an error keeps the user in place behind an alert. */
async function runCatalogCopy(
  active: CopyDialogState,
  name: string,
  record: (_entry: RecentPractice) => void,
  onActivated: () => void,
): Promise<void> {
  try {
    const draft = await copyPracticeToStage(active.practice, active.targetStage, name);
    record(toRecentPractice(draft));
    onActivated();
  } catch (err) {
    Alert.alert('Could not set practice', formatApiError(err, { fallback: 'Try again.' }));
  }
}

/**
 * One-tap "Use" for a catalog row. When the row's home stage matches the stage
 * being browsed, it snapshots into recents and assigns directly (today's
 * behaviour). When the stages differ, it opens a declinable confirm-and-copy
 * dialog: confirming creates a user-owned copy at the browsing stage.
 */
function useCatalogUse(
  stageNumber: number,
  onActivated: () => void,
  record: (_entry: RecentPractice) => void,
  setActivePractice: (id: number) => void,
): CatalogUse {
  const [copyState, setCopyState] = useState<CopyDialogState | null>(null);
  const [busy, setBusy] = useState(false);

  const onUse = useCallback(
    (practice: PracticeItem) => {
      if (practice.stage_number === stageNumber) {
        record(toRecentPractice(practice));
        setActivePractice(practice.id);
        return;
      }
      setCopyState({ practice, targetStage: stageNumber });
    },
    [stageNumber, record, setActivePractice],
  );

  const cancelCopy = useCallback(() => setCopyState(null), []);

  const confirmCopy = useCallback(
    (name: string) => {
      if (copyState === null || busy) return;
      setBusy(true);
      void runCatalogCopy(copyState, name, record, onActivated).finally(() => {
        setBusy(false);
        setCopyState(null);
      });
    },
    [copyState, busy, record, onActivated],
  );

  return { onUse, copyState, busy, confirmCopy, cancelCopy };
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
 * then run ``onActivated``. Errors surface in an alert. */
function useCatalogSetActive(
  stageNumber: number,
  onActivated: () => void,
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
          onActivated();
        } catch (err) {
          Alert.alert('Could not set practice', formatApiError(err, { fallback: 'Try again.' }));
        }
      })();
    },
    [stageNumber, onActivated, override],
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

/** Section headers read in paper ink on the light ground, showcase ink on dark. */
function makeSectionHeader(
  variant: CatalogVariant,
): (info: { section: CatalogSection }) => React.JSX.Element | null {
  const titleStyle = [styles.sectionTitle, variant === 'dark' && styles.sectionTitleDark];
  return ({ section }) =>
    section.data.length === 0 ? null : (
      <View style={styles.section} testID={`practice-catalog-section-${section.section}`}>
        <Text style={titleStyle}>{section.title}</Text>
      </View>
    );
}

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
  variant: CatalogVariant;
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
 * search TextInput keeps focus across re-renders). The light editorial header
 * belongs to the pushed route; the dark player supplies its own identity. */
const CatalogHeader = (props: CatalogHeaderProps): React.JSX.Element => (
  <View>
    {props.variant === 'light' && <Header onCreate={props.onCreate} />}
    <SearchBar value={props.query} onChange={props.onQueryChange} />
    <StageChips selected={props.stageNumber} onSelect={props.onStage} />
    <ModeChips selected={props.modeCategory} onSelect={props.onMode} />
    <RecentlyUsed variant={props.variant} recents={props.recents} onDetail={props.onDetail} />
  </View>
);

interface RecentlyUsedProps {
  variant: CatalogVariant;
  recents: readonly RecentPractice[];
  onDetail: (id: number) => void;
}

/** A quick "Recently used" shortcut above the full catalog; hidden when empty. */
const RecentlyUsed = ({
  variant,
  recents,
  onDetail,
}: RecentlyUsedProps): React.JSX.Element | null => {
  if (recents.length === 0) return null;
  return (
    <View style={styles.section} testID="practice-catalog-recently-used">
      <Text style={[styles.sectionTitle, variant === 'dark' && styles.sectionTitleDark]}>
        Recently used
      </Text>
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
  const mode = resolvePickableMode(recent.mode);
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

const StageChips = ({ selected, onSelect }: StageChipsProps): React.JSX.Element => (
  <StageSelector
    variant="filter"
    selectedStage={selected}
    onSelect={onSelect}
    formatLabel={(n) => `Stage ${n}`}
    testIDPrefix="practice-catalog-stage"
    rowTestID="practice-catalog-stage-chips"
    rowStyle={styles.stageChipsRow}
  />
);

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
  const mode = resolvePickableMode(practice.mode);
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
      const mode = resolvePickableMode(item.mode);
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
  stageChipsRow: { marginBottom: SPACING.sm },
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
  sectionTitleDark: { color: onShowcase.soft },
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
