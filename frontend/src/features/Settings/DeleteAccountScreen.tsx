import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { SettingsFeedbackBanner } from './shared/SettingsFeedbackBanner';
import { settingsFormStyles } from './shared/settingsFormLayout';
import type { SettingsFormState } from './shared/useSettingsForm';
import { useSettingsFormState, useSettingsSubmit } from './shared/useSettingsForm';

import { ApiError, users, type AccountDeletionReceipt } from '@/api';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { useAuth } from '@/context/AuthContext';
import { BORDER_RADIUS, SPACING, colors, ink, surface } from '@/design/tokens';

/**
 * "Delete account" — the in-app erasure path App Store Guideline 5.1.1(v)
 * requires of any app that lets people sign up, and the honest end of a
 * journal-first product's promise that the writing is theirs.
 *
 * Two things this screen refuses to do. It does not soften: deletion is
 * immediate, irreversible, and says so before the button is pressable. And it
 * does not overclaim: what survives — the anonymous catalogue contribution,
 * the purchase receipt, a Creek Vault the app cannot reach — is listed beside
 * what goes, because a promise of total erasure that is not quite true is
 * worse than an accurate one.
 */

const IRREVERSIBLE_LEAD =
  'Deleting your account is immediate and irreversible. There is no grace period, ' +
  'and afterwards there is nothing left to restore — not by us, not by support.';

/** What the server's policy erases, in the language of the app rather than of tables. */
const WHAT_GOES = [
  'Every journal entry, including anything you marked Intimate.',
  'Your habits, goals, check-ins and streaks.',
  'Your practices, sessions, recipes and tags.',
  'Your course progress, reflections, margin notes and promoted passages.',
  'Your account, your sign-in methods, and every session on every device.',
];

/** What deliberately survives — stated here rather than discovered later. */
const WHAT_STAYS = [
  'Practices you contributed to the shared catalogue stay in it, no longer linked to you.',
  'Purchase receipts stay, including the address on them, so a licence you paid for still works if you ever come back.',
  'A dated note that a deletion happened — counts only, none of what you wrote.',
];

const CONFIRM_PROMPT = 'Type your email address to confirm';
const EMPTY_CONFIRMATION = 'Enter the email address you sign in with.';
const MISMATCH_MESSAGE =
  'That is not the address on this account. Nothing has been deleted — check it and try again.';
const GENERIC_FAILURE =
  'Could not delete the account. Nothing was removed. Check your connection and try again.';

const HTTP_BAD_REQUEST = 400;

function deleteErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === HTTP_BAD_REQUEST) {
    return MISMATCH_MESSAGE;
  }
  return err instanceof Error && err.message ? err.message : GENERIC_FAILURE;
}

const Bullets = ({ items, testID }: { items: string[]; testID: string }): React.JSX.Element => (
  <View style={styles.list} testID={testID}>
    {items.map((line) => (
      <Text key={line} style={styles.listItem}>
        {`• ${line}`}
      </Text>
    ))}
  </View>
);

interface ConfirmFormProps {
  state: SettingsFormState;
  onChangeDraft: (_value: string) => void;
  onDelete: () => void;
}

const ConfirmForm = ({ state, onChangeDraft, onDelete }: ConfirmFormProps): React.JSX.Element => (
  <>
    <Text style={settingsFormStyles.inputLabel}>{CONFIRM_PROMPT}</Text>
    <TextInput
      style={styles.input}
      placeholder="you@example.com"
      value={state.draft}
      onChangeText={onChangeDraft}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType="email-address"
      testID="delete-account-email-input"
    />
    <SettingsFeedbackBanner idPrefix="delete-account" error={state.error} status={state.status} />
    <TouchableOpacity
      onPress={onDelete}
      style={styles.destructiveButton}
      disabled={state.submitting}
      testID="delete-account-submit"
      accessibilityLabel="Delete my account permanently"
      accessibilityRole="button"
      accessibilityState={{ disabled: state.submitting, busy: state.submitting }}
    >
      <Text style={styles.destructiveButtonText}>
        {state.submitting ? 'Deleting…' : 'Delete my account permanently'}
      </Text>
    </TouchableOpacity>
  </>
);

