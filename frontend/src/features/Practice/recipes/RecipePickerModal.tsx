import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import RecipeEditorModal from './RecipeEditorModal';
import type { RecipeDraft } from './types';
import { newStepUid } from './types';

import type { PracticeRecipe, RecipeMode, UserPractice } from '@/api';
import { practiceRecipes } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

export interface RecipePickerModalProps {
  visible: boolean;
  /** Constrain the list to recipes compatible with the active practice's mode. */
  mode: RecipeMode;
  /** The active UserPractice this picker applies a recipe to. */
  userPracticeId: number;
  onClose: () => void;
  /** Called after a recipe is applied; the parent typically forwards to its
   *  configurator's `onSaved` so the customise UI refreshes too. */
  onApplied?: (updated: UserPractice) => void;
  /** Injection seams for tests. */
  list?: typeof practiceRecipes.list;
  apply?: typeof practiceRecipes.apply;
  remove?: typeof practiceRecipes.remove;
}

type EditorState =
  | { kind: 'closed' }
  | { kind: 'new'; draft: RecipeDraft }
  | { kind: 'edit'; recipeId: number; draft: RecipeDraft };

/**
 * Library picker for recipes the user can apply to their active tier-one
 * UserPractice.  Lists system + personal recipes filtered by mode.
 *
 * System recipes are read-only; personal recipes have Edit + Delete
 * buttons.  "Edit a system recipe" forks a personal copy via the
 * editor's create path -- the original stays untouched.
 */
const RecipePickerModal = (props: RecipePickerModalProps): React.JSX.Element => {
  const deps = resolvePickerDeps(props);
  const fetch = useFetchState(props.mode, deps.list);
  const action = useActionState();
  const [editor, setEditor] = useState<EditorState>({ kind: 'closed' });
  const refresh = fetch.refresh;

  useEffect(() => {
    if (props.visible) void refresh();
  }, [props.visible, refresh]);

  const handlers = useRecipeHandlers({
    apply: deps.apply,
    remove: deps.remove,
    userPracticeId: props.userPracticeId,
    action,
    refresh,
    onApplied: props.onApplied,
    onClose: props.onClose,
  });
  const editorHandlers = useEditorHandlers(props.mode, setEditor);

  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <PickerSheet
        action={action}
        fetch={fetch}
        onClose={props.onClose}
        onApply={handlers.onApply}
        onDelete={handlers.onDelete}
        onOpenNew={editorHandlers.openNew}
        onOpenEdit={editorHandlers.openEdit}
        onOpenFork={editorHandlers.openFork}
      />
      {editor.kind !== 'closed' && (
        <RecipeEditorModal
          visible
          mode={props.mode}
          initialDraft={editor.draft}
          recipeId={editor.kind === 'edit' ? editor.recipeId : null}
          onClose={() => setEditor({ kind: 'closed' })}
          onSaved={() => {
            setEditor({ kind: 'closed' });
            void refresh();
          }}
        />
      )}
    </Modal>
  );
};

interface EditorHandlers {
  openNew: () => void;
  openEdit: (recipe: PracticeRecipe) => void;
  openFork: (recipe: PracticeRecipe) => void;
}

function useEditorHandlers(
  mode: RecipeMode,
  setEditor: React.Dispatch<React.SetStateAction<EditorState>>,
): EditorHandlers {
  const openNew = useCallback(
    () => setEditor({ kind: 'new', draft: newRecipeDraft(mode) }),
    [mode, setEditor],
  );
  const openEdit = useCallback(
    (recipe: PracticeRecipe) =>
      setEditor({ kind: 'edit', recipeId: recipe.id, draft: recipeToDraft(recipe) }),
    [setEditor],
  );
  const openFork = useCallback(
    (recipe: PracticeRecipe) =>
      setEditor({
        kind: 'new',
        draft: { ...recipeToDraft(recipe), slug: '', name: `${recipe.name} copy` },
      }),
    [setEditor],
  );
  return { openNew, openEdit, openFork };
}

interface PickerDeps {
  list: typeof practiceRecipes.list;
  apply: typeof practiceRecipes.apply;
  remove: typeof practiceRecipes.remove;
}

function resolvePickerDeps(props: RecipePickerModalProps): PickerDeps {
  return {
    list: props.list ?? practiceRecipes.list,
    apply: props.apply ?? practiceRecipes.apply,
    remove: props.remove ?? practiceRecipes.remove,
  };
}

