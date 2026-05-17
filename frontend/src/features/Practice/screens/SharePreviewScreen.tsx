/**
 * `SharePreviewScreen` — opened by deep link
 * (`adepthood://practices/share/:token`) when the recipient taps a
 * shared practice URL.
 *
 * Behaviour:
 *
 * 1. Fetch the preview via `practiceShare.preview`. While loading,
 *    show a spinner; on error, show a stable copy and a Retry button.
 * 2. Render the practice name + description + sender display name
 *    + duration with an Import and a Cancel CTA.
 * 3. On Import, call `practiceShare.import`; on success, navigate
 *    back into the Practice tab (the new private draft is the
 *    deep-linked target of the parent navigator).
 *
 * The 410 status (revoked / expired / exhausted) and 400
 * `cannot_import_own_practice` map to in-screen banners so the user
 * never sees a raw error.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { ApiError } from '@/api';
import {
  practiceShare,
  type ShareLinkImportResponse,
  type ShareLinkPreviewResponse,
} from '@/api/practiceShare';
import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';

export type SharePreviewScreenProps = NativeStackScreenProps<RootStackParamList, 'SharePreview'>;

const LOAD_FAILED_MSG = "We couldn't load the shared practice. Tap retry below.";
const IMPORT_FAILED_MSG = "We couldn't import the practice. Try again in a moment.";

interface ErrorBanner {
  kind: 'preview' | 'import';
  detail: string | null;
}

function errorCopyFor(banner: ErrorBanner): string {
  if (banner.detail === 'share_link_revoked') return 'This share link has been revoked.';
  if (banner.detail === 'share_link_expired') return 'This share link has expired.';
  if (banner.detail === 'share_link_exhausted') return 'This share link has reached its use limit.';
  if (banner.detail === 'share_link_not_found') return "We couldn't find that share link.";
  if (banner.detail === 'cannot_import_own_practice') {
    return 'You already own this practice — no need to import.';
  }
  return banner.kind === 'preview' ? LOAD_FAILED_MSG : IMPORT_FAILED_MSG;
}

function classifyApiError(err: unknown): string | null {
  if (err instanceof ApiError) return err.detail;
  return null;
}

interface PreviewState {
  preview: ShareLinkPreviewResponse | null;
  loadError: ErrorBanner | null;
  importError: ErrorBanner | null;
  imported: ShareLinkImportResponse | null;
  isLoading: boolean;
  isImporting: boolean;
}

function initialState(): PreviewState {
  return {
    preview: null,
    loadError: null,
    importError: null,
    imported: null,
    isLoading: true,
    isImporting: false,
  };
}

function useSharePreview(token: string) {
  const [state, setState] = useState<PreviewState>(initialState);

  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, loadError: null }));
    try {
      const preview = await practiceShare.preview(token);
      setState((prev) => ({ ...prev, preview, isLoading: false }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        preview: null,
        isLoading: false,
        loadError: { kind: 'preview', detail: classifyApiError(err) },
      }));
    }
  }, [token]);

  const importPractice = useCallback(async () => {
    setState((prev) => ({ ...prev, isImporting: true, importError: null }));
    try {
      const imported = await practiceShare.import(token);
      setState((prev) => ({ ...prev, imported, isImporting: false }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isImporting: false,
        importError: { kind: 'import', detail: classifyApiError(err) },
      }));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  return { state, load, importPractice };
}

function PreviewHeader({ preview }: { preview: ShareLinkPreviewResponse }) {
  return (
    <View style={styles.headerBlock}>
      <Text style={styles.heading}>{preview.name}</Text>
      {preview.created_by_display_name && (
        <Text style={styles.subHeading} testID="share-preview-sender">
          Shared by {preview.created_by_display_name}
        </Text>
      )}
      <Text style={styles.duration}>
        {preview.default_duration_minutes} min • Stage {preview.stage_number}
      </Text>
    </View>
  );
}

function PreviewBody({ preview }: { preview: ShareLinkPreviewResponse }) {
  return (
    <View style={styles.body}>
      <Text style={styles.bodyLabel}>Description</Text>
      <Text style={styles.bodyText}>{preview.description}</Text>
      <Text style={styles.bodyLabel}>Instructions</Text>
      <Text style={styles.bodyText}>{preview.instructions}</Text>
    </View>
  );
}

interface ImportActionsProps {
  isImporting: boolean;
  onImport: () => void;
  onCancel: () => void;
}

function ImportActions({ isImporting, onImport, onCancel }: ImportActionsProps) {
  return (
    <View style={styles.actions}>
      <TouchableOpacity
        accessibilityRole="button"
        onPress={onCancel}
        style={[styles.actionButton, styles.cancelButton]}
        testID="share-preview-cancel"
      >
        <Text style={styles.cancelButtonText}>Cancel</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        disabled={isImporting}
        onPress={onImport}
        style={[styles.actionButton, styles.importButton, isImporting && styles.disabledButton]}
        testID="share-preview-import"
      >
        {isImporting ? (
          <ActivityIndicator color={colors.text.light} testID="share-preview-importing" />
        ) : (
          <Text style={styles.importButtonText}>Import</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

interface SuccessProps {
  imported: ShareLinkImportResponse;
  onDone: () => void;
}

function SuccessBanner({ imported, onDone }: SuccessProps) {
  return (
    <View style={styles.successBlock} testID="share-preview-success">
      <Text style={styles.successHeading}>Imported.</Text>
      <Text style={styles.successText}>
        {imported.name} is now in your catalog as a private draft.
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        onPress={onDone}
        style={[styles.actionButton, styles.importButton]}
        testID="share-preview-done"
      >
        <Text style={styles.importButtonText}>Open my practice</Text>
      </TouchableOpacity>
    </View>
  );
}

function ErrorView({ banner, onRetry }: { banner: ErrorBanner; onRetry?: () => void }) {
  return (
    <View style={styles.errorBlock} testID={`share-preview-error-${banner.kind}`}>
      <Text style={styles.errorText}>{errorCopyFor(banner)}</Text>
      {onRetry && (
        <TouchableOpacity
          accessibilityRole="button"
          onPress={onRetry}
          style={[styles.actionButton, styles.importButton]}
          testID="share-preview-retry"
        >
          <Text style={styles.importButtonText}>Retry</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

interface LoadedViewProps {
  preview: ShareLinkPreviewResponse;
  imported: ShareLinkImportResponse | null;
  importError: ErrorBanner | null;
  isImporting: boolean;
  onImport: () => void;
  onCancel: () => void;
  onDone: () => void;
}

function LoadedView(props: LoadedViewProps): React.JSX.Element {
  const { preview, imported, importError, isImporting, onImport, onCancel, onDone } = props;
  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="share-preview-screen">
      <PreviewHeader preview={preview} />
      <PreviewBody preview={preview} />
      {imported ? (
        <SuccessBanner imported={imported} onDone={onDone} />
      ) : (
        <>
          {importError && <ErrorView banner={importError} />}
          <ImportActions isImporting={isImporting} onImport={onImport} onCancel={onCancel} />
        </>
      )}
    </ScrollView>
  );
}

function useNavCallbacks(
  navigation: SharePreviewScreenProps['navigation'],
  imported: ShareLinkImportResponse | null,
) {
  const handleCancel = useCallback(() => navigation.goBack(), [navigation]);
  const handleDone = useCallback(() => {
    if (imported) {
      navigation.navigate('Tabs', {
        screen: 'Practice',
        params: { stageNumber: imported.stage_number },
      });
    } else {
      navigation.goBack();
    }
  }, [navigation, imported]);
  return { handleCancel, handleDone };
}

export function SharePreviewScreen({
  route,
  navigation,
}: SharePreviewScreenProps): React.JSX.Element {
  const { state, load, importPractice } = useSharePreview(route.params.token);
  const { handleCancel, handleDone } = useNavCallbacks(navigation, state.imported);

  if (state.isLoading) {
    return (
      <View style={styles.loading} testID="share-preview-loading">
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }
  if (state.loadError) {
    return (
      <ScrollView contentContainerStyle={styles.scroll}>
        <ErrorView
          banner={state.loadError}
          onRetry={state.loadError.detail === null ? load : undefined}
        />
      </ScrollView>
    );
  }
  if (!state.preview) {
    return (
      <View style={styles.loading}>
        <Text style={styles.bodyText}>Nothing to show.</Text>
      </View>
    );
  }
  return (
    <LoadedView
      preview={state.preview}
      imported={state.imported}
      importError={state.importError}
      isImporting={state.isImporting}
      onImport={() => {
        void importPractice();
      }}
      onCancel={handleCancel}
      onDone={handleDone}
    />
  );
}

export default SharePreviewScreen;

const styles = StyleSheet.create({
  scroll: {
    padding: SPACING.lg,
    paddingBottom: SPACING.xxl,
  },
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg,
  },
  headerBlock: {
    marginBottom: SPACING.lg,
  },
  heading: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: SPACING.xs,
  },
  subHeading: {
    fontSize: 14,
    color: colors.text.secondary,
    marginBottom: SPACING.xs,
  },
  duration: {
    fontSize: 13,
    color: colors.text.tertiaryAccessible,
  },
  body: {
    marginBottom: SPACING.lg,
  },
  bodyLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text.secondary,
    marginTop: SPACING.md,
    marginBottom: SPACING.xs,
  },
  bodyText: {
    fontSize: 15,
    color: colors.text.primary,
    lineHeight: 22,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: SPACING.lg,
    gap: SPACING.md,
  },
  actionButton: {
    flex: 1,
    paddingVertical: SPACING.buttonV,
    borderRadius: BORDER_RADIUS.md,
    alignItems: 'center',
  },
  cancelButton: {
    backgroundColor: colors.background.accent,
  },
  cancelButtonText: {
    color: colors.text.primary,
    fontWeight: '600',
    fontSize: 15,
  },
  importButton: {
    backgroundColor: colors.primary,
  },
  importButtonText: {
    color: colors.text.light,
    fontWeight: '600',
    fontSize: 15,
  },
  disabledButton: {
    opacity: 0.5,
  },
  successBlock: {
    marginTop: SPACING.lg,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.background.accent,
  },
  successHeading: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.successText,
    marginBottom: SPACING.sm,
  },
  successText: {
    fontSize: 14,
    color: colors.text.primary,
    marginBottom: SPACING.md,
  },
  errorBlock: {
    padding: SPACING.md,
    marginBottom: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.destructive.background,
    borderWidth: 1,
    borderColor: colors.destructive.border,
  },
  errorText: {
    fontSize: 14,
    color: colors.destructive.text,
    marginBottom: SPACING.sm,
  },
});
