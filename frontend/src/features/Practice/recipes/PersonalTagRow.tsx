/**
 * ``PersonalTagRow`` — one of the caller's own tags inside the recipe tag
 * library, carrying the two affordances a system tag does not get: rename and
 * delete. The backend refuses both on a shared tag (``_require_personal``), so
 * offering them only here keeps the UI honest about what the server will allow.
 *
 * Both actions are staged inside the row rather than in a separate sheet: the
 * library is a dropdown panel, and pushing a second modal over it to rename one
 * word would cost the user their place in the list.
 */
import React, { useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import { DropdownOptionRow, dropdownCreateStyles } from '../components/SearchableDropdown';

import type { PracticeTag } from '@/api';
import { formatApiError } from '@/api/errorMessages';

/** Mirrors the backend ``PracticeTagUpdate.label`` cap. */
const LABEL_MAX = 255;

export interface PersonalTagRowProps {
  /** Shared testID stem for the picker this row belongs to. */
  base: string;
  tag: PracticeTag;
  selected: boolean;
  onSelect: () => void;
  /** Resolves once the new label is persisted; rejects with a shown message. */
  onRename: (label: string) => Promise<void>;
  /** Resolves once the tag is gone; rejects with a shown message. */
  onDelete: () => Promise<void>;
}

type RowMode = 'idle' | 'renaming' | 'confirming-delete';

interface RowController {
  mode: RowMode;
  draftLabel: string;
  error: string | null;
  busy: boolean;
  setDraftLabel: (next: string) => void;
  startRename: () => void;
  startDelete: () => void;
  cancel: () => void;
  confirmRename: () => Promise<void>;
  confirmDelete: () => Promise<void>;
}

function useRowController(props: PersonalTagRowProps): RowController {
  const [mode, setMode] = useState<RowMode>('idle');
  const [draftLabel, setDraftLabel] = useState(props.tag.label);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>, fallback: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMode('idle');
    } catch (err: unknown) {
      // Through the translator, not the wire: a rejected rename is a sentence
      // the person can act on ("that name is taken"), never the status line and
      // contract code the client builds its `Error` message from.
      setError(formatApiError(err, { fallback }));
    } finally {
      setBusy(false);
    }
  };

  return {
    mode,
    draftLabel,
    error,
    busy,
    setDraftLabel,
    startRename: () => {
      setDraftLabel(props.tag.label);
      setError(null);
      setMode('renaming');
    },
    startDelete: () => {
      setError(null);
      setMode('confirming-delete');
    },
    cancel: () => {
      setError(null);
      setMode('idle');
    },
    confirmRename: async () => {
      const trimmed = draftLabel.trim();
      // A blank label is not a rename; the server would 422 and the user would
      // lose the row's state to learn nothing.
      if (trimmed.length === 0 || busy) return;
      await run(() => props.onRename(trimmed), 'Could not rename that tag.');
    },
    confirmDelete: async () => {
      if (busy) return;
      await run(props.onDelete, 'Could not delete that tag.');
    },
  };
}

const PersonalTagRow = (props: PersonalTagRowProps): React.JSX.Element => {
  const row = useRowController(props);
  const slug = props.tag.slug;
  return (
    <View testID={`${props.base}-manage-${slug}`}>
      <DropdownOptionRow
        label={props.tag.label}
        onPress={props.onSelect}
        selected={props.selected}
        testID={`${props.base}-option-${slug}`}
        accessibilityLabel={props.tag.label}
      />
      <RowBody base={props.base} tag={props.tag} row={row} />
      {row.error !== null && (
        <Text style={dropdownCreateStyles.error} testID={`${props.base}-manage-error-${slug}`}>
          {row.error}
        </Text>
      )}
    </View>
  );
};

interface RowBodyProps {
  base: string;
  tag: PracticeTag;
  row: RowController;
}

