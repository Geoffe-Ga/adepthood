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

import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { type PracticeItem, practices } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';
import { MODE_CATEGORIES, type PickableMode } from '@/features/Practice/components/ModePicker';
import { MAX_STAGE, MIN_STAGE } from '@/features/Practice/constants';
import type { RootStackParamList } from '@/navigation/RootStack';

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
  // Destructure each prop the callbacks below depend on so the
  // ``useCallback`` dependency arrays are stable refs instead of the
  // ``props`` object (which is a new reference on every render and
  // would silently invalidate every memoization).
  const { initialStage, loadPractices, navigateToDetail, navigateToCreate } = props;
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [stageNumber, setStageNumber] = useState(initialStage ?? MIN_STAGE);
  const [modeCategory, setModeCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [state, reload] = useCatalog(stageNumber, loadPractices);

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

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body} testID="practice-catalog-screen">
        <Header onCreate={onCreate} />
        <SearchBar value={query} onChange={setQuery} />
        <StageChips selected={stageNumber} onSelect={setStageNumber} />
        <ModeChips selected={modeCategory} onSelect={setModeCategory} />
        <CatalogBody
          state={state}
          query={query}
          modeCategory={modeCategory}
          onDetail={onDetail}
          onRetry={reload}
        />
      </ScrollView>
    </View>
  );
}

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
        : await practices.list({ stageNumber, includeMine: true });
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
  <View style={styles.header}>
    <View>
      <Text style={styles.heading}>Practice catalog</Text>
      <Text style={styles.subheading}>Browse every practice, or author your own.</Text>
    </View>
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Create a new practice"
      onPress={onCreate}
      style={styles.createButton}
      testID="practice-catalog-create"
    >
      <Text style={styles.createButtonText}>+ Create</Text>
    </TouchableOpacity>
  </View>
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
    placeholderTextColor={colors.text.tertiaryAccessible}
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
  const stages = Array.from({ length: MAX_STAGE - MIN_STAGE + 1 }, (_, i) => MIN_STAGE + i);
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

interface CatalogBodyProps {
  state: CatalogState;
  query: string;
  modeCategory: string | null;
  onDetail: (id: number) => void;
  onRetry: () => void;
}

const CatalogBody = (props: CatalogBodyProps): React.JSX.Element => {
  if (props.state.loading) {
    return (
      <View style={styles.loadingBlock} testID="practice-catalog-loading">
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (props.state.error !== null) {
    return (
      <View style={styles.errorBlock} testID="practice-catalog-error">
        <Text style={styles.errorText}>{props.state.error}</Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Retry"
          onPress={props.onRetry}
          style={styles.retryButton}
          testID="practice-catalog-retry"
        >
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }
  const filtered = applyFilters(props.state.practices, props.query, props.modeCategory);
  const sections = bucketSections(filtered);
  return (
    <View testID="practice-catalog-sections">
      <SectionView
        title="Presets"
        section="presets"
        items={sections.presets}
        onDetail={props.onDetail}
      />
      <SectionView
        title="My drafts"
        section="drafts"
        items={sections.drafts}
        onDetail={props.onDetail}
      />
      <SectionView
        title="Imported"
        section="imported"
        items={sections.imported}
        onDetail={props.onDetail}
      />
    </View>
  );
};

interface SectionViewProps {
  title: string;
  section: Section;
  items: readonly PracticeItem[];
  onDetail: (id: number) => void;
}

const SectionView = ({ title, section, items, onDetail }: SectionViewProps): React.JSX.Element => (
  <View style={styles.section} testID={`practice-catalog-section-${section}`}>
    <Text style={styles.sectionTitle}>{title}</Text>
    {items.length === 0 ? (
      <Text style={styles.emptyText} testID={`practice-catalog-section-${section}-empty`}>
        Nothing here yet.
      </Text>
    ) : (
      items.map((p) => <PracticeRow key={p.id} practice={p} onPress={() => onDetail(p.id)} />)
    )}
  </View>
);

interface PracticeRowProps {
  practice: PracticeItem;
  onPress: () => void;
}

/**
 * Friendly presentation (human label + emoji anchor) for every mode,
 * derived from the single source the wizard already uses. Showing the raw
 * ``meditation_timer`` identifier reads as a database dump; the icon gives
 * each row a calm visual anchor and the label is plain English.
 */
const MODE_PRESENTATION: Readonly<Record<PickableMode, { label: string; icon: string }>> =
  Object.fromEntries(
    MODE_CATEGORIES.flatMap((category) =>
      category.modes.map((entry) => [entry.mode, { label: entry.label, icon: entry.icon }]),
    ),
  ) as Record<PickableMode, { label: string; icon: string }>;

const FALLBACK_PRESENTATION = { label: 'Practice', icon: '🧘' } as const;

const PracticeRow = ({ practice, onPress }: PracticeRowProps): React.JSX.Element => {
  const mode = (practice.mode ?? 'meditation_timer') as PickableMode;
  const { label, icon } = MODE_PRESENTATION[mode] ?? FALLBACK_PRESENTATION;
  const duration = Math.round(practice.default_duration_minutes);
  const subtitle = `${label} · ${duration} min`;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`${practice.name}. ${label}, ${duration} minutes.`}
      onPress={onPress}
      style={styles.row}
      testID={`practice-catalog-row-${practice.id}`}
    >
      {/* Decorative anchor; the row's accessibilityLabel already names the
          mode, and the accessible TouchableOpacity merges children, so the
          emoji is not separately announced to screen readers. */}
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
  );
};

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
  screen: { flex: 1, backgroundColor: colors.background.primary },
  body: { padding: SPACING.md, paddingBottom: SPACING.xl },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  heading: { fontSize: 22, fontWeight: '700', color: colors.text.primary },
  subheading: {
    fontSize: 13,
    color: colors.text.secondaryAccessible,
    marginTop: 2,
  },
  createButton: {
    backgroundColor: colors.primary,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.sm,
  },
  createButtonText: { color: colors.text.light, fontWeight: '700', fontSize: 13 },
  search: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    fontSize: 14,
    color: colors.text.primary,
    backgroundColor: colors.background.card,
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
    borderColor: colors.border,
    backgroundColor: colors.background.card,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text.primary, fontWeight: '600' },
  chipTextSelected: { color: colors.text.light },
  loadingBlock: { padding: SPACING.lg, alignItems: 'center' },
  errorBlock: { padding: SPACING.lg, alignItems: 'center', gap: SPACING.sm },
  errorText: { color: colors.destructive.text, fontSize: 13 },
  retryButton: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  retryButtonText: { color: colors.text.primary, fontWeight: '600' },
  section: { marginTop: SPACING.md },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text.secondaryAccessible,
    textTransform: 'uppercase',
    marginBottom: SPACING.sm,
  },
  emptyText: { color: colors.text.tertiaryAccessible, fontSize: 13 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    ...shadows.small,
  },
  rowIcon: { fontSize: 24, width: 32, textAlign: 'center' },
  rowText: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: '700', color: colors.text.primary },
  rowSubtitle: {
    fontSize: 13,
    color: colors.text.secondaryAccessible,
    marginTop: 2,
  },
});

export default PracticeCatalogScreen;
