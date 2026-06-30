import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import TagPicker from './TagPicker';
import type { DraftStep, RecipeDraft } from './types';
import { nameToSlug, newStepUid } from './types';

import type {
  PracticeRecipe,
  PracticeRecipeCreate,
  PracticeRecipeStepInput,
  PracticeRecipeUpdate,
  PracticeTag,
  PracticeTagCreate,
  RecipeMode,
} from '@/api';
import { practiceRecipes, practiceTags } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';
import {
  CUSTOM_NAME_MAX,
  PROMPT_LABEL_MAX,
  TALLIED_CATEGORIES_MAX,
  TALLIED_ROUNDS_MAX,
  TALLIED_TARGET_MAX,
} from '@/features/Practice/engine/validation';

export interface RecipeEditorModalProps {
  visible: boolean;
  mode: RecipeMode;
  initialDraft: RecipeDraft;
  /** ``null`` opens the editor in create mode; non-null opens in edit mode. */
  recipeId: number | null;
  onClose: () => void;
  onSaved: (saved: PracticeRecipe) => void;
  /** Test injection seams. */
  create?: typeof practiceRecipes.create;
  update?: typeof practiceRecipes.update;
  listTags?: typeof practiceTags.list;
  createTag?: typeof practiceTags.create;
}

// Bounds that mirror the backend recipe schema are owned by ``engine/validation``;
// alias them to the names this draft editor uses so the contract stays single-sourced.
const NAME_MAX = CUSTOM_NAME_MAX;
const PROMPT_MAX = PROMPT_LABEL_MAX;
const ROUNDS_MAX = TALLIED_ROUNDS_MAX;
const TARGET_COUNT_MAX = TALLIED_TARGET_MAX;
const STEPS_MAX = TALLIED_CATEGORIES_MAX;
// Recipe description cap has no engine-owned constant (no mode config mirrors it).
const DESCRIPTION_MAX = 2_000;

const RecipeEditorModal = (props: RecipeEditorModalProps): React.JSX.Element => {
  const deps = resolveDeps(props);
  const draftState = useDraftState(props.initialDraft);
  const tagLibrary = useTagLibrary(props.visible, deps.listTags);
  const saveState = useSaveState();

  const errors = useMemo(
    () => validateDraft(draftState.draft, props.mode),
    [draftState.draft, props.mode],
  );
  const canSave = errors.length === 0 && !saveState.busy;

  const onSave = useCallback(async (): Promise<void> => {
    const saved = await saveState.save({
      recipeId: props.recipeId,
      mode: props.mode,
      draft: draftState.draft,
      create: deps.create,
      update: deps.update,
    });
    if (saved !== null) props.onSaved(saved);
  }, [saveState, props, draftState.draft, deps]);

  const onCreateTag = useCallback(
    async (payload: PracticeTagCreate) => {
      const created = await deps.createTag(payload);
      tagLibrary.add(created);
      return created;
    },
    [deps, tagLibrary],
  );

  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <EditorSheetContent
        recipeId={props.recipeId}
        mode={props.mode}
        canSave={canSave}
        saveError={saveState.error}
        draftState={draftState}
        tagLibrary={tagLibrary.tags}
        errors={errors}
        onSave={onSave}
        onCancel={props.onClose}
        onCreateTag={onCreateTag}
      />
    </Modal>
  );
};

interface ResolvedDeps {
  create: typeof practiceRecipes.create;
  update: typeof practiceRecipes.update;
  listTags: typeof practiceTags.list;
  createTag: typeof practiceTags.create;
}

function resolveDeps(props: RecipeEditorModalProps): ResolvedDeps {
  return {
    create: props.create ?? practiceRecipes.create,
    update: props.update ?? practiceRecipes.update,
    listTags: props.listTags ?? practiceTags.list,
    createTag: props.createTag ?? practiceTags.create,
  };
}

interface EditorSheetContentProps {
  recipeId: number | null;
  mode: RecipeMode;
  canSave: boolean;
  saveError: string | null;
  draftState: DraftState;
  tagLibrary: PracticeTag[];
  errors: string[];
  onSave: () => void;
  onCancel: () => void;
  onCreateTag: (payload: PracticeTagCreate) => Promise<PracticeTag>;
}