interface RecipeHandlerArgs {
  apply: typeof practiceRecipes.apply;
  remove: typeof practiceRecipes.remove;
  userPracticeId: number;
  action: ActionState;
  refresh: () => Promise<void>;
  onApplied?: (updated: UserPractice) => void;
  onClose: () => void;
}

interface RecipeHandlers {
  onApply: (recipe: PracticeRecipe) => Promise<void>;
  onDelete: (recipe: PracticeRecipe) => Promise<void>;
}

function useRecipeHandlers(args: RecipeHandlerArgs): RecipeHandlers {
  const { apply, remove, userPracticeId, action, refresh, onApplied, onClose } = args;
  const onApply = useCallback(
    async (recipe: PracticeRecipe): Promise<void> => {
      const updated = await action.run(() => apply(recipe.id, userPracticeId));
      if (updated !== null) {
        onApplied?.(updated);
        onClose();
      }
    },
    [action, apply, userPracticeId, onApplied, onClose],
  );
  const onDelete = useCallback(
    async (recipe: PracticeRecipe): Promise<void> => {
      const ok = await action.run(async () => {
        await remove(recipe.id);
        return true as const;
      });
      if (ok !== null) void refresh();
    },
    [action, remove, refresh],
  );
  return { onApply, onDelete };
}

interface PickerSheetProps {
  action: ActionState;
  fetch: FetchState;
  onClose: () => void;
  onApply: (recipe: PracticeRecipe) => Promise<void>;
  onDelete: (recipe: PracticeRecipe) => Promise<void>;
  onOpenNew: () => void;
  onOpenEdit: (recipe: PracticeRecipe) => void;
  onOpenFork: (recipe: PracticeRecipe) => void;
}

const PickerSheet = (props: PickerSheetProps): React.JSX.Element => (
  <View style={styles.overlay} testID="recipe-picker-overlay">
    <View style={styles.sheet} testID="recipe-picker-sheet">
      <PickerHeader onClose={props.onClose} onNew={props.onOpenNew} />
      {props.action.error !== null && (
        <Text style={styles.apiError} testID="recipe-picker-api-error">
          {props.action.error}
        </Text>
      )}
      <RecipeList
        fetch={props.fetch}
        disableActions={props.action.busy}
        onApply={props.onApply}
        onEdit={props.onOpenEdit}
        onFork={props.onOpenFork}
        onDelete={props.onDelete}
      />
    </View>
  </View>
);

interface FetchState {
  recipes: PracticeRecipe[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function useFetchState(mode: RecipeMode, list: typeof practiceRecipes.list): FetchState {
  const [recipes, setRecipes] = useState<PracticeRecipe[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await list(mode);
      setRecipes(next);
    } catch (err: unknown) {
      setError(formatApiError(err, { fallback: 'Could not load recipes.' }));
    } finally {
      setLoading(false);
    }
  }, [mode, list]);
  return { recipes, loading, error, refresh };
}

interface ActionState {
  busy: boolean;
  error: string | null;
  run: <T>(task: () => Promise<T>) => Promise<T | null>;
}

