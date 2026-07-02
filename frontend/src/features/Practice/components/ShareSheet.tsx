/**
 * `ShareSheet` — bottom-sheet that lets the owner of a practice mint
 * share links and revoke outstanding ones.
 *
 * Owner-only by construction: the parent decides whether to mount the
 * sheet (typically by checking `practice.submitted_by_user_id === currentUserId`
 * or that the row is a preset). When mounted, the sheet:
 *
 * 1. Loads the existing active links via `practiceShare.list`.
 * 2. Offers a Mint form with two optional knobs (`expires_in_days`
 *    and `max_uses`) and a Copy button on the resulting URL.
 * 3. Lets the owner Revoke any active link inline.
 *
 * The deep-link URL is built from the application scheme so a tap on
 * the link in another app routes through `App.tsx`'s linking config to
 * the `SharePreviewScreen`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { practiceShare, type ShareLinkResponse } from '@/api/practiceShare';
import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';
import { parsePositiveInt } from '@/features/Practice/utils/parsePositiveInt';

const DEEP_LINK_PREFIX = 'adepthood://practices/share/';

const LOAD_FAILED_MSG = "We couldn't load your share links. Tap retry below.";
const MINT_FAILED_MSG = "We couldn't create the share link. Check your connection and try again.";
const REVOKE_FAILED_MSG = "We couldn't revoke that link. Try again in a moment.";

export interface ShareSheetProps {
  visible: boolean;
  practiceId: number;
  onClose: () => void;
}

/** Build the public deep-link URL for a token. */
export function buildShareUrl(token: string): string {
  return `${DEEP_LINK_PREFIX}${encodeURIComponent(token)}`;
}

/**
 * Best-effort clipboard write that survives the absence of
 * ``expo-clipboard``. The web bundle hits ``navigator.clipboard``
 * (works on RN web); React Native targets fall through to the rejection
 * branch and the caller renders a "long-press the link to copy"
 * fallback. Pulled into a tiny helper so tests can mock it without
 * touching globals.
 */
interface ClipboardHost {
  clipboard?: { writeText?: (_v: string) => Promise<void> };
}

export async function copyToClipboard(value: string): Promise<boolean> {
  const host: ClipboardHost =
    typeof navigator === 'undefined' ? {} : (navigator as unknown as ClipboardHost);
  const writer = host.clipboard?.writeText;
  if (!writer) return false;
  try {
    await writer.call(host.clipboard, value);
    return true;
  } catch {
    return false;
  }
}