const EditorSheetContent = (props: EditorSheetContentProps): React.JSX.Element => (
  <KeyboardAvoidingView
    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    style={styles.overlay}
    testID="recipe-editor-overlay"
  >
    <View style={styles.sheet} testID="recipe-editor-sheet">
      <EditorHeader
        title={props.recipeId === null ? 'New recipe' : 'Edit recipe'}
        canSave={props.canSave}
        onCancel={props.onCancel}
        onSave={props.onSave}
      />
      {props.saveError !== null && (
        <Text style={styles.apiError} testID="recipe-editor-api-error">
          {props.saveError}
        </Text>
      )}
      <ScrollView
        style={styles.body}
        keyboardShouldPersistTaps="handled"
        testID="recipe-editor-scroll"
      >
        <EditorFields
          draftState={props.draftState}
          mode={props.mode}
          tagLibrary={props.tagLibrary}
          onCreateTag={props.onCreateTag}
        />
        {props.errors.length > 0 && <ValidationErrors errors={props.errors} />}
      </ScrollView>
    </View>
  </KeyboardAvoidingView>
);

interface EditorFieldsProps {
  draftState: DraftState;
  mode: RecipeMode;
  tagLibrary: PracticeTag[];
  onCreateTag: (payload: PracticeTagCreate) => Promise<PracticeTag>;
}

const EditorFields = (props: EditorFieldsProps): React.JSX.Element => (
  <>
    <NameField
      value={props.draftState.draft.name}
      onChange={(name) => props.draftState.update({ name })}
    />
    <DescriptionField
      value={props.draftState.draft.description}
      onChange={(description) => props.draftState.update({ description })}
    />
    {props.mode === 'tallied_grounding' && (
      <RoundsField
        value={props.draftState.draft.rounds}
        onChange={(rounds) => props.draftState.update({ rounds })}
      />
    )}
    <StepEditor
      steps={props.draftState.draft.steps}
      mode={props.mode}
      tagLibrary={props.tagLibrary}
      onCreateTag={props.onCreateTag}
      onChangeStep={props.draftState.updateStep}
      onMoveStep={props.draftState.moveStep}
      onRemoveStep={props.draftState.removeStep}
      onAppendStep={props.draftState.appendStep}
    />
  </>
);

const ValidationErrors = ({ errors }: { errors: string[] }): React.JSX.Element => (
  <View style={styles.errors} testID="recipe-editor-errors">
    {errors.map((msg) => (
      <Text key={msg} style={styles.errorText}>
        • {msg}
      </Text>
    ))}
  </View>
);

interface DraftState {
  draft: RecipeDraft;
  update: (patch: Partial<RecipeDraft>) => void;
  updateStep: (uid: string, patch: Partial<DraftStep>) => void;
  moveStep: (uid: string, direction: -1 | 1) => void;
  removeStep: (uid: string) => void;
  appendStep: () => void;
}

function applyPatch(prev: RecipeDraft, patch: Partial<RecipeDraft>): RecipeDraft {
  return { ...prev, ...patch };
}

function applyStepPatch(prev: RecipeDraft, uid: string, patch: Partial<DraftStep>): RecipeDraft {
  return {
    ...prev,
    steps: prev.steps.map((s) => (s.uid === uid ? { ...s, ...patch } : s)),
  };
}

function applyStepSwap(prev: RecipeDraft, uid: string, direction: -1 | 1): RecipeDraft {
  const index = prev.steps.findIndex((s) => s.uid === uid);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= prev.steps.length) return prev;
  const next = prev.steps.slice();
  const tmp = next[index];
  const swap = next[target];
  if (tmp === undefined || swap === undefined) return prev;
  next[index] = swap;
  next[target] = tmp;
  return { ...prev, steps: next };
}

function applyStepRemove(prev: RecipeDraft, uid: string): RecipeDraft {
  return { ...prev, steps: prev.steps.filter((s) => s.uid !== uid) };
}

function blankStep(): DraftStep {
  return {
    uid: newStepUid(),
    tag_slug: '',
    tag_label: '',
    prompt_label: '',
    target_count: 1,
  };
}

function applyStepAppend(prev: RecipeDraft): RecipeDraft {
  return { ...prev, steps: [...prev.steps, blankStep()] };
}

function useDraftState(initial: RecipeDraft): DraftState {
  const [draft, setDraft] = useState<RecipeDraft>(initial);
  const update = useCallback(
    (patch: Partial<RecipeDraft>) => setDraft((prev) => applyPatch(prev, patch)),
    [],
  );
  const updateStep = useCallback(
    (uid: string, patch: Partial<DraftStep>) =>
      setDraft((prev) => applyStepPatch(prev, uid, patch)),
    [],
  );
  const moveStep = useCallback(
    (uid: string, direction: -1 | 1) => setDraft((prev) => applyStepSwap(prev, uid, direction)),
    [],
  );
  const removeStep = useCallback(
    (uid: string) => setDraft((prev) => applyStepRemove(prev, uid)),
    [],
  );
  const appendStep = useCallback(() => setDraft(applyStepAppend), []);
  return { draft, update, updateStep, moveStep, removeStep, appendStep };
}

