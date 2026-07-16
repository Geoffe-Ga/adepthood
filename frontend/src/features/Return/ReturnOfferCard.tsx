/**
 * ``ReturnOfferCard`` — a quiet paper card that offers the five-week Metta
 * Return as a soft landing. It carries two affordances: accept (begin the arc)
 * and decline (set it aside). The offer is the invitation; declining changes
 * nothing. Presentational + reduced-motion-safe; tokens only.
 */
import React from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  RETURN_OFFER_ACCEPT,
  RETURN_OFFER_ACCEPT_A11Y,
  RETURN_OFFER_BODY,
  RETURN_OFFER_DISMISS,
  RETURN_OFFER_DISMISS_A11Y,
  RETURN_OFFER_HEADING,
} from './returnCopy';

import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  paperShadow,
  spacing,
  touchTarget,
} from '@/design/tokens';
import { usePressScale } from '@/hooks/usePressScale';
import { useReducedMotion } from '@/hooks/useReducedMotion';

export interface ReturnOfferCardProps {
  onAccept: () => void;
  onDismiss: () => void;
}

function ReturnOfferCard({ onAccept, onDismiss }: ReturnOfferCardProps): React.JSX.Element {
  const press = usePressScale(useReducedMotion());
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <View style={styles.card} testID="return-offer-card">
        <Text style={styles.heading}>{RETURN_OFFER_HEADING}</Text>
        <Text style={styles.body}>{RETURN_OFFER_BODY}</Text>
        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.accept}
            onPress={onAccept}
            onPressIn={press.onPressIn}
            onPressOut={press.onPressOut}
            accessibilityRole="button"
            accessibilityLabel={RETURN_OFFER_ACCEPT_A11Y}
            testID="return-offer-accept"
          >
            <Text style={styles.acceptText}>{RETURN_OFFER_ACCEPT}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.dismiss}
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel={RETURN_OFFER_DISMISS_A11Y}
            testID="return-offer-dismiss"
          >
            <Text style={styles.dismissText}>{RETURN_OFFER_DISMISS}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.paper.background,
    borderLeftWidth: 3,
    borderLeftColor: colors.tier.clear,
    ...paperShadow.card,
  },
  heading: {
    ...editorialType.title,
    color: colors.paper.ink,
  },
  body: {
    ...editorialType.marginNote,
    color: colors.paper.ink,
    marginTop: spacing(1),
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing(1.5),
  },
  accept: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.tier.clear,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptText: {
    ...editorialType.action,
    color: colors.paper.background,
  },
  dismiss: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    marginLeft: spacing(1),
    borderRadius: BORDER_RADIUS.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissText: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
});

export default ReturnOfferCard;