const Receipt = ({
  receipt,
  onDone,
}: {
  receipt: AccountDeletionReceipt;
  onDone: () => void;
}): React.JSX.Element => (
  <View testID="delete-account-receipt">
    <Text style={settingsFormStyles.title}>Your account is gone</Text>
    <Text style={settingsFormStyles.body}>
      {`We removed ${receipt.rows_erased} records belonging to you. There is nothing left to restore.`}
    </Text>
    <Text style={styles.vaultGuidance} testID="delete-account-vault-guidance">
      {receipt.vault.guidance}
    </Text>
    <TouchableOpacity
      onPress={onDone}
      style={settingsFormStyles.primaryButton}
      testID="delete-account-done"
      accessibilityLabel="Done"
      accessibilityRole="button"
    >
      <Text style={settingsFormStyles.primaryButtonText}>Done</Text>
    </TouchableOpacity>
  </View>
);

function useDeleteHandler(
  form: SettingsFormState,
  onDeleted: (_receipt: AccountDeletionReceipt) => void,
): () => Promise<void> {
  const { draft } = form;
  const validate = useCallback(() => (draft.trim() ? null : EMPTY_CONFIRMATION), [draft]);
  const perform = useCallback(async () => {
    onDeleted(await users.deleteMyAccount({ confirm_email: draft.trim() }));
  }, [draft, onDeleted]);
  return useSettingsSubmit(form, { validate, perform, onError: deleteErrorMessage });
}

export default function DeleteAccountScreen(): React.JSX.Element {
  const { logout } = useAuth();
  const state = useSettingsFormState('');
  const [receipt, setReceipt] = useState<AccountDeletionReceipt | null>(null);
  const handleDelete = useDeleteHandler(state, setReceipt);

  const { setDraft, setError } = state;
  const onChangeDraft = useCallback(
    (value: string) => {
      setDraft(value);
      setError(null);
    },
    [setDraft, setError],
  );
  const onDone = useCallback(() => void logout(), [logout]);

  return (
    <ScreenScaffold scroll testID="delete-account-screen">
      {receipt ? (
        <Receipt receipt={receipt} onDone={onDone} />
      ) : (
        <>
          <Text style={settingsFormStyles.title}>Delete account</Text>
          <Text style={styles.warning} testID="delete-account-warning">
            {IRREVERSIBLE_LEAD}
          </Text>
          <Text style={settingsFormStyles.inputLabel}>What is deleted</Text>
          <Bullets items={WHAT_GOES} testID="delete-account-erased" />
          <Text style={settingsFormStyles.inputLabel}>What stays</Text>
          <Bullets items={WHAT_STAYS} testID="delete-account-retained" />
          <ConfirmForm state={state} onChangeDraft={onChangeDraft} onDelete={handleDelete} />
        </>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  warning: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.destructive.text,
    marginBottom: SPACING.xl,
  },
  list: { marginBottom: SPACING.xl },
  listItem: {
    fontSize: 14,
    lineHeight: 20,
    color: ink.soft,
    marginBottom: SPACING.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    fontSize: 16,
    marginBottom: SPACING.md,
    backgroundColor: surface.raised,
    color: ink.primary,
  },
  destructiveButton: {
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md + 2,
    alignItems: 'center',
    backgroundColor: colors.danger,
    marginTop: SPACING.xs,
  },
  destructiveButtonText: { color: colors.text.light, fontSize: 16, fontWeight: '600' },
  vaultGuidance: {
    fontSize: 14,
    lineHeight: 20,
    color: ink.soft,
    marginBottom: SPACING.xl,
  },
});