interface TagLibraryState {
  tags: PracticeTag[];
  add: (tag: PracticeTag) => void;
}

function useTagLibrary(visible: boolean, list: typeof practiceTags.list): TagLibraryState {
  const [tags, setTags] = useState<PracticeTag[]>([]);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await list();
        if (!cancelled) setTags(loaded);
      } catch {
        // Tag library is best-effort; the user can still type a custom
        // slug + label by hand if loading fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, list]);
  const add = useCallback((tag: PracticeTag) => setTags((prev) => [...prev, tag]), []);
  return { tags, add };
}

interface SaveArgs {
  recipeId: number | null;
  mode: RecipeMode;
  draft: RecipeDraft;
  create: typeof practiceRecipes.create;
  update: typeof practiceRecipes.update;
}

interface SaveState {
  busy: boolean;
  error: string | null;
  save: (args: SaveArgs) => Promise<PracticeRecipe | null>;
}

function useSaveState(): SaveState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(async (args: SaveArgs): Promise<PracticeRecipe | null> => {
    setBusy(true);
    setError(null);
    try {
      const steps: PracticeRecipeStepInput[] = args.draft.steps.map((step) => ({
        tag_slug: step.tag_slug,
        tag_label: step.tag_label,
        prompt_label: step.prompt_label,
        target_count: step.target_count,
      }));
      if (args.recipeId === null) {
        const payload: PracticeRecipeCreate = {
          slug: args.draft.slug.length > 0 ? args.draft.slug : nameToSlug(args.draft.name),
          name: args.draft.name,
          description: args.draft.description,
          mode: args.mode,
          rounds: args.draft.rounds,
          steps,
        };
        return await args.create(payload);
      }
      const updatePayload: PracticeRecipeUpdate = {
        name: args.draft.name,
        description: args.draft.description,
        rounds: args.draft.rounds,
        steps,
      };
      return await args.update(args.recipeId, updatePayload);
    } catch (err: unknown) {
      setError(formatApiError(err, { fallback: 'Could not save recipe.' }));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, save };
}

function validateDraft(draft: RecipeDraft, mode: RecipeMode): string[] {
  const errors: string[] = [];
  if (draft.name.trim().length === 0) errors.push('Recipe needs a name.');
  if (draft.name.length > NAME_MAX) errors.push(`Name must be ${NAME_MAX} characters or fewer.`);
  if (draft.description.length > DESCRIPTION_MAX) {
    errors.push(`Description must be ${DESCRIPTION_MAX} characters or fewer.`);
  }
  if (draft.steps.length === 0) errors.push('Add at least one step.');
  if (draft.steps.length > STEPS_MAX) errors.push(`Recipes are limited to ${STEPS_MAX} steps.`);
  if (mode === 'sense_grounding' && draft.rounds !== 1) {
    errors.push('Sense-grounding recipes use exactly one round.');
  }
  if (draft.rounds < 1 || draft.rounds > ROUNDS_MAX) {
    errors.push(`Rounds must be between 1 and ${ROUNDS_MAX}.`);
  }
  const seenSlugs = new Set<string>();
  draft.steps.forEach((step, idx) => {
    if (step.tag_slug.length === 0) errors.push(`Step ${idx + 1} needs a tag.`);
    if (step.prompt_label.trim().length === 0) errors.push(`Step ${idx + 1} needs a prompt.`);
    if (step.prompt_label.length > PROMPT_MAX) {
      errors.push(`Step ${idx + 1} prompt is too long.`);
    }
    if (step.target_count < 1 || step.target_count > TARGET_COUNT_MAX) {
      errors.push(`Step ${idx + 1} count must be 1-${TARGET_COUNT_MAX}.`);
    }
    if (mode === 'tallied_grounding') {
      if (seenSlugs.has(step.tag_slug)) {
        errors.push(`Step ${idx + 1} repeats tag "${step.tag_slug}"; use a different tag.`);
      }
      seenSlugs.add(step.tag_slug);
    }
  });
  return errors;
}

interface EditorHeaderProps {
  title: string;
  canSave: boolean;
  onCancel: () => void;
  onSave: () => void;
}

const EditorHeader = ({
  title,
  canSave,
  onCancel,
  onSave,
}: EditorHeaderProps): React.JSX.Element => (
  <View style={styles.header}>
    <Text style={styles.title}>{title}</Text>
    <View style={styles.headerActions}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        onPress={onCancel}
        style={styles.cancelButton}
        testID="recipe-editor-cancel"
      >
        <Text style={styles.cancelText}>Cancel</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Save"
        accessibilityState={{ disabled: !canSave }}
        onPress={canSave ? onSave : undefined}
        style={[styles.saveButton, !canSave && styles.disabled]}
        testID="recipe-editor-save"
      >
        <Text style={styles.saveText}>Save</Text>
      </TouchableOpacity>
    </View>
  </View>
);

const NameField = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): React.JSX.Element => (
  <View style={styles.field}>
    <Text style={styles.label}>Name</Text>
    <TextInput
      value={value}
      onChangeText={onChange}
      style={styles.input}
      placeholder="My grounding practice"
      maxLength={NAME_MAX}
      testID="recipe-editor-name"
    />
  </View>
);