function useActionState(): ActionState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(task: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await task();
    } catch (err: unknown) {
      setError(formatApiError(err, { fallback: 'Action failed.' }));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

interface PickerHeaderProps {
  onClose: () => void;
  onNew: () => void;
}

const PickerHeader = ({ onClose, onNew }: PickerHeaderProps): React.JSX.Element => (
  <View style={styles.header}>
    <Text style={styles.title}>Recipe library</Text>
    <View style={styles.headerActions}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Create new recipe"
        onPress={onNew}
        style={styles.newButton}
        testID="recipe-picker-new"
      >
        <Text style={styles.newButtonText}>+ New</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        style={styles.closeButton}
        testID="recipe-picker-close"
      >
        <Text style={styles.closeText}>Close</Text>
      </TouchableOpacity>
    </View>
  </View>
);

interface RecipeListProps {
  fetch: FetchState;
  disableActions: boolean;
  onApply: (recipe: PracticeRecipe) => Promise<void>;
  onEdit: (recipe: PracticeRecipe) => void;
  onFork: (recipe: PracticeRecipe) => void;
  onDelete: (recipe: PracticeRecipe) => Promise<void>;
}

const RecipeList = (props: RecipeListProps): React.JSX.Element => {
  if (props.fetch.loading && props.fetch.recipes.length === 0) {
    return (
      <View style={styles.center} testID="recipe-picker-loading">
        <ActivityIndicator />
      </View>
    );
  }
  if (props.fetch.error !== null && props.fetch.recipes.length === 0) {
    return (
      <Text style={styles.apiError} testID="recipe-picker-list-error">
        {props.fetch.error}
      </Text>
    );
  }
  if (props.fetch.recipes.length === 0) {
    return (
      <Text style={styles.emptyText} testID="recipe-picker-empty">
        No recipes available. Tap + New to create one.
      </Text>
    );
  }
  return (
    <ScrollView style={styles.body} testID="recipe-picker-list">
      {props.fetch.recipes.map((recipe) => (
        <RecipeRow
          key={recipe.id}
          recipe={recipe}
          disableActions={props.disableActions}
          onApply={() => props.onApply(recipe)}
          onEdit={() => props.onEdit(recipe)}
          onFork={() => props.onFork(recipe)}
          onDelete={() => props.onDelete(recipe)}
        />
      ))}
    </ScrollView>
  );
};

interface RecipeRowProps {
  recipe: PracticeRecipe;
  disableActions: boolean;
  onApply: () => void;
  onEdit: () => void;
  onFork: () => void;
  onDelete: () => void;
}

const RecipeRow = (props: RecipeRowProps): React.JSX.Element => {
  const isSystem = props.recipe.owner_user_id === null;
  const stepSummary = useMemo(() => describeSteps(props.recipe), [props.recipe]);
  return (
    <View style={styles.card} testID={`recipe-row-${props.recipe.id}`}>
      <RecipeRowHeader recipe={props.recipe} isSystem={isSystem} summary={stepSummary} />
      <RowButton
        label="Use this"
        variant="primary"
        block
        disabled={props.disableActions}
        onPress={props.onApply}
        testID={`recipe-row-${props.recipe.id}-apply`}
      />
      <View style={styles.secondaryActions}>
        <RecipeRowMutationButtons
          recipeId={props.recipe.id}
          isSystem={isSystem}
          disableActions={props.disableActions}
          onEdit={props.onEdit}
          onFork={props.onFork}
          onDelete={props.onDelete}
        />
      </View>
    </View>
  );
};

interface RecipeRowHeaderProps {
  recipe: PracticeRecipe;
  isSystem: boolean;
  summary: string;
}

const RecipeRowHeader = (props: RecipeRowHeaderProps): React.JSX.Element => (
  <>
    <View style={styles.cardHead}>
      <Text style={styles.recipeName}>{props.recipe.name}</Text>
      {props.isSystem && (
        <View style={styles.systemBadge}>
          <Text style={styles.systemBadgeText}>System</Text>
        </View>
      )}
    </View>
    {props.recipe.description.length > 0 && (
      <Text style={styles.description}>{props.recipe.description}</Text>
    )}
    <Text style={styles.summary}>{props.summary}</Text>
  </>
);

interface RecipeRowMutationButtonsProps {
  recipeId: number;
  isSystem: boolean;
  disableActions: boolean;
  onEdit: () => void;
  onFork: () => void;
  onDelete: () => void;
}

const RecipeRowMutationButtons = (props: RecipeRowMutationButtonsProps): React.JSX.Element => {
  if (props.isSystem) {
    return (
      <RowButton
        label="Edit a copy"
        variant="quiet"
        disabled={props.disableActions}
        onPress={props.onFork}
        testID={`recipe-row-${props.recipeId}-fork`}
      />
    );
  }
  return (
    <>
      <RowButton
        label="Edit"
        variant="quiet"
        disabled={props.disableActions}
        onPress={props.onEdit}
        testID={`recipe-row-${props.recipeId}-edit`}
      />
      <RowButton
        label="Delete"
        variant="quietDanger"
        disabled={props.disableActions}
        onPress={props.onDelete}
        testID={`recipe-row-${props.recipeId}-delete`}
      />
    </>
  );
};

type RowButtonVariant = 'primary' | 'default' | 'quiet' | 'quietDanger';

interface RowButtonProps {
  label: string;
  variant?: RowButtonVariant;
  /** Stretch to fill the row — used for the primary "Use this" action. */
  block?: boolean;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}

const RowButton = ({
  label,
  variant = 'default',
  block = false,
  disabled,
  onPress,
  testID,
}: RowButtonProps): React.JSX.Element => {
  const bg = {
    primary: styles.primaryButton,
    default: styles.defaultButton,
    quiet: styles.quietButton,
    quietDanger: styles.quietButton,
  }[variant];
  const text = {
    primary: styles.lightText,
    default: styles.defaultText,
    quiet: styles.quietText,
    quietDanger: styles.quietDangerText,
  }[variant];
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={disabled ? undefined : onPress}
      style={[styles.smallButton, bg, block && styles.blockButton, disabled && styles.disabled]}
      testID={testID}
    >
      <Text style={[styles.smallButtonText, text]}>{label}</Text>
    </TouchableOpacity>
  );
};