function useMountedRef() {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

interface MintFormState {
  expiresInDays: string;
  maxUses: string;
}

const EMPTY_FORM: MintFormState = { expiresInDays: '', maxUses: '' };

interface SheetState {
  links: ShareLinkResponse[];
  isLoading: boolean;
  loadError: string | null;
  writeError: string | null;
  isMinting: boolean;
  revokingId: number | null;
  form: MintFormState;
  setForm: (_form: MintFormState) => void;
  reload: () => Promise<void>;
  handleMint: () => Promise<void>;
  handleRevoke: (_id: number) => Promise<void>;
}

interface UseSheetStateOptions {
  visible: boolean;
  practiceId: number;
}

interface LoadControl {
  links: ShareLinkResponse[];
  setLinks: React.Dispatch<React.SetStateAction<ShareLinkResponse[]>>;
  isLoading: boolean;
  loadError: string | null;
  reload: () => Promise<void>;
}

function useLoadLinks(
  practiceId: number,
  visible: boolean,
  mountedRef: React.RefObject<boolean>,
): LoadControl {
  const [links, setLinks] = useState<ShareLinkResponse[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const data = await practiceShare.list(practiceId);
      if (mountedRef.current) setLinks(data);
    } catch {
      if (mountedRef.current) setLoadError(LOAD_FAILED_MSG);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [practiceId, mountedRef]);

  useEffect(() => {
    if (!visible) return;
    void reload();
  }, [visible, reload]);

  return { links, setLinks, isLoading, loadError, reload };
}

interface WriteState {
  writeError: string | null;
  setWriteError: React.Dispatch<React.SetStateAction<string | null>>;
}

interface MintControl extends WriteState {
  isMinting: boolean;
  form: MintFormState;
  setForm: (_form: MintFormState) => void;
  handleMint: () => Promise<void>;
}

function useMintControl(
  practiceId: number,
  setLinks: LoadControl['setLinks'],
  mountedRef: React.RefObject<boolean>,
  write: WriteState,
): MintControl {
  const { setWriteError } = write;
  const [isMinting, setIsMinting] = useState(false);
  const [form, setForm] = useState<MintFormState>(EMPTY_FORM);

  const handleMint = useCallback(async () => {
    setIsMinting(true);
    setWriteError(null);
    try {
      const created = await practiceShare.create(practiceId, {
        expires_in_days: parsePositiveInt(form.expiresInDays),
        max_uses: parsePositiveInt(form.maxUses),
      });
      if (!mountedRef.current) return;
      setLinks((prev) => [created, ...prev]);
      setForm(EMPTY_FORM);
    } catch {
      if (mountedRef.current) setWriteError(MINT_FAILED_MSG);
    } finally {
      if (mountedRef.current) setIsMinting(false);
    }
  }, [practiceId, form, mountedRef, setLinks, setWriteError]);

  return { ...write, isMinting, form, setForm, handleMint };
}

interface RevokeControl {
  revokingId: number | null;
  handleRevoke: (_id: number) => Promise<void>;
}

function useRevokeControl(
  setLinks: LoadControl['setLinks'],
  mountedRef: React.RefObject<boolean>,
  setWriteError: WriteState['setWriteError'],
): RevokeControl {
  const [revokingId, setRevokingId] = useState<number | null>(null);

  const markRevoked = useCallback(
    (id: number) => {
      const now = new Date().toISOString();
      const applyRevoked = (link: ShareLinkResponse) =>
        link.id === id ? { ...link, revoked_at: now } : link;
      setLinks((prev) => prev.map(applyRevoked));
    },
    [setLinks],
  );

  const handleRevoke = useCallback(
    async (id: number) => {
      setRevokingId(id);
      setWriteError(null);
      try {
        await practiceShare.revoke(id);
        if (mountedRef.current) markRevoked(id);
      } catch {
        if (mountedRef.current) setWriteError(REVOKE_FAILED_MSG);
      } finally {
        if (mountedRef.current) setRevokingId(null);
      }
    },
    [mountedRef, markRevoked, setWriteError],
  );

  return { revokingId, handleRevoke };
}

function useShareSheetState(opts: UseSheetStateOptions): SheetState {
  const mountedRef = useMountedRef();
  const load = useLoadLinks(opts.practiceId, opts.visible, mountedRef);
  const [writeError, setWriteError] = useState<string | null>(null);
  const write: WriteState = { writeError, setWriteError };
  const mint = useMintControl(opts.practiceId, load.setLinks, mountedRef, write);
  const revoke = useRevokeControl(load.setLinks, mountedRef, setWriteError);
  return { ...load, ...mint, ...revoke };
}

function SheetHeader({ onClose }: { onClose: () => void }) {
  return (
    <View style={styles.headerRow}>
      <Text style={styles.title}>Share this practice</Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        style={styles.closeButton}
        testID="share-sheet-close"
      >
        <Text style={styles.closeButtonText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

interface MintFormProps {
  form: MintFormState;
  onChange: (_form: MintFormState) => void;
  onSubmit: () => void;
  isMinting: boolean;
}

function MintForm({ form, onChange, onSubmit, isMinting }: MintFormProps) {
  return (
    <View style={styles.form}>
      <Text style={styles.formLabel}>Expires in (days)</Text>
      <TextInput
        accessibilityLabel="Expires in days"
        keyboardType="number-pad"
        onChangeText={(text) => onChange({ ...form, expiresInDays: text })}
        placeholder="Leave blank for no expiry"
        style={styles.input}
        testID="share-sheet-expires-input"
        value={form.expiresInDays}
      />
      <Text style={styles.formLabel}>Max uses</Text>
      <TextInput
        accessibilityLabel="Maximum uses"
        keyboardType="number-pad"
        onChangeText={(text) => onChange({ ...form, maxUses: text })}
        placeholder="Leave blank for unlimited"
        style={styles.input}
        testID="share-sheet-max-uses-input"
        value={form.maxUses}
      />
      <TouchableOpacity
        accessibilityRole="button"
        disabled={isMinting}
        onPress={onSubmit}
        style={[styles.mintButton, isMinting && styles.mintButtonDisabled]}
        testID="share-sheet-mint"
      >
        {isMinting ? (
          <ActivityIndicator color={colors.text.light} testID="share-sheet-mint-pending" />
        ) : (
          <Text style={styles.mintButtonText}>Generate link</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

interface LinkRowProps {
  link: ShareLinkResponse;
  revokingId: number | null;
  onRevoke: (_id: number) => void;
  onCopy: (_token: string) => void;
}

function formatStatus(link: ShareLinkResponse): string {
  if (link.revoked_at) return 'Revoked';
  if (link.max_uses !== null && link.use_count >= link.max_uses) return 'Exhausted';
  if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) return 'Expired';
  return 'Active';
}

function LinkRow({ link, revokingId, onRevoke, onCopy }: LinkRowProps) {
  const status = formatStatus(link);
  const isActive = status === 'Active';
  const isRevoking = revokingId === link.id;
  return (
    <View style={styles.row} testID={`share-sheet-row-${link.id}`}>
      <View style={styles.rowText}>
        <Text style={styles.rowUrl} numberOfLines={1} ellipsizeMode="middle">
          {buildShareUrl(link.token)}
        </Text>
        <Text style={styles.rowMeta}>
          {status}
          {link.max_uses !== null
            ? ` • ${link.use_count}/${link.max_uses} uses`
            : ` • ${link.use_count} uses`}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Copy link"
          onPress={() => onCopy(link.token)}
          style={styles.iconButton}
          testID={`share-sheet-copy-${link.id}`}
        >
          <Text style={styles.iconButtonText}>Copy</Text>
        </TouchableOpacity>
        {isActive && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Revoke link"
            disabled={isRevoking}
            onPress={() => onRevoke(link.id)}
            style={[styles.iconButton, styles.revokeButton]}
            testID={`share-sheet-revoke-${link.id}`}
          >
            {isRevoking ? (
              <ActivityIndicator color={colors.destructive.text} />
            ) : (
              <Text style={[styles.iconButtonText, styles.revokeButtonText]}>Revoke</Text>
            )}
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

interface LinkListProps {
  state: SheetState;
  onCopy: (_token: string) => void;
}

function LinkList({ state, onCopy }: LinkListProps) {
  const { links, isLoading, loadError, reload, revokingId, handleRevoke } = state;
  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} testID="share-sheet-loading" />
      </View>
    );
  }
  if (loadError) {
    return (
      <View style={styles.center}>
        <Text style={styles.loadErrorText}>{loadError}</Text>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => {
            void reload();
          }}
          style={styles.retryButton}
          testID="share-sheet-retry"
        >
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (links.length === 0) {
    return (
      <Text style={styles.emptyText} testID="share-sheet-empty">
        No active share links yet.
      </Text>
    );
  }
  return (
    <View testID="share-sheet-list">
      {links.map((link) => (
        <LinkRow
          key={link.id}
          link={link}
          revokingId={revokingId}
          onRevoke={handleRevoke}
          onCopy={onCopy}
        />
      ))}
    </View>
  );
}

interface SheetBodyProps {
  state: SheetState;
  copyMessage: string | null;
  onCopy: (_token: string) => void;
  onClose: () => void;
}

function SheetBody({ state, copyMessage, onCopy, onClose }: SheetBodyProps) {
  return (
    <Pressable accessible={false} onPress={(event) => event.stopPropagation()} style={styles.sheet}>
      <View style={styles.handle} />
      <SheetHeader onClose={onClose} />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <MintForm
          form={state.form}
          onChange={state.setForm}
          onSubmit={() => {
            void state.handleMint();
          }}
          isMinting={state.isMinting}
        />
        {state.writeError && (
          <View style={styles.errorBanner} testID="share-sheet-error">
            <Text style={styles.errorBannerText}>{state.writeError}</Text>
          </View>
        )}
        {copyMessage && (
          <View style={styles.copyBanner} testID="share-sheet-copy-banner">
            <Text style={styles.copyBannerText}>{copyMessage}</Text>
          </View>
        )}
        <View style={styles.divider} />
        <Text style={styles.subTitle}>Your share links</Text>
        <LinkList state={state} onCopy={onCopy} />
      </ScrollView>
    </Pressable>
  );
}

// Auto-dismiss the "copied" banner after a beat so a second copy in
// quick succession doesn't read as a stale toast (PR #359 review).
const COPY_BANNER_TIMEOUT_MS = 3000;

export function ShareSheet({ visible, practiceId, onClose }: ShareSheetProps): React.JSX.Element {
  const state = useShareSheetState({ visible, practiceId });
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const handleCopy = useCallback(async (token: string) => {
    const ok = await copyToClipboard(buildShareUrl(token));
    setCopyMessage(
      ok ? 'Link copied to clipboard.' : 'Could not copy — long-press the link to copy manually.',
    );
  }, []);

  useEffect(() => {
    if (!copyMessage) return undefined;
    const timer = setTimeout(() => setCopyMessage(null), COPY_BANNER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [copyMessage]);

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close share sheet"
        onPress={onClose}
        style={styles.backdrop}
        testID="share-sheet-backdrop"
      >
        <SheetBody state={state} copyMessage={copyMessage} onCopy={handleCopy} onClose={onClose} />
      </Pressable>
    </Modal>
  );
}

export default ShareSheet;

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '90%',
    backgroundColor: colors.background.card,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.xxl,
    ...shadows.large,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: BORDER_RADIUS.circle,
    backgroundColor: colors.border,
    marginBottom: SPACING.sm,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text.primary,
  },
  subTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: SPACING.sm,
  },
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 20,
    color: colors.text.secondary,
  },
  scrollContent: {
    paddingBottom: SPACING.xl,
  },
  form: {
    marginBottom: SPACING.md,
  },
  formLabel: {
    fontSize: 13,
    color: colors.text.secondary,
    marginBottom: SPACING.xs,
  },
  input: {
    backgroundColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    marginBottom: SPACING.md,
    fontSize: 15,
    color: colors.text.primary,
  },
  mintButton: {
    backgroundColor: colors.primary,
    paddingVertical: SPACING.buttonV,
    borderRadius: BORDER_RADIUS.md,
    alignItems: 'center',
  },
  mintButtonDisabled: {
    opacity: 0.5,
  },
  mintButtonText: {
    color: colors.text.light,
    fontWeight: '600',
    fontSize: 15,
  },
  errorBanner: {
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    backgroundColor: colors.destructive.background,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: colors.destructive.border,
  },
  errorBannerText: {
    color: colors.destructive.text,
    fontSize: 14,
  },
  copyBanner: {
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    backgroundColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.md,
  },
  copyBannerText: {
    color: colors.text.primary,
    fontSize: 14,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: SPACING.md,
  },
  center: {
    paddingVertical: SPACING.xxl,
    alignItems: 'center',
  },
  loadErrorText: {
    color: colors.destructive.text,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: SPACING.md,
  },
  retryButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
  },
  retryButtonText: {
    color: colors.text.light,
    fontWeight: '600',
    fontSize: 14,
  },
  emptyText: {
    color: colors.text.secondary,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: SPACING.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    marginBottom: SPACING.sm,
    backgroundColor: colors.background.accent,
  },
  rowText: {
    flex: 1,
    paddingRight: SPACING.sm,
  },
  rowUrl: {
    fontSize: 13,
    color: colors.text.primary,
    fontWeight: '600',
    marginBottom: 2,
  },
  rowMeta: {
    fontSize: 12,
    color: colors.text.secondary,
  },
  rowActions: {
    flexDirection: 'row',
    gap: SPACING.xs,
  },
  iconButton: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.sm,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 60,
    alignItems: 'center',
  },
  iconButtonText: {
    fontSize: 13,
    color: colors.text.primary,
    fontWeight: '600',
  },
  revokeButton: {
    borderColor: colors.destructive.border,
  },
  revokeButtonText: {
    color: colors.destructive.text,
  },
});