const DescriptionField = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): React.JSX.Element => (
  <View style={styles.field}>
    <Text style={styles.label}>Description</Text>
    <TextInput
      value={value}
      onChangeText={onChange}
      style={[styles.input, styles.descriptionInput]}
      placeholder="Optional note about when to use this recipe"
      multiline
      maxLength={DESCRIPTION_MAX}
      testID="recipe-editor-description"
    />
  </View>
);

const RoundsField = ({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}): React.JSX.Element => (
  <View style={styles.field}>
    <Text style={styles.label}>Rounds</Text>
    <View style={styles.stepperRow}>
      <RoundsButton
        label="-"
        onPress={() => onChange(Math.max(1, value - 1))}
        testID="recipe-editor-rounds-minus"
      />
      <Text style={styles.stepperValue} testID="recipe-editor-rounds-value">
        {value}
      </Text>
      <RoundsButton
        label="+"
        onPress={() => onChange(Math.min(ROUNDS_MAX, value + 1))}
        testID="recipe-editor-rounds-plus"
      />
    </View>
  </View>
);

const RoundsButton = ({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID: string;
}): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    onPress={onPress}
    style={styles.stepperButton}
    testID={testID}
  >
    <Text style={styles.stepperButtonText}>{label}</Text>
  </TouchableOpacity>
);

interface StepEditorProps {
  steps: DraftStep[];
  mode: RecipeMode;
  tagLibrary: PracticeTag[];
  onCreateTag: (payload: PracticeTagCreate) => Promise<PracticeTag>;
  onChangeStep: (uid: string, patch: Partial<DraftStep>) => void;
  onMoveStep: (uid: string, direction: -1 | 1) => void;
  onRemoveStep: (uid: string) => void;
  onAppendStep: () => void;
}

const StepEditor = (props: StepEditorProps): React.JSX.Element => (
  <View testID="recipe-editor-steps">
    <Text style={styles.label}>Steps</Text>
    {props.steps.map((step, index) => (
      <StepCard
        key={step.uid}
        step={step}
        index={index}
        last={index === props.steps.length - 1}
        mode={props.mode}
        tagLibrary={props.tagLibrary}
        onCreateTag={props.onCreateTag}
        onChange={(patch) => props.onChangeStep(step.uid, patch)}
        onMove={(dir) => props.onMoveStep(step.uid, dir)}
        onRemove={() => props.onRemoveStep(step.uid)}
      />
    ))}
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Add step"
      onPress={props.onAppendStep}
      style={styles.addButton}
      testID="recipe-editor-add-step"
    >
      <Text style={styles.addButtonText}>+ Add step</Text>
    </TouchableOpacity>
  </View>
);

