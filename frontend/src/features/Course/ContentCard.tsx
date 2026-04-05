import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import type { ContentItem } from '../../api';
import { colors } from '../../design/tokens';

import styles from './Course.styles';

/** Map content_type to a representative icon character. */
const CONTENT_TYPE_ICONS: Record<string, string> = {
  essay: '📖',
  prompt: '💬',
  video: '▶',
};

/** Background color by content type. */
const CONTENT_TYPE_COLORS: Record<string, string> = {
  essay: colors.mystical.glowPurple,
  prompt: colors.tier.clear,
  video: colors.tier.low,
};

const DEFAULT_ICON = '📄';
const DEFAULT_COLOR = colors.background.accent;

/* eslint-disable no-unused-vars */
interface ContentCardProps {
  item: ContentItem;
  onPress: (item: ContentItem) => void;
}
/* eslint-enable no-unused-vars */

const ContentCard = ({ item, onPress }: ContentCardProps): React.JSX.Element => {
  const icon = CONTENT_TYPE_ICONS[item.content_type] ?? DEFAULT_ICON;
  const iconBg = CONTENT_TYPE_COLORS[item.content_type] ?? DEFAULT_COLOR;

  const getSubtitle = (): string => {
    if (item.is_locked) {
      return `Unlocks on day ${item.release_day}`;
    }
    if (item.is_read) {
      return 'Completed';
    }
    return item.content_type.charAt(0).toUpperCase() + item.content_type.slice(1);
  };

  const getStatusIndicator = (): string => {
    if (item.is_locked) return '🔒';
    if (item.is_read) return '✓';
    return '›';
  };

  return (
    <TouchableOpacity
      testID={`content-card-${item.id}`}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${item.title}${item.is_locked ? ', locked' : ''}${item.is_read ? ', read' : ''}`}
      disabled={item.is_locked}
      onPress={() => onPress(item)}
      style={[
        styles.contentCard,
        item.is_locked && styles.contentCardLocked,
        item.is_read && styles.contentCardRead,
      ]}
    >
      <View style={[styles.contentCardIcon, { backgroundColor: iconBg }]}>
        <Text style={styles.contentCardIconText}>{icon}</Text>
      </View>
      <View style={styles.contentCardBody}>
        <Text style={styles.contentCardTitle} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.contentCardSubtitle}>{getSubtitle()}</Text>
      </View>
      <View style={styles.contentCardStatus}>
        <Text style={styles.contentCardStatusText}>{getStatusIndicator()}</Text>
      </View>
    </TouchableOpacity>
  );
};

export default ContentCard;