function describeSteps(recipe: PracticeRecipe): string {
  const totalSteps = recipe.steps.reduce((acc, step) => acc + step.target_count, 0);
  const stepWord = totalSteps === 1 ? 'observation' : 'observations';
  if (recipe.rounds > 1) {
    return `${recipe.rounds} rounds, ${totalSteps} ${stepWord} per round`;
  }
  return `${totalSteps} ${stepWord}`;
}

function newRecipeDraft(mode: RecipeMode): RecipeDraft {
  return {
    slug: '',
    name: '',
    description: '',
    mode,
    rounds: 1,
    steps: [
      {
        uid: newStepUid(),
        tag_slug: '',
        tag_label: '',
        prompt_label: '',
        target_count: 1,
      },
    ],
  };
}

function recipeToDraft(recipe: PracticeRecipe): RecipeDraft {
  return {
    slug: recipe.slug,
    name: recipe.name,
    description: recipe.description,
    mode: recipe.mode,
    rounds: recipe.rounds,
    steps: recipe.steps.map((step) => ({
      uid: newStepUid(),
      tag_slug: step.tag_slug,
      tag_label: step.tag_label,
      prompt_label: step.prompt_label,
      target_count: step.target_count,
    })),
  };
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.background.primary,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    maxHeight: '90%',
    ...shadows.large,
  },
  header: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.background.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 18, fontWeight: '600', color: colors.text.primary },
  headerActions: { flexDirection: 'row', gap: SPACING.sm },
  newButton: {
    backgroundColor: colors.primary,
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  newButtonText: { color: colors.text.light, fontWeight: '600' },
  closeButton: {
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  closeText: { color: colors.text.secondaryAccessible, fontWeight: '500' },
  body: { padding: SPACING.lg },
  center: { padding: SPACING.xl, alignItems: 'center' },
  emptyText: {
    color: colors.text.secondaryAccessible,
    padding: SPACING.lg,
    textAlign: 'center',
  },
  apiError: {
    color: colors.danger,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
  },
  card: {
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    gap: SPACING.xs,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  recipeName: { fontSize: 16, fontWeight: '600', color: colors.text.primary, flexShrink: 1 },
  systemBadge: {
    paddingHorizontal: SPACING.xs,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.background.accent,
  },
  systemBadgeText: { fontSize: 11, color: colors.text.secondaryAccessible, fontWeight: '500' },
  description: { color: colors.text.secondaryAccessible, fontSize: 13, lineHeight: 18 },
  summary: { color: colors.text.secondaryAccessible, fontSize: 12, fontStyle: 'italic' },
  // One primary "Use this" per row; the rest are quiet text-links beneath it.
  secondaryActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
    marginTop: SPACING.xs,
  },
  smallButton: {
    minHeight: 44,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  blockButton: { alignSelf: 'stretch', marginTop: SPACING.xs },
  defaultButton: { backgroundColor: colors.background.accent, paddingHorizontal: SPACING.md },
  primaryButton: { backgroundColor: colors.primary, paddingHorizontal: SPACING.md },
  quietButton: { backgroundColor: 'transparent', paddingHorizontal: 0 },
  defaultText: { color: colors.text.primary, fontSize: 13, fontWeight: '500' },
  lightText: { color: colors.text.light, fontSize: 14, fontWeight: '600' },
  quietText: { color: colors.text.secondaryAccessible, fontSize: 13, fontWeight: '500' },
  quietDangerText: { color: colors.danger, fontSize: 13, fontWeight: '500' },
  smallButtonText: {},
  disabled: { opacity: 0.4 },
});

export default RecipePickerModal;
