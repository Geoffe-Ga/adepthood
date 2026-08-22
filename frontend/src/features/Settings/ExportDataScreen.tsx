import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { saveDataExport, type ExportFormat, type SavedExport } from './saveDataExport';
import { SettingsFeedbackBanner } from './shared/SettingsFeedbackBanner';
import { settingsFormStyles } from './shared/settingsFormLayout';

import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { BORDER_RADIUS, SPACING, accent, colors, ink, surface } from '@/design/tokens';

/**
 * "Export my data" — the counterpart to Delete account, and the reason
 * deleting is a reasonable thing to offer rather than a dead end.
 *
 * Two files, because they answer two different questions. The JSON archive is
 * everything, in a form that can be read back in. The Markdown journal is the
 * one you open and read. Neither is a request queued for later: the app asks,
 * saves the file, and hands it to the share sheet while you are standing there.
 *
 * The screen says plainly what the archive leaves out. An export that silently
 * omits a third of the schema and calls itself "all your data" would be a
 * worse promise than one that names the gaps.
 */

const LEAD =
  'Everything you have written, on your device, in a file you keep. Nothing is ' +
  'queued and nothing is emailed — the download starts when you press the button.';

/** What the archive deliberately does not carry, in the app's own words. */
const NOT_INCLUDED = [
  'Your password, sign-in links, and the key to a Creek Vault you connected — a working credential does not belong in a file on a laptop.',
  'Records the app kept about your usage: sign-in attempts, AI metering, wallet accounting.',
  'The shared course, which is not yours to take. Practices you contributed are yours, and are included.',
];

const PLAINTEXT_CAUTION =
  'Your entries are stored encrypted; the export decrypts them. The file is ' +
  'readable by anyone who opens it, so keep it somewhere you would be willing ' +
  'to keep a paper journal.';

const GENERIC_FAILURE =
  'Could not build the export. Nothing was saved. Check your connection and try again.';

function failureMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : GENERIC_FAILURE;
}

function receiptLine(saved: SavedExport): string {
  const what = saved.records === null ? 'your journal' : `${saved.records} records`;
  return `Saved ${what} to ${saved.filename}.`;
}

function followUpLine(saved: SavedExport): string {
  return saved.shared
    ? 'It is on its way to wherever you sent it.'
    : 'It is on this device. Open it again from Files to move it somewhere safe.';
}

interface ExportButtonProps {
  label: string;
  description: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}

const ExportButton = ({
  label,
  description,
  busy,
  disabled,
  onPress,
  testID,
}: ExportButtonProps): React.JSX.Element => (
  <View style={styles.option}>
    <TouchableOpacity
      onPress={onPress}
      style={styles.optionButton}
      disabled={disabled}
      testID={testID}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
    >
      <Text style={styles.optionButtonText}>{busy ? 'Preparing…' : label}</Text>
    </TouchableOpacity>
    <Text style={styles.optionDescription}>{description}</Text>
  </View>
);

const Caveats = (): React.JSX.Element => (
  <View testID="export-data-not-included">
    <Text style={settingsFormStyles.inputLabel}>What it leaves out</Text>
    {NOT_INCLUDED.map((line) => (
      <Text key={line} style={styles.listItem}>
        {`• ${line}`}
      </Text>
    ))}
  </View>
);

interface ExportState {
  running: ExportFormat | null;
  error: string | null;
  saved: SavedExport | null;
}

const IDLE: ExportState = { running: null, error: null, saved: null };

/** Run one export, holding the screen's whole state machine in one place. */
function useExportRunner(): [ExportState, (_format: ExportFormat) => Promise<void>] {
  const [state, setState] = useState<ExportState>(IDLE);
  const run = useCallback(async (format: ExportFormat) => {
    setState({ running: format, error: null, saved: null });
    try {
      const saved = await saveDataExport(format);
      setState({ running: null, error: null, saved });
    } catch (err) {
      setState({ running: null, error: failureMessage(err), saved: null });
    }
  }, []);
  return [state, run];
}

export default function ExportDataScreen(): React.JSX.Element {
  const [state, run] = useExportRunner();
  const exportJson = useCallback(() => void run('json'), [run]);
  const exportMarkdown = useCallback(() => void run('markdown'), [run]);
  const busy = state.running !== null;

  return (
    <ScreenScaffold scroll testID="export-data-screen">
      <Text style={settingsFormStyles.title}>Export my data</Text>
      <Text style={settingsFormStyles.body} testID="export-data-lead">
        {LEAD}
      </Text>
      <ExportButton
        label="Everything (JSON)"
        description="Every entry, habit, goal, practice, reflection and corpus fragment, in a format that can be read back in."
        busy={state.running === 'json'}
        disabled={busy}
        onPress={exportJson}
        testID="export-data-json"
      />
      <ExportButton
        label="My journal (Markdown)"
        description="The journal alone, oldest first, as readable text. Entries you deleted are not in it."
        busy={state.running === 'markdown'}
        disabled={busy}
        onPress={exportMarkdown}
        testID="export-data-markdown"
      />
      <SettingsFeedbackBanner idPrefix="export-data" error={state.error} status={null} />
      {state.saved ? (
        <View testID="export-data-receipt">
          <Text style={styles.receipt} testID="export-data-receipt-saved">
            {receiptLine(state.saved)}
          </Text>
          <Text style={styles.receiptFollowUp} testID="export-data-receipt-next">
            {followUpLine(state.saved)}
          </Text>
        </View>
      ) : null}
      <Text style={styles.caution} testID="export-data-caution">
        {PLAINTEXT_CAUTION}
      </Text>
      <Caveats />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  option: { marginBottom: SPACING.xl },
  optionButton: {
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md + 2,
    alignItems: 'center',
    backgroundColor: accent.primary,
  },
  optionButtonText: { color: colors.text.light, fontSize: 16, fontWeight: '600' },
  optionDescription: {
    fontSize: 13,
    lineHeight: 18,
    color: ink.soft,
    marginTop: SPACING.sm,
  },
  receipt: { fontSize: 15, fontWeight: '600', color: ink.primary, marginBottom: SPACING.xs },
  receiptFollowUp: { fontSize: 14, lineHeight: 20, color: ink.soft, marginBottom: SPACING.xl },
  caution: {
    fontSize: 14,
    lineHeight: 20,
    color: ink.soft,
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.xl,
  },
  listItem: { fontSize: 14, lineHeight: 20, color: ink.soft, marginBottom: SPACING.xs },
});
