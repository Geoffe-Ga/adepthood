import { StyleSheet } from 'react-native';

import { colors, radius, SPACING } from '../../design/tokens';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },

  // Message list
  messageList: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
  },

  // Message bubble shared
  bubbleRow: {
    flexDirection: 'row',
    marginBottom: SPACING.sm,
    maxWidth: '85%',
  },
  bubbleRowUser: {
    alignSelf: 'flex-end',
  },
  bubbleRowBot: {
    alignSelf: 'flex-start',
  },
  bubble: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: radius.lg,
  },
  bubbleUser: {
    backgroundColor: colors.secondary,
    borderBottomRightRadius: radius.sm,
  },
  bubbleBot: {
    backgroundColor: colors.background.card,
    borderBottomLeftRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 21,
  },
  bubbleTextUser: {
    color: colors.text.light,
  },
  bubbleTextBot: {
    color: colors.text.primary,
  },
  timestamp: {
    fontSize: 11,
    marginTop: 4,
  },
  timestampUser: {
    color: colors.mystical.transparentLight,
    textAlign: 'right',
  },
  timestampBot: {
    color: colors.text.tertiary,
  },

  // Tags
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 4,
    gap: 4,
  },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.mystical.glowPurple,
  },
  tagText: {
    fontSize: 10,
    color: colors.text.secondary,
  },

  // Bot avatar
  botAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.mystical.glowPurple,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.sm,
    marginTop: 2,
  },
  botAvatarText: {
    fontSize: 14,
  },

  // Chat input
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background.card,
  },
  textInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background.primary,
    fontSize: 15,
    color: colors.text.primary,
  },
  sendButton: {
    marginLeft: SPACING.sm,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  sendButtonText: {
    color: colors.text.light,
    fontSize: 18,
    fontWeight: '600',
  },

  // Weekly prompt banner
  promptBanner: {
    marginHorizontal: SPACING.md,
    marginTop: SPACING.sm,
    padding: SPACING.md,
    borderRadius: radius.md,
    backgroundColor: colors.mystical.glowPurple,
    borderWidth: 1,
    borderColor: colors.border,
  },
  promptLabel: {
    fontSize: 11,
    color: colors.text.secondary,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  promptQuestion: {
    fontSize: 14,
    color: colors.text.primary,
    lineHeight: 20,
  },
  promptRespondButton: {
    marginTop: SPACING.sm,
    paddingVertical: 6,
    paddingHorizontal: SPACING.md,
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
    alignSelf: 'flex-start',
  },
  promptRespondText: {
    fontSize: 13,
    color: colors.text.light,
    fontWeight: '600',
  },

  // Balance banner (zero offerings)
  balanceBanner: {
    marginHorizontal: SPACING.md,
    marginTop: SPACING.sm,
    padding: SPACING.sm,
    borderRadius: radius.md,
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  balanceBannerText: {
    fontSize: 13,
    color: colors.text.secondary,
    textAlign: 'center',
  },

  // Balance counter (offerings remaining)
  balanceCounter: {
    alignSelf: 'flex-end',
    marginRight: SPACING.md,
    marginTop: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.mystical.glowPurple,
  },
  balanceCounterText: {
    fontSize: 11,
    color: colors.text.secondary,
    fontWeight: '600',
  },

  // Typing indicator
  typingIndicator: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  typingIndicatorText: {
    fontSize: 13,
    color: colors.text.tertiary,
    fontStyle: 'italic',
  },

  // Empty state
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: SPACING.md,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 20,
  },

  // Loading
  loadingMore: {
    paddingVertical: SPACING.md,
    alignItems: 'center',
  },
});

export default styles;
