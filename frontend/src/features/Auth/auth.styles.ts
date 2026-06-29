import { StyleSheet } from 'react-native';

import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

// Cap the form width so fields don't stretch edge-to-edge on laptop/desktop
// browsers; on phones the screen is narrower so it has no effect.
export const FORM_MAX_WIDTH = 480;

/**
 * Shared styles for the auth screens (audit-ux-08). Previously each of the six
 * screens defined its own near-identical container/input/button sheet, so the
 * same rules were copy-pasted and drifted independently; this is the one source.
 */
export const authStyles = StyleSheet.create({
  // Outer SafeAreaView wrapper for the full-screen auth screens.
  safeArea: { flex: 1, backgroundColor: colors.background.card },
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: SPACING.xl,
    backgroundColor: colors.background.card,
  },
  form: {
    width: '100%',
    maxWidth: FORM_MAX_WIDTH,
    alignSelf: 'center',
  },
  title: { fontSize: 28, fontWeight: 'bold', textAlign: 'center', marginBottom: SPACING.lg },
  subtitle: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    marginBottom: SPACING.xl,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    fontSize: 16,
  },
  // Layout-only spacing for the warm `TextField`/`Button` primitives (#801),
  // which own their own ground/border/colour. Keeps field/button rhythm without
  // re-imposing the legacy grey chrome.
  inputSpacing: { marginBottom: SPACING.md },
  buttonSpacing: { marginBottom: SPACING.lg },
  error: { color: colors.danger, marginBottom: SPACING.md, textAlign: 'center' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.buttonV,
    alignItems: 'center',
    marginBottom: SPACING.lg,
  },
  buttonText: { color: colors.text.light, fontSize: 16, fontWeight: '600' },
  link: { textAlign: 'center', color: colors.text.secondary },
  linkBold: { color: colors.primary, fontWeight: '600' },
  forgotLink: {
    textAlign: 'center',
    color: colors.primary,
    fontWeight: '500',
    marginBottom: SPACING.md,
  },
  successTitle: { fontSize: 20, fontWeight: '600', textAlign: 'center', marginBottom: SPACING.md },
  successBody: {
    fontSize: 15,
    color: colors.text.secondary,
    textAlign: 'center',
    marginBottom: SPACING.xl,
  },
});