interface StepCardProps {
  step: DraftStep;
  index: number;
  last: boolean;
  mode: RecipeMode;
  tagLibrary: PracticeTag[];
  onCreateTag: (payload: PracticeTagCreate) => Promise<PracticeTag>;
  onChange: (patch: Partial<DraftStep>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}

const StepCard = (props: StepCardProps): React.JSX.Element => (
  <View style={styles.stepCard} testID={`recipe-editor-step-${props.index}`}>
    <TagPicker
      stepIndex={props.index}
      selectedSlug={props.step.tag_slug}
      tagLibrary={props.tagLibrary}
      onSelect={(tag) => props.onChange({ tag_slug: tag.slug, tag_label: tag.label })}
      onCreateTag={async (payload) => {
        const created = await props.onCreateTag(payload);
        props.onChange({ tag_slug: created.slug, tag_label: created.label });
      }}
    />
    <TextInput
      value={props.step.prompt_label}
      onChangeText={(text) => props.onChange({ prompt_label: text })}
      style={styles.input}
      placeholder="What should the user notice?"
      maxLength={PROMPT_MAX}
      testID={`recipe-editor-step-${props.index}-prompt`}
    />
    {props.mode === 'tallied_grounding' && (
      <StepCountRow
        index={props.index}
        value={props.step.target_count}
        onChange={(target_count) => props.onChange({ target_count })}
      />
    )}
    <StepActionsRow
      index={props.index}
      isFirst={props.index === 0}
      isLast={props.last}
      onMove={props.onMove}
      onRemove={props.onRemove}
    />
  </View>
);

interface StepCountRowProps {
  index: number;
  value: number;
  onChange: (next: number) => void;
}

const StepCountRow = ({ index, value, onChange }: StepCountRowProps): React.JSX.Element => (
  <View style={styles.countRow}>
    <Text style={styles.label}>Count</Text>
    <View style={styles.stepperRow}>
      <RoundsButton
        label="-"
        onPress={() => onChange(Math.max(1, value - 1))}
        testID={`recipe-editor-step-${index}-count-minus`}
      />
      <Text style={styles.stepperValue} testID={`recipe-editor-step-${index}-count-value`}>
        {value}
      </Text>
      <RoundsButton
        label="+"
        onPress={() => onChange(Math.min(TARGET_COUNT_MAX, value + 1))}
        testID={`recipe-editor-step-${index}-count-plus`}
      />
    </View>
  </View>
);

interface StepActionsRowProps {
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}

const StepActionsRow = (props: StepActionsRowProps): React.JSX.Element => (
  <View style={styles.actionsRow}>
    <SmallButton
      label="↑"
      disabled={props.isFirst}
      onPress={() => props.onMove(-1)}
      testID={`recipe-editor-step-${props.index}-up`}
    />
    <SmallButton
      label="↓"
      disabled={props.isLast}
      onPress={() => props.onMove(1)}
      testID={`recipe-editor-step-${props.index}-down`}
    />
    <SmallButton
      label="Remove"
      disabled={false}
      onPress={props.onRemove}
      testID={`recipe-editor-step-${props.index}-remove`}
    />
  </View>
);

interface SmallButtonProps {
  label: string;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}

const SmallButton = ({ label, disabled, onPress, testID }: SmallButtonProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    onPress={disabled ? undefined : onPress}
    style={[styles.smallButton, disabled && styles.disabled]}
    testID={testID}
  >
    <Text style={styles.smallButtonText}>{label}</Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: colors.mystical.overlay, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.background.primary,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    maxHeight: '95%',
    ...shadows.large,
  },
  header: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.separator,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 18, fontWeight: '600', color: colors.text.primary },
  headerActions: { flexDirection: 'row', gap: SPACING.sm },
  cancelButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
  },
  cancelText: { color: colors.text.secondaryAccessible, fontWeight: '500' },
  saveButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.primary,
  },
  saveText: { color: colors.text.light, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  body: { padding: SPACING.lg },
  apiError: { color: colors.danger, paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm },
  field: { marginBottom: SPACING.md },
  label: { color: colors.text.primary, fontSize: 14, fontWeight: '500', marginBottom: SPACING.xs },
  input: {
    borderWidth: 1,
    borderColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    color: colors.text.primary,
    fontSize: 14,
  },
  descriptionInput: { minHeight: 60, textAlignVertical: 'top' },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  stepperButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.background.accent,
    minWidth: 40,
    alignItems: 'center',
  },
  stepperButtonText: { color: colors.text.primary, fontSize: 16, fontWeight: '600' },
  stepperValue: {
    minWidth: 32,
    textAlign: 'center',
    fontSize: 16,
    color: colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  stepCard: {
    padding: SPACING.sm,
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.md,
    marginBottom: SPACING.sm,
    gap: SPACING.xs,
  },
  countRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // Reorder + remove are de-emphasised quiet controls, right-aligned, so the
  // step content reads first; "+ Add step" is the one prominent add affordance.
  actionsRow: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginTop: SPACING.xs,
    justifyContent: 'flex-end',
  },
  smallButton: {
    minHeight: 44,
    paddingHorizontal: SPACING.xs,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallButtonText: { color: colors.text.secondaryAccessible, fontSize: 13, fontWeight: '500' },
  addButton: {
    minHeight: 44,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.sm,
  },
  addButtonText: { color: colors.primary, fontWeight: '600', fontSize: 14 },
  errors: {
    backgroundColor: colors.background.card,
    borderLeftColor: colors.danger,
    borderLeftWidth: 3,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    marginTop: SPACING.md,
  },
  errorText: { color: colors.danger, fontSize: 13, marginVertical: 2 },
});

export default RecipeEditorModal;