/** The row's staged action area: the two triggers, a rename form, or a confirm. */
const RowBody = ({ base, tag, row }: RowBodyProps): React.JSX.Element => {
  if (row.mode === 'renaming') {
    return <RenameForm base={base} slug={tag.slug} row={row} />;
  }
  if (row.mode === 'confirming-delete') {
    return <DeleteConfirm base={base} tag={tag} row={row} />;
  }
  return <IdleActions base={base} tag={tag} row={row} />;
};

/** Text-only actions so the row reads as a tag first and a control second. */
const IdleActions = ({ base, tag, row }: RowBodyProps): React.JSX.Element => (
  <View style={dropdownCreateStyles.controls}>
    <ActionButton
      testID={`${base}-rename-${tag.slug}`}
      accessibilityLabel={`Rename the tag ${tag.label}`}
      label="Rename"
      onPress={row.startRename}
    />
    <ActionButton
      testID={`${base}-delete-${tag.slug}`}
      accessibilityLabel={`Delete the tag ${tag.label}`}
      label="Delete"
      onPress={row.startDelete}
    />
  </View>
);

interface RenameFormProps {
  base: string;
  slug: string;
  row: RowController;
}

const RenameForm = ({ base, slug, row }: RenameFormProps): React.JSX.Element => (
  <View style={dropdownCreateStyles.section}>
    <TextInput
      value={row.draftLabel}
      onChangeText={row.setDraftLabel}
      style={dropdownCreateStyles.input}
      placeholder="Tag label (what you see)"
      maxLength={LABEL_MAX}
      accessibilityLabel="New tag label"
      testID={`${base}-rename-input-${slug}`}
    />
    <View style={dropdownCreateStyles.controls}>
      <ActionButton
        testID={`${base}-rename-cancel-${slug}`}
        accessibilityLabel="Cancel rename"
        label="Cancel"
        onPress={row.cancel}
        muted
      />
      <ActionButton
        testID={`${base}-rename-confirm-${slug}`}
        accessibilityLabel="Save the new tag label"
        label="Save"
        onPress={row.confirmRename}
        disabled={row.draftLabel.trim().length === 0 || row.busy}
      />
    </View>
  </View>
);

interface DeleteConfirmProps {
  base: string;
  tag: PracticeTag;
  row: RowController;
}

/** Deleting a tag is not recoverable, so it is asked for twice.  Recipes that
 *  already use it keep working — a recipe step stores the slug by value. */
const DeleteConfirm = ({ base, tag, row }: DeleteConfirmProps): React.JSX.Element => (
  <View style={dropdownCreateStyles.section} testID={`${base}-delete-prompt-${tag.slug}`}>
    <Text style={dropdownCreateStyles.controlsLabel}>
      Delete “{tag.label}”? Recipes already using it keep their step.
    </Text>
    <View style={dropdownCreateStyles.controls}>
      <ActionButton
        testID={`${base}-delete-cancel-${tag.slug}`}
        accessibilityLabel="Keep this tag"
        label="Keep"
        onPress={row.cancel}
        muted
      />
      <ActionButton
        testID={`${base}-delete-confirm-${tag.slug}`}
        accessibilityLabel={`Delete the tag ${tag.label} for good`}
        label="Delete"
        onPress={row.confirmDelete}
        disabled={row.busy}
      />
    </View>
  </View>
);

interface ActionButtonProps {
  testID: string;
  accessibilityLabel: string;
  label: string;
  onPress: () => void | Promise<void>;
  disabled?: boolean;
  muted?: boolean;
}

const ActionButton = ({
  testID,
  accessibilityLabel,
  label,
  onPress,
  disabled = false,
  muted = false,
}: ActionButtonProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel}
    accessibilityState={{ disabled }}
    onPress={() => void onPress()}
    disabled={disabled}
    style={[dropdownCreateStyles.row, disabled && dropdownCreateStyles.disabled]}
    testID={testID}
  >
    <Text style={muted ? dropdownCreateStyles.controlsLabel : dropdownCreateStyles.rowText}>
      {label}
    </Text>
  </TouchableOpacity>
);

export default PersonalTagRow;
